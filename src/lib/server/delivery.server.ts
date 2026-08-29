/**
 * Real Telegram Stars / Premium delivery orchestration.
 *
 * Guarantees:
 *  - Fragment is only ever called for an order that is `completed` AND has a
 *    `verified` payment row (the existing HUMO verification decides that).
 *  - Exactly one delivery row per order (unique order_id) and only the process
 *    that flips it pending -> processing may call Fragment: no double purchase.
 *  - Recipient username, amount and duration always come from the order row.
 *  - Nothing about the wallet seed is stored, returned or logged.
 */
import { db } from "./core.server";
import {
  buyPremium,
  buyStars,
  checkPremiumEligibility,
  getQueueStatus,
  InvalidSeedError,
  MissingSeedError,
} from "./fragment.server";

export type DeliveryState = "pending" | "processing" | "success" | "failed";

export interface DeliveryView {
  status: DeliveryState | "none";
  reason: string | null;
}

type OrderRow = {
  id: string;
  user_id: string;
  status: string;
  product_type: string;
  quantity: number;
  recipient_username: string;
};

type DeliveryRow = {
  id: string;
  order_id: string;
  status: DeliveryState;
  provider_request_id: string | null;
  attempt_count: number;
  failure_code: string | null;
  last_error: string | null;
};

const PREMIUM_MONTHS: Record<string, number> = {
  premium_3: 3,
  premium_6: 6,
  premium_12: 12,
};

export function productKindOf(productType: string): "stars" | "premium" | null {
  if (productType === "stars") return "stars";
  if (productType in PREMIUM_MONTHS) return "premium";
  return null;
}

export function premiumMonthsOf(productType: string, quantity: number): number {
  return PREMIUM_MONTHS[productType] ?? quantity;
}

function view(row: Pick<DeliveryRow, "status" | "failure_code"> | null): DeliveryView {
  if (!row) return { status: "none", reason: null };
  return { status: row.status, reason: row.failure_code };
}

async function finish(
  deliveryId: string,
  patch: {
    status: DeliveryState;
    failure_code?: string | null;
    last_error?: string | null;
    provider_request_id?: string | null;
  },
): Promise<DeliveryView> {
  const isFinal = patch.status === "success" || patch.status === "failed";
  const update = {
    status: patch.status,
    failure_code: patch.failure_code ?? null,
    last_error: patch.last_error ?? null,
    ...(patch.provider_request_id !== undefined
      ? { provider_request_id: patch.provider_request_id }
      : {}),
    ...(isFinal ? { completed_at: new Date().toISOString() } : {}),
  };

  // Conditional write: only a row that is still non-final may be finalised.
  // The row returned here proves *this* call performed the transition, which
  // is what makes the channel notification below fire exactly once per order.
  const { data: changed } = await db
    .from("deliveries")
    .update(update)
    .eq("id", deliveryId)
    .in("status", ["pending", "processing"])
    .select("order_id")
    .maybeSingle();

  if (isFinal && changed?.order_id) {
    try {
      const { notifyOrderOutcome } = await import("./order-notify.server");
      await notifyOrderOutcome(
        changed.order_id as string,
        patch.status === "success" ? "completed" : "failed",
        patch.failure_code ?? null,
      );
    } catch (error) {
      // Notifications must never affect order or delivery state.
      console.error(
        "[delivery] notify_failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return { status: patch.status, reason: patch.failure_code ?? null };
}


/** Reads the current delivery state for an order (no side effects). */
export async function readDelivery(orderId: string): Promise<DeliveryView> {
  const { data } = await db
    .from("deliveries")
    .select("status, failure_code")
    .eq("order_id", orderId)
    .maybeSingle();
  return view((data as { status: DeliveryState; failure_code: string | null } | null) ?? null);
}

/**
 * Starts or resumes delivery for an order. Safe to call repeatedly and
 * concurrently — at most one Fragment purchase can ever happen per order.
 */
export async function runDelivery(orderId: string): Promise<DeliveryView> {
  const { data: orderData } = await db
    .from("orders")
    .select("id, user_id, status, product_type, quantity, recipient_username")
    .eq("id", orderId)
    .maybeSingle();
  const order = orderData as OrderRow | null;
  if (!order) return { status: "none", reason: null };

  // Delivery is only ever attempted for a genuinely paid, completed order.
  if (order.status !== "completed") return readDelivery(orderId);

  const { data: paid } = await db
    .from("payments")
    .select("id")
    .eq("order_id", order.id)
    .eq("status", "verified")
    .limit(1)
    .maybeSingle();
  if (!paid) return readDelivery(orderId);

  const kind = productKindOf(order.product_type);
  if (!kind) return { status: "none", reason: null };

  // Claim (or find) the single delivery row for this order.
  await db
    .from("deliveries")
    .insert({ order_id: order.id, product_kind: kind, status: "pending" })
    .select("id")
    .maybeSingle();

  const { data: current } = await db
    .from("deliveries")
    .select("id, order_id, status, provider_request_id, attempt_count, failure_code, last_error")
    .eq("order_id", order.id)
    .maybeSingle();
  const delivery = current as DeliveryRow | null;
  if (!delivery) return { status: "none", reason: null };

  if (delivery.status === "success" || delivery.status === "failed") return view(delivery);

  if (delivery.status === "processing") {
    if (delivery.provider_request_id) {
      return pollQueue(delivery.id, delivery.provider_request_id);
    }

    // Processing without a provider reference = an earlier attempt whose outcome
    // is unknown. Never re-purchase; hand it to manual review instead.
    return finish(delivery.id, {
      status: "failed",
      failure_code: "needs_review",
      last_error: "Previous attempt result unknown; manual review required.",
    });
  }

  // Atomic claim: only the winner of this update may talk to Fragment.
  const { data: claimed } = await db
    .from("deliveries")
    .update({
      status: "processing",
      started_at: new Date().toISOString(),
      attempt_count: delivery.attempt_count + 1,
    })
    .eq("id", delivery.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (!claimed) return readDelivery(orderId);

  try {
    return kind === "stars"
      ? await deliverStars(delivery.id, order)
      : await deliverPremium(delivery.id, order);
  } catch (error) {
    if (error instanceof MissingSeedError || error instanceof InvalidSeedError) {
      return finish(delivery.id, {
        status: "failed",
        failure_code: "not_configured",
        last_error: "Delivery wallet is not configured.",
      });
    }
    return finish(delivery.id, {
      status: "failed",
      failure_code: "needs_review",
      last_error: "Unexpected delivery error.",
    });
  }
}

async function deliverStars(deliveryId: string, order: OrderRow): Promise<DeliveryView> {
  const result = await buyStars({ username: order.recipient_username, amount: order.quantity });

  if (!result.ok) {
    if (result.kind === "unknown") {
      // Outcome uncertain — keep it processing and never buy again automatically.
      await db.from("deliveries").update({
        last_error: result.message,
        failure_code: null,
      }).eq("id", deliveryId);
      return { status: "processing", reason: null };
    }
    return finish(deliveryId, {
      status: "failed",
      failure_code: classify(result.message, result.code),
      last_error: result.message,
    });
  }

  const requestId = result.data.requestId;
  if (!requestId) {
    return finish(deliveryId, {
      status: "failed",
      failure_code: "needs_review",
      last_error: "Provider did not return a request reference.",
    });
  }

  // Persist the reference immediately so a retry can only ever poll, never buy.
  await db.from("deliveries").update({ provider_request_id: requestId }).eq("id", deliveryId);
  return pollQueue(deliveryId, requestId);
}

async function pollQueue(deliveryId: string, requestId: string): Promise<DeliveryView> {
  const status = await getQueueStatus(requestId);
  if (!status.ok) {
    if (status.kind === "unknown") return { status: "processing", reason: null };
    return finish(deliveryId, {
      status: "failed",
      failure_code: classify(status.message, status.code),
      last_error: status.message,
    });
  }
  if (status.data.state === "success") return finish(deliveryId, { status: "success" });
  if (status.data.state === "failed") {
    return finish(deliveryId, {
      status: "failed",
      failure_code: classify(status.data.message ?? ""),
      last_error: status.data.message,
    });
  }
  return { status: "processing", reason: null };
}

async function deliverPremium(deliveryId: string, order: OrderRow): Promise<DeliveryView> {
  const months = premiumMonthsOf(order.product_type, order.quantity);
  const eligibility = await checkPremiumEligibility({ username: order.recipient_username });

  if (!eligibility.ok) {
    if (eligibility.kind === "unknown") {
      // No purchase has been made yet, so it is safe to retry later.
      await db.from("deliveries").update({ status: "pending", last_error: eligibility.message }).eq("id", deliveryId);
      return { status: "pending", reason: null };
    }
    return finish(deliveryId, {
      status: "failed",
      failure_code: classify(eligibility.message, eligibility.code),
      last_error: eligibility.message,
    });
  }

  if (eligibility.data.alreadyPremium) {
    return finish(deliveryId, {
      status: "failed",
      failure_code: "already_premium",
      last_error: eligibility.data.reason,
    });
  }
  if (!eligibility.data.eligible) {
    return finish(deliveryId, {
      status: "failed",
      failure_code: classify(eligibility.data.reason ?? "") || "not_eligible",
      last_error: eligibility.data.reason,
    });
  }

  const bought = await buyPremium({ username: order.recipient_username, months });
  if (!bought.ok) {
    if (bought.kind === "unknown") {
      await db.from("deliveries").update({ last_error: bought.message }).eq("id", deliveryId);
      return { status: "processing", reason: null };
    }
    return finish(deliveryId, {
      status: "failed",
      failure_code: classify(bought.message, bought.code),
      last_error: bought.message,
    });
  }

  if (!bought.data.success) {
    return finish(deliveryId, {
      status: "failed",
      failure_code: classify(bought.data.message ?? ""),
      last_error: bought.data.message,
    });
  }

  // Premium purchases are queued too — persist the reference and poll it.
  if (bought.data.requestId) {
    await db
      .from("deliveries")
      .update({ provider_request_id: bought.data.requestId })
      .eq("id", deliveryId);
    return pollQueue(deliveryId, bought.data.requestId);
  }
  return finish(deliveryId, { status: "success" });
}


/** Maps a provider message to a short, safe reason code shown to the user. */
export function classify(message: string, providerCode?: string): string {
  const m = (message ?? "").toLowerCase();
  const code = (providerCode ?? "").toUpperCase();
  if (["INVALID_SEED", "INVALID_WALLET_SEED", "WALLET_ADDRESS_MISMATCH", "ACCOUNT_INDEX_NOT_FOUND", "INVALID_WALLET_RESOLUTION"].includes(code)) return "not_configured";
  if (/username|recipient|not found|no such user|invalid user/.test(m)) return "invalid_username";
  if (/already.*(premium|subscri)/.test(m)) return "already_premium";
  if (/balance|insufficient|not enough|funds/.test(m)) return "insufficient_funds";
  if (/eligib/.test(m)) return "not_eligible";
  return "provider_error";
}

/** Cron helper: advances deliveries that are still in flight. */
export async function advanceStuckDeliveries(limit = 25): Promise<{ advanced: number }> {
  const { data } = await db
    .from("deliveries")
    .select("order_id")
    .in("status", ["pending", "processing"])
    .order("updated_at", { ascending: true })
    .limit(limit);

  let advanced = 0;
  for (const row of (data ?? []) as { order_id: string }[]) {
    await runDelivery(row.order_id);
    advanced += 1;
  }
  return { advanced };
}
