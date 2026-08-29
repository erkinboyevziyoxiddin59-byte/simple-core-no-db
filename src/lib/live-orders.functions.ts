import { createServerFn } from "@tanstack/react-start";

export interface ApiLiveOrder {
  orderId: string;
  username: string | null;
  photoUrl: string | null;
  productType: "stars" | "premium_3" | "premium_6" | "premium_12";
  quantity: number;
  amountUzs: number;
  completedAt: string;
  levelKey: string | null;
  levelEmoji: string | null;
}

/**
 * Public feed: the 10 most recent orders that are completed AND successfully
 * delivered. Only @username + avatar are exposed (never real names).
 */
export const getLiveOrders = createServerFn({ method: "GET" }).handler(
  async (): Promise<ApiLiveOrder[]> => {
    const core = await import("./server/core.server");

    const { data, error } = await core.db
      .from("deliveries")
      .select(
        "order_id, completed_at, orders!inner(id, product_type, quantity, amount_uzs, status, user_id, users(username, photo_url))",
      )
      .eq("status", "success")
      .eq("orders.status", "completed")
      .order("completed_at", { ascending: false })
      .limit(10);
    if (error) throw new core.AppError("live_orders_failed");

    type Row = {
      order_id: string;
      completed_at: string | null;
      orders: {
        id: string;
        product_type: ApiLiveOrder["productType"];
        quantity: number;
        amount_uzs: number;
        user_id: string;
        users: { username: string | null; photo_url: string | null } | null;
      } | null;
    };
    const rows = (data ?? []) as unknown as Row[];

    return Promise.all(
      rows.map(async (row) => {
        const order = row.orders;
        const user = order?.users ?? null;

        // Level from the user's existing lifetime progress (Starter..Legend).
        let levelKey: string | null = null;
        let levelEmoji: string | null = null;
        if (order?.user_id) {
          const { data: progress } = await core.db.rpc("user_progress_value", { _user_id: order.user_id });
          const { data: level } = await core.db.rpc("level_for", { _value: progress ?? 0 });
          const lv = level as { key?: string; emoji?: string } | null;
          levelKey = lv?.key ?? null;
          levelEmoji = lv?.emoji ?? null;
        }

        return {
          orderId: order?.id ?? row.order_id,
          username: user?.username ?? null,
          photoUrl: user?.photo_url ?? null,
          productType: order?.product_type ?? "stars",
          quantity: order?.quantity ?? 0,
          amountUzs: order?.amount_uzs ?? 0,
          completedAt: row.completed_at ?? new Date().toISOString(),
          levelKey,
          levelEmoji,
        };
      }),
    );
  },
);
