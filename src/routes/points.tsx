import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gift } from "lucide-react";
import { AppHeader } from "../components/AppHeader";
import { Progress } from "../components/StatBits";
import { formatAmount } from "../lib/format";
import { useT } from "../lib/language";
import {
  getLoyaltyConfig,
  getMyLedger,
  getMyRewardRequests,
  redeemReward,
  type ApiRewardRequest,
} from "../lib/loyalty.functions";
import { getMyProfile } from "../lib/profile.functions";

export const Route = createFileRoute("/points")({
  head: () => ({
    meta: [
      { title: "Star Points va darajalar — Starjbot" },
      {
        name: "description",
        content: "Star Points balansi, mukofotlar, darajalar va ballar tarixi.",
      },
      { property: "og:title", content: "Star Points va darajalar — Starjbot" },
      {
        property: "og:description",
        content: "Star Points balansi, mukofotlar, darajalar va ballar tarixi.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PointsPage,
});

const STATUS_META: Record<
  ApiRewardRequest["status"],
  { key: "reqPending" | "reqApproved" | "reqCompleted" | "reqRejected"; dot: string }
> = {
  pending: { key: "reqPending", dot: "🟡" },
  approved: { key: "reqApproved", dot: "🔵" },
  completed: { key: "reqCompleted", dot: "🟢" },
  rejected: { key: "reqRejected", dot: "🔴" },
};

function PointsPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<string | null>(null);

  const profileQuery = useQuery({ queryKey: ["profile"], queryFn: () => getMyProfile() });
  const configQuery = useQuery({
    queryKey: ["loyalty-config"],
    queryFn: () => getLoyaltyConfig(),
    staleTime: 5 * 60 * 1000,
  });
  const requestsQuery = useQuery({ queryKey: ["reward-requests"], queryFn: () => getMyRewardRequests() });
  const ledgerQuery = useQuery({ queryKey: ["ledger"], queryFn: () => getMyLedger() });

  const claim = useMutation({
    mutationFn: (rewardId: string) => redeemReward({ data: { rewardId } }),
    onSuccess: () => {
      setToast(t.requestCreated);
      queryClient.invalidateQueries({ queryKey: ["profile"] });
      queryClient.invalidateQueries({ queryKey: ["reward-requests"] });
      queryClient.invalidateQueries({ queryKey: ["ledger"] });
      setTimeout(() => setToast(null), 2600);
    },
    onError: (err: Error) => {
      setToast(err.message === "cooldown" ? t.cooldown : err.message);
      setTimeout(() => setToast(null), 2600);
    },
  });

  const profile = profileQuery.data;
  const config = configQuery.data;
  const loading = profileQuery.isLoading || configQuery.isLoading;
  const error = profileQuery.error ?? configQuery.error;

  const points = profile?.points ?? 0;
  const rewards = [...(config?.rewards ?? [])].sort((a, b) => a.cost - b.cost);
  const nextReward = rewards.find((r) => r.cost > points) ?? null;
  const pointsToNextReward = nextReward ? nextReward.cost - points : 0;
  const rewardProgress = nextReward ? Math.min(100, (points / nextReward.cost) * 100) : 100;
  const requests = requestsQuery.data ?? [];
  const ledger = ledgerQuery.data ?? [];

  return (
    <>
      <AppHeader title={`⭐ ${t.starPoints}`} back={false} />
      <main className="px-4 pb-8 pt-4">
        {loading ? (
          <div className="h-64 animate-pulse rounded-2xl bg-card" />
        ) : error || !profile || !config ? (
          <div className="mt-10 text-center">
            <p className="text-sm text-muted-foreground">{(error as Error | null)?.message ?? "—"}</p>
            <button
              onClick={() => {
                profileQuery.refetch();
                configQuery.refetch();
              }}
              className="mt-4 rounded-full px-5 py-2.5 text-sm font-semibold btn-primary-glow no-tap-highlight"
            >
              {t.retry}
            </button>
          </div>
        ) : (
          <>
            {/* Balance + rewards */}
            <section className="rounded-2xl border border-border bg-card p-4">
              <div className="flex items-end justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  ⭐ {t.starPoints}
                </p>
                <p className="text-2xl font-bold leading-none">{formatAmount(points)}</p>
              </div>
              <Progress value={rewardProgress} />
              <p className="mt-2 text-xs text-muted-foreground">
                {nextReward && pointsToNextReward > 0 ? (
                  <>
                    <span className="font-semibold text-foreground">{formatAmount(pointsToNextReward)}</span>{" "}
                    {t.pointsUntil("", nextReward.stars)}
                  </>
                ) : (
                  t.rewardUnlocked(rewards[rewards.length - 1]?.stars ?? 0)
                )}
              </p>

              <div className="mt-4 grid gap-2">
                {rewards.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => claim.mutate(r.id)}
                    disabled={points < r.cost || claim.isPending}
                    className="no-tap-highlight flex w-full items-center justify-center gap-2 rounded-full py-3 text-sm font-semibold btn-primary-glow disabled:opacity-40"
                  >
                    <Gift className="h-4 w-4" />
                    {t.redeem(formatAmount(r.cost), r.stars)}
                  </button>
                ))}
              </div>
              {toast && <p className="mt-2 text-center text-[11px] text-muted-foreground">{toast}</p>}
            </section>

            {/* What are Star Points */}
            <section className="mt-5 rounded-2xl border border-border bg-card p-4">
              <h3 className="text-sm font-semibold">ℹ️ {t.aboutPointsTitle}</h3>
              <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
                <li>• {t.aboutPointsWhat}</li>
                <li>• {t.aboutPointsEarn}</li>
                <li>• {t.aboutPointsRedeem}</li>
              </ul>
              <h4 className="mt-4 text-sm font-semibold">{t.aboutLevelsTitle}</h4>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t.aboutLevelsDesc}</p>
              <div className="mt-3 space-y-1.5">
                {config.levels.map((l) => (
                  <div key={l.key} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate">
                      {l.emoji} <span className="font-medium text-foreground">{l.name}</span>{" "}
                      <span className="text-muted-foreground">
                        · {t.levelFrom(formatAmount(l.threshold))}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary-glow">
                      ×{l.multiplier}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            {/* Reward requests */}
            <section className="mt-5">
              <h3 className="mb-2 text-sm font-semibold">{t.rewards}</h3>
              <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
                {requests.length === 0 ? (
                  <p className="px-4 py-4 text-xs text-muted-foreground">{t.noRewards}</p>
                ) : (
                  requests.map((r) => (
                    <div key={r.id} className="flex items-center justify-between px-4 py-3">
                      <div>
                        <p className="text-sm font-semibold">{r.stars} Stars</p>
                        <p className="text-[11px] text-muted-foreground">
                          −{formatAmount(r.cost)} {t.points} · #{r.requestNo}
                        </p>
                      </div>
                      <span className="text-xs font-medium">
                        {STATUS_META[r.status].dot} {t[STATUS_META[r.status].key]}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* Level ladder */}
            <section className="mt-5">
              <h3 className="mb-2 text-sm font-semibold">{t.levels}</h3>
              <div className="rounded-2xl border border-border bg-card p-2">
                {config.levels.map((l) => {
                  const active = l.key === profile.level.key;
                  const reached = profile.lifetimeStars >= l.threshold;
                  return (
                    <div
                      key={l.key}
                      className={`flex items-center justify-between rounded-xl px-3 py-2.5 ${active ? "bg-secondary" : ""}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={reached ? "" : "opacity-40"}>{l.emoji}</span>
                        <span className={`text-sm font-medium ${reached ? "" : "text-muted-foreground"}`}>
                          {l.name}
                        </span>
                        <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary-glow">
                          ×{l.multiplier}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {l.threshold === 0 ? "0" : formatAmount(l.threshold)}
                      </span>
                    </div>
                  );
                })}
              </div>
              {profile.nextLevel && (
                <>
                  <Progress value={profile.progressToNext} />
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t.nextLevel}: {profile.nextLevel.emoji} {profile.nextLevel.name} —{" "}
                    <span className="font-semibold text-foreground">
                      {formatAmount(Math.max(0, profile.nextLevel.threshold - profile.lifetimeStars))}
                    </span>{" "}
                    {t.remaining("")}
                  </p>
                </>
              )}
            </section>

            {/* Points history */}
            <section className="mt-5">
              <h3 className="mb-2 text-sm font-semibold">{t.history}</h3>
              <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
                {ledger.length === 0 ? (
                  <p className="px-4 py-4 text-xs text-muted-foreground">—</p>
                ) : (
                  ledger.slice(0, 12).map((e) => (
                    <div key={e.id} className="flex items-center justify-between px-4 py-2.5">
                      <span className="mr-3 truncate text-xs text-muted-foreground">{e.note}</span>
                      <span
                        className={`text-sm font-semibold ${e.points >= 0 ? "text-success" : "text-muted-foreground"}`}
                      >
                        {e.points >= 0 ? "+" : "−"}
                        {formatAmount(Math.abs(e.points))}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>
          </>
        )}
      </main>
    </>
  );
}
