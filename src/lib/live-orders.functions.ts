import { createServerFn } from "@tanstack/react-start";

export interface ApiLiveOrder {
  orderId: string;
  displayName: string;
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
 * delivered. The user's existing Telegram display name and avatar are shown.
 */
export const getLiveOrders = createServerFn({ method: "GET" }).handler(
  async (): Promise<ApiLiveOrder[]> => {
    const core = await import("./server/core.server");

    const { data, error } = await core.db
      .from("orders")
      .select(
        "id, product_type, quantity, amount_uzs, completed_at, user_id, users(first_name, last_name, username, photo_url), deliveries(status)",
      )
      .eq("status", "completed")
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(25);
    if (error) throw new core.AppError("live_orders_failed");

    type Row = {
      id: string;
      product_type: ApiLiveOrder["productType"];
      quantity: number;
      amount_uzs: number;
      completed_at: string | null;
      user_id: string;
      users:
        | { first_name: string | null; last_name: string | null; username: string | null; photo_url: string | null }
        | Array<{ first_name: string | null; last_name: string | null; username: string | null; photo_url: string | null }>
        | null;
      deliveries: { status: string } | Array<{ status: string }> | null;
    };
    const all = (data ?? []) as unknown as Row[];

    // A completed order counts as delivered unless its delivery explicitly failed.
    const rows = all
      .filter((r) => {
        const d = Array.isArray(r.deliveries) ? r.deliveries : r.deliveries ? [r.deliveries] : [];
        return !d.some((x) => x.status === "failed");
      })
      .slice(0, 10);

    return Promise.all(
      rows.map(async (order) => {
        const rawUser = order.users;
        const user = (Array.isArray(rawUser) ? rawUser[0] : rawUser) ?? null;

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
          displayName:
            [user?.first_name, user?.last_name].filter(Boolean).join(" ") ||
            user?.username ||
            "Telegram user",
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
