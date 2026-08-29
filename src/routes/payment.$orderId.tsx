import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Check, CreditCard, Clock, CheckCircle2, Sparkles, Loader2, AlertTriangle } from "lucide-react";
import { AppHeader } from "../components/AppHeader";
import { formatAmount, typeLabel, uiStatus } from "../lib/format";
import { cancelOrder, getMyOrder, type ApiOrder } from "../lib/orders.functions";
import { getPaymentInfo, verifyPaymentNow, type ApiVerifyResult } from "../lib/payments.functions";
import { advanceDelivery, type ApiDelivery } from "../lib/delivery.functions";
import { useT } from "../lib/language";

export const Route = createFileRoute("/payment/$orderId")({
  head: () => ({
    meta: [
      { title: "To‘lov — Starjbot" },
      { name: "description", content: "Buyurtma uchun to‘lov ma’lumotlari." },
      { property: "og:title", content: "To‘lov — Starjbot" },
      { property: "og:description", content: "Buyurtma uchun to‘lov ma’lumotlari." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PaymentPage,
});

function PaymentPage() {
  const { orderId } = Route.useParams();
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState<string | null>(null);

  const orderQuery = useQuery<ApiOrder | null>({
    queryKey: ["order", orderId],
    queryFn: () => getMyOrder({ data: { orderId } }),
    refetchInterval: 15_000,
  });
  const paymentInfo = useQuery({
    queryKey: ["payment-info"],
    queryFn: () => getPaymentInfo(),
    staleTime: 5 * 60 * 1000,
  });

  const order = orderQuery.data ?? null;

  // Delivery is tracked separately: "Delivered" is only shown once Fragment
  // actually confirmed the purchase.
  const deliveryQuery = useQuery<ApiDelivery>({
    queryKey: ["delivery", orderId],
    queryFn: () => advanceDelivery({ data: { orderId } }),
    enabled: order?.status === "completed",
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === "success" || s === "failed" ? false : 8_000;
    },
  });
  const delivery = deliveryQuery.data ?? null;

  // "I paid" = mark the order as checking, then ask the server whether the
  // exact bank transfer already arrived. Only the server can verify a payment.
  const payMutation = useMutation<ApiVerifyResult>({
    // Verification only: the order status is never advanced by the click itself,
    // so an unpaid check can never reach the "sending" state.
    mutationFn: () => verifyPaymentNow({ data: { orderId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["order", orderId] });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["points"] });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelOrder({ data: { orderId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      navigate({ to: "/orders" });
    },
  });

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  if (orderQuery.isLoading) {
    return (
      <>
        <AppHeader title={t.myOrders} back />
        <main className="space-y-3 px-4 pt-4">
          <div className="h-40 animate-pulse rounded-2xl bg-card" />
          <div className="h-24 animate-pulse rounded-2xl bg-card" />
        </main>
      </>
    );
  }

  if (orderQuery.error) {
    return (
      <>
        <AppHeader title={t.myOrders} back />
        <main className="px-4 pt-8 text-center">
          <p className="text-sm text-muted-foreground">{(orderQuery.error as Error).message}</p>
          <button
            onClick={() => orderQuery.refetch()}
            className="mt-4 inline-flex rounded-full px-5 py-2.5 text-sm font-semibold btn-primary-glow no-tap-highlight"
          >
            {t.retry}
          </button>
        </main>
      </>
    );
  }

  if (!order) {
    return (
      <>
        <AppHeader title={t.orderNotFound} back />
        <main className="px-4 pt-8 text-center">
          <p className="text-sm text-muted-foreground">{t.orderNotFoundDesc}</p>
          <Link
            to="/"
            className="mt-4 inline-flex rounded-full px-5 py-2.5 text-sm font-semibold btn-primary-glow"
          >
            {t.home}
          </Link>
        </main>
      </>
    );
  }

  const status = uiStatus(order.status);
  const cardNumber = paymentInfo.data?.cardNumber ?? "";
  const cardHolder = paymentInfo.data?.cardHolder ?? "";
  const expireMinutes = paymentInfo.data?.orderExpireMinutes ?? 10;
  const expiresAt = new Date(order.expiresAt).getTime();

  const msLeft = Math.max(0, expiresAt - now);
  const totalMs = expireMinutes * 60 * 1000;
  const mm = Math.floor(msLeft / 60000).toString().padStart(2, "0");
  const ss = Math.floor((msLeft % 60000) / 1000).toString().padStart(2, "0");
  const progress = Math.max(0, Math.min(1, msLeft / totalMs));

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c: string | null) => (c === key ? null : c)), 1500);
    } catch {
      /* noop */
    }
  };

  const isTerminal = status !== "active";
  const timeUp = !isTerminal && msLeft <= 0;

  return (
    <>
      <AppHeader title={t.orderNo(order.orderNo)} subtitle={typeLabel(order.productType)} back />
      <main className="px-4 pb-8 pt-4 space-y-4">
        {/* Status banner */}
        {status === "paid" && (
          <StatusBanner
            tone="warning"
            icon={<Sparkles className="h-5 w-5 animate-pulse" />}
            title={t.paidTitle}
            desc={t.paidDesc}
          />
        )}
        {status === "delivered" && delivery?.status === "success" && (
          <StatusBanner
            tone="success"
            icon={<CheckCircle2 className="h-5 w-5" />}
            title={t.deliveredTitle}
            desc={t.deliveredDesc(order.recipientUsername)}
          />
        )}
        {status === "delivered" && delivery?.status === "failed" && (
          <StatusBanner
            tone="warning"
            icon={<AlertTriangle className="h-5 w-5" />}
            title={t.deliveryFailedTitle}
            desc={t.deliveryReason(delivery.reason ?? "")}
          />
        )}
        {status === "delivered" && delivery?.status !== "success" && delivery?.status !== "failed" && (
          <StatusBanner
            tone="warning"
            icon={<Sparkles className="h-5 w-5 animate-pulse" />}
            title={t.deliveringTitle}
            desc={t.deliveringDesc}
          />
        )}
        {status === "expired" && (
          <StatusBanner tone="muted" icon={<Clock className="h-5 w-5" />} title={t.expiredTitle} desc={t.expiredDesc} />
        )}

        {/* 1. Exact amount — highest visual priority */}
        <section className="rounded-2xl border-2 border-destructive/60 bg-destructive/10 p-5 text-center">
          <p className="text-[11px] font-bold uppercase tracking-wider text-destructive">
            {t.exactAmount}
          </p>
          <div className="mt-2 flex items-baseline justify-center gap-2">
            <span className="text-4xl font-black leading-none tabular-nums text-destructive">
              {formatAmount(order.amountUzs)}
            </span>
            <span className="text-base font-bold text-destructive/80">UZS</span>
          </div>
          <button
            onClick={() => copy(String(order.amountUzs), "amount")}
            className="no-tap-highlight mt-3 inline-flex items-center gap-2 rounded-full border border-destructive/40 bg-background/60 px-4 py-2 text-xs font-semibold text-foreground"
          >
            {copied === "amount" ? (
              <>
                <Check className="h-4 w-4 text-success" /> {t.copiedShort}
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" /> {t.copyShort}
              </>
            )}
          </button>
        </section>

        {/* 2. Timer (server `expires_at` is authoritative) */}
        {!isTerminal && !timeUp && (
          <section className="rounded-2xl border border-border bg-card p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Clock className="h-4 w-4" /> {t.timeLeft}
              </span>
              <span
                className={`font-mono text-2xl font-extrabold tabular-nums ${
                  msLeft < 60_000 ? "text-destructive" : "text-foreground"
                }`}
              >
                {mm}:{ss}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full transition-[width] duration-1000"
                style={{ width: `${progress * 100}%`, background: "var(--gradient-primary)" }}
              />
            </div>
          </section>
        )}

        {/* 4. Card details */}
        <section className="card-surface p-5">
          <div className="rounded-xl p-4 text-white" style={{ background: "var(--gradient-primary)" }}>
            <div className="flex items-center justify-between text-[11px] uppercase tracking-widest text-white/70">
              <span className="inline-flex items-center gap-1.5"><CreditCard className="h-3.5 w-3.5" /> UZCARD / HUMO</span>
              <span>Starjbot</span>
            </div>
            <p className="mt-3 font-mono text-lg tracking-widest">{cardNumber}</p>
            <div className="mt-3 flex items-end justify-between">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-white/60">{t.cardHolderLabel}</p>
                <p className="text-sm font-semibold">{cardHolder}</p>
              </div>
              <button
                onClick={() => copy(cardNumber.replace(/\s/g, ""), "card")}
                className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-medium backdrop-blur no-tap-highlight"
              >
                {copied === "card" ? t.copiedShort : t.copyShort}
              </button>
            </div>
          </div>
        </section>

        {/* Details */}
        <section className="rounded-2xl border border-border bg-card p-4 text-sm">
          <Row label={t.toWho} value={`@${order.recipientUsername}`} />
          <Row
            label={t.product}
            value={order.productType === "stars" ? `${formatAmount(order.quantity)} Stars` : `${t.monthsShort(order.quantity)} Premium`}
          />
          <Row label={t.orderNumber} value={`#${order.orderNo}`} />
        </section>

        {/* Actions */}
        {!isTerminal && (
          <div className="space-y-2">
            {(payMutation.error || cancelMutation.error) && (
              <p className="rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-center text-xs text-destructive">
                {((payMutation.error ?? cancelMutation.error) as Error).message}
              </p>
            )}
            {payMutation.data?.status === "not_found" && !payMutation.isPending && (
              <p className="rounded-2xl border border-warning/40 bg-warning/10 px-4 py-3 text-center text-xs text-warning">
                {t.paymentNotFoundYet}
              </p>
            )}
            <button
              onClick={() => payMutation.mutate()}
              disabled={payMutation.isPending}
              className="w-full rounded-full py-3.5 text-sm font-semibold btn-primary-glow disabled:opacity-60 no-tap-highlight"
            >
              {payMutation.isPending ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> {t.checkingPayment}
                </span>
              ) : payMutation.data?.status === "verified" ? (
                t.sendingPayment
              ) : payMutation.data?.status === "not_found" ? (
                t.checkAgain
              ) : (
                t.iPaid
              )}
            </button>
            <button
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
              className="w-full rounded-full border border-border py-3 text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-40 no-tap-highlight"
            >
              {t.cancel}
            </button>
          </div>
        )}

        {isTerminal && (
          <Link
            to="/orders"
            className="mt-2 flex w-full items-center justify-center rounded-full py-3.5 text-sm font-semibold btn-primary-glow no-tap-highlight"
          >
            {t.myOrders}
          </Link>
        )}
      </main>
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

function StatusBanner({
  tone,
  icon,
  title,
  desc,
}: {
  tone: "success" | "warning" | "muted";
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  const styles = {
    success: "bg-success/15 text-success border-success/30",
    warning: "bg-warning/15 text-warning border-warning/30",
    muted: "bg-secondary text-muted-foreground border-border",
  }[tone];
  return (
    <div className={`flex items-start gap-3 rounded-2xl border p-4 ${styles}`}>
      <div className="mt-0.5">{icon}</div>
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs opacity-90">{desc}</p>
      </div>
    </div>
  );
}
