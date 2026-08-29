import { createServerFn } from "@tanstack/react-start";

export type ApiDeliveryStatus = "none" | "pending" | "processing" | "success" | "failed";

export interface ApiDelivery {
  status: ApiDeliveryStatus;
  reason: string | null;
}

async function ownedOrderId(orderId: string): Promise<string | null> {
  const core = await import("./server/core.server");
  const user = await core.requireUser();
  const { data } = await core.db
    .from("orders")
    .select("id")
    .eq("id", orderId)
    .eq("user_id", user.id) // ownership enforced server-side
    .maybeSingle();
  return data?.id ?? null;
}

/** Read-only delivery state for an order owned by the caller. */
export const getDeliveryStatus = createServerFn({ method: "POST" })
  .inputValidator((input: { orderId: string }) => ({ orderId: String(input.orderId) }))
  .handler(async ({ data }): Promise<ApiDelivery> => {
    const id = await ownedOrderId(data.orderId);
    if (!id) return { status: "none", reason: null };
    const { readDelivery } = await import("./server/delivery.server");
    return readDelivery(id);
  });

/** Starts or resumes delivery. Idempotent — never causes a second purchase. */
export const advanceDelivery = createServerFn({ method: "POST" })
  .inputValidator((input: { orderId: string }) => ({ orderId: String(input.orderId) }))
  .handler(async ({ data }): Promise<ApiDelivery> => {
    const id = await ownedOrderId(data.orderId);
    if (!id) return { status: "none", reason: null };
    const { runDelivery } = await import("./server/delivery.server");
    return runDelivery(id);
  });
