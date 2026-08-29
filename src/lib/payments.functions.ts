import { createServerFn } from "@tanstack/react-start";

export interface ApiPaymentInfo {
  cardNumber: string;
  cardHolder: string;
  orderExpireMinutes: number;
}

/** Public payment instructions (card details shown on the payment screen). */
export const getPaymentInfo = createServerFn({ method: "GET" }).handler(async (): Promise<ApiPaymentInfo> => {
  const core = await import("./server/core.server");
  return core.getSetting("payment", core.DEFAULT_PAYMENT);
});

export type ApiVerifyResult =
  | { status: "verified"; already: boolean }
  | { status: "not_found" }
  | { status: "expired" };

/**
 * Checks whether the bank actually received this order's exact amount.
 * The client only supplies the order id — amount, card and status all come
 * from the database. Nothing is completed without a confident match.
 */
export const verifyPaymentNow = createServerFn({ method: "POST" })
  .inputValidator((input: { orderId: string }) => ({ orderId: String(input.orderId) }))
  .handler(async ({ data }): Promise<ApiVerifyResult> => {
    const core = await import("./server/core.server");
    const user = await core.requireUser();
    const { verifyOrderPayment } = await import("./server/payment-matching.server");
    const result = await verifyOrderPayment(data.orderId, user.id);
    if (result.status === "verified") {
      // Best effort: delivery must never break or block payment verification.
      try {
        const { runDelivery } = await import("./server/delivery.server");
        await runDelivery(data.orderId);
      } catch {
        /* delivery is retried by polling and by the cron endpoint */
      }
      return { status: "verified", already: result.already };
    }
    return { status: result.status };
  });

/**
 * The user declares that the manual transfer was made.
 * This can never complete an order — only an admin verification can.
 */
export const submitPayment = createServerFn({ method: "POST" })
  .inputValidator((input: { orderId: string; note?: string | null }) => ({
    orderId: String(input.orderId),
    note: input.note ? String(input.note).slice(0, 500) : null,
  }))
  .handler(async ({ data }) => {
    const core = await import("./server/core.server");
    const user = await core.requireUser();
    await core.db.rpc("expire_stale_orders");

    const { data: order } = await core.db
      .from("orders")
      .select("*")
      .eq("id", data.orderId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!order) throw new core.AppError("order_not_found");
    if (order.status === "processing") return { ok: true, already: true };
    if (order.status !== "awaiting_payment") throw new core.AppError("order_not_payable");

    const now = new Date().toISOString();
    const { error } = await core.db.from("payments").insert({
      order_id: order.id,
      user_id: user.id,
      declared_amount_uzs: order.amount_uzs,
      payer_note: data.note,
      status: "submitted",
      submitted_at: now,
    });
    // A duplicate submit is not an error for the user.
    if (error && error.code !== "23505") throw new core.AppError("payment_submit_failed");

    await core.db.from("orders").update({ status: "processing" }).eq("id", order.id).eq("user_id", user.id);
    return { ok: true, already: Boolean(error) };
  });
