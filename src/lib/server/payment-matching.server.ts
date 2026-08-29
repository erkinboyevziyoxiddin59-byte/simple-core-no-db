/**
 * Safe matching of parsed HUMO bank transactions to a pending order.
 *
 * Rules (all server-side, nothing from the client is trusted):
 *  - the order is loaded from the database and must belong to the caller
 *  - the receiving card comes from app_settings.payment
 *  - the amount must match EXACTLY (no tolerance, no range)
 *  - a bank transaction can only ever be claimed by one order
 *  - completion goes through the existing idempotent complete_order() RPC
 */
import { db, getSetting, DEFAULT_PAYMENT, AppError, type PaymentSettings } from "./core.server";

export type VerifyOutcome =
  | { status: "verified"; already: false; orderStatus: string }
  | { status: "verified"; already: true; orderStatus: string }
  | { status: "not_found" }
  | { status: "expired" };

export function last4Of(cardNumber: string): string | null {
  const digits = (cardNumber ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * Looks for a confident incoming transaction for this order and, when found,
 * records the payment and completes the order. Never completes anything without
 * an exact, unclaimed, incoming transaction on the configured card.
 */
export async function verifyOrderPayment(orderId: string, userId: string): Promise<VerifyOutcome> {
  // Existing expiry rules stay authoritative.
  await db.rpc("expire_stale_orders");

  const { data: order } = await db
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .eq("user_id", userId) // ownership enforced server-side
    .maybeSingle();
  if (!order) throw new AppError("order_not_found");

  if (order.status === "completed") {
    return { status: "verified", already: true, orderStatus: order.status };
  }
  if (order.status === "cancelled" || order.status === "expired") {
    return { status: "expired" };
  }
  if (order.status !== "awaiting_payment" && order.status !== "processing") {
    return { status: "not_found" };
  }

  const payment = await getSetting<PaymentSettings>("payment", DEFAULT_PAYMENT);
  const cardLast4 = last4Of(payment.cardNumber);
  if (!cardLast4) return { status: "not_found" };

  // Full-timestamp payment window: the bank timestamp must fall between the
  // order's creation and its expiry. Fail closed when it cannot be compared.
  const windowStart = Date.parse(order.created_at);
  const windowEnd = Date.parse(order.expires_at);
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd <= windowStart) {
    return { status: "not_found" };
  }

  const { data: candidates } = await db
    .from("bank_transactions")
    .select("id, bank_time_at")
    .eq("direction", "in")
    .eq("currency", "UZS")
    .eq("parse_status", "parsed")
    .eq("card_last4", cardLast4)
    .eq("amount_uzs", order.amount_uzs)
    .is("matched_order_id", null)
    .not("bank_time_at", "is", null)
    .gte("bank_time_at", order.created_at)
    .lte("bank_time_at", order.expires_at)
    .order("bank_time_at", { ascending: true })
    .limit(10);

  let claimedTxId: string | null = null;
  for (const candidate of candidates ?? []) {
    // Re-verify the complete timestamp in application code (fail closed).
    const bankMs = candidate.bank_time_at ? Date.parse(candidate.bank_time_at) : NaN;
    if (!Number.isFinite(bankMs) || bankMs < windowStart || bankMs > windowEnd) continue;
    // Atomic claim: the row is only updated while matched_order_id is still null.
    const { data: claimed } = await db
      .from("bank_transactions")
      .update({ matched_order_id: order.id })
      .eq("id", candidate.id)
      .is("matched_order_id", null)
      .select("id")
      .maybeSingle();
    if (claimed) {
      claimedTxId = claimed.id;
      break;
    }
  }

  if (!claimedTxId) return { status: "not_found" };

  const now = new Date().toISOString();
  const { data: existingPayment } = await db
    .from("payments")
    .select("id, status")
    .eq("order_id", order.id)
    .neq("status", "rejected")
    .maybeSingle();

  if (existingPayment) {
    if (existingPayment.status !== "verified") {
      await db
        .from("payments")
        .update({ status: "verified", verified_at: now, submitted_at: now })
        .eq("id", existingPayment.id);
    }
  } else {
    const { error } = await db.from("payments").insert({
      order_id: order.id,
      user_id: userId,
      declared_amount_uzs: order.amount_uzs,
      status: "verified",
      submitted_at: now,
      verified_at: now,
      payer_note: `HUMO auto-verified · tx ${claimedTxId}`,
    });
    // A concurrent insert already created the open payment row — not an error.
    if (error && error.code !== "23505") throw new AppError("payment_record_failed");
  }

  // Existing idempotent completion flow (loyalty / referral behaviour unchanged).
  const { data: completed, error: completeError } = await db.rpc("complete_order", {
    _order_id: order.id,
  });
  if (completeError) throw new AppError("order_complete_failed");

  const orderStatus =
    (completed as { status?: string } | null)?.status ?? "completed";
  return { status: "verified", already: false, orderStatus };
}
