import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Star, Crown, ArrowRight, Flame, User } from "lucide-react";
import { AppHeader } from "../components/AppHeader";
import { LevelBadge, normalizeLevelKey } from "../components/LevelIdentity";
import { useT } from "../lib/language";
import { getLiveOrders, type ApiLiveOrder } from "../lib/live-orders.functions";
import { formatAmount } from "../lib/format";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Telegram Stars va Premium — Starjbot" },
      { name: "description", content: "Telegram Stars va Premiumni tez va qulay xarid qiling." },
      { property: "og:title", content: "Telegram Stars va Premium — Starjbot" },
      { property: "og:description", content: "Telegram Stars va Premiumni tez va qulay xarid qiling." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Home,
});

function Home() {
  const t = useT();
  return (
    <>
      <AppHeader title="Starjbot" />
      <main className="px-4 pb-6 pt-2">
        {/* Product tiles */}
        <section className="grid grid-cols-2 gap-3">
          <ProductTile
            to="/stars"
            title="Stars"
            subtitle={t.starsTileSub}
            icon={<Star className="h-6 w-6" fill="currentColor" />}
            product="stars"
          />
          <ProductTile
            to="/premium"
            title="Premium"
            subtitle={t.premiumTileSub}
            icon={<Crown className="h-6 w-6" />}
            product="premium"
          />
        </section>

        {/* Live orders */}
        <LiveOrders />
      </main>
    </>
  );
}

function LiveOrders() {
  const t = useT();
  const { data } = useQuery({
    queryKey: ["live-orders"],
    queryFn: () => getLiveOrders(),
    refetchInterval: 30_000,
  });
  const orders = data ?? [];

  return (
    <section className="mt-4">
      <div className="mb-2 flex items-center gap-2">
        <Flame className="h-4 w-4 text-primary-glow" />
        <h3 className="text-sm font-semibold uppercase tracking-wide">{t.liveOrders}</h3>
        <span className="ml-auto flex items-center gap-1 text-[11px] font-medium text-emerald-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          LIVE
        </span>
      </div>

      {orders.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-4 py-6 text-center text-xs text-muted-foreground">
          {t.liveOrdersEmpty}
        </div>
      ) : (
        <ul className="space-y-2">
          {orders.map((o) => (
            <LiveOrderRow key={o.orderId} order={o} />
          ))}
        </ul>
      )}
    </section>
  );
}

function LiveOrderRow({ order }: { order: ApiLiveOrder }) {
  const t = useT();
  const product =
    order.productType === "stars"
      ? `${formatAmount(order.quantity)} Stars`
      : t.livePremium(order.quantity);

  return (
    <li className="live-order-row flex items-center gap-3 px-3.5 py-3" data-level={normalizeLevelKey(order.levelKey)}>
      {order.photoUrl ? (
        <img
          src={order.photoUrl}
          alt={order.displayName}
          className="live-order-avatar h-10 w-10 shrink-0 rounded-full object-cover"
          loading="lazy"
        />
      ) : (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-muted-foreground">
          <User className="h-5 w-5" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{order.displayName}</p>
        <div className="mt-0.5 flex items-center gap-2">
          {order.levelKey && (
            <LevelBadge levelKey={order.levelKey} name={t.levelName(order.levelKey)} />
          )}
        </div>
      </div>

      <div className="shrink-0 text-right">
        <p className="flex items-center justify-end gap-1 text-sm font-bold">
          {order.productType === "stars" ? (
            <Star className="h-3.5 w-3.5 text-amber-400" fill="currentColor" />
          ) : (
            <Crown className="h-3.5 w-3.5 text-primary-glow" />
          )}
          {product}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {formatAmount(order.amountUzs)} UZS · {timeAgo(order.completedAt, t)}
        </p>
      </div>
    </li>
  );
}

function timeAgo(iso: string, t: ReturnType<typeof useT>): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return t.liveJustNow;
  if (minutes < 60) return t.liveMinutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t.liveHoursAgo(hours);
  return t.liveDaysAgo(Math.floor(hours / 24));
}

function ProductTile({
  to,
  title,
  subtitle,
  icon,
  product,
}: {
  to: "/stars" | "/premium";
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  product: "stars" | "premium";
}) {
  return (
    <Link
      to={to}
      className="product-tile no-tap-highlight group relative overflow-hidden p-4 transition-transform active:scale-[0.98]"
      data-product={product}
    >
      <div
        className="product-icon mb-6 inline-flex h-11 w-11 items-center justify-center rounded-xl"
      >
        {icon}
      </div>
      <p className="text-base font-semibold">{title}</p>
      <p className="text-xs text-muted-foreground">{subtitle}</p>
      <ArrowRight className="absolute right-3 top-3 h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
