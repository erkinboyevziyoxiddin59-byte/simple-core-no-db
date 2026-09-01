import { Crown, Diamond, Medal, Sparkles, Star, Zap } from "lucide-react";
import type { ReactNode } from "react";

export type LoyaltyLevelKey = "new" | "bronze" | "silver" | "gold" | "diamond";

const LEVEL_ICONS: Record<LoyaltyLevelKey, ReactNode> = {
  new: <Star className="h-3 w-3" fill="currentColor" />,
  bronze: <Medal className="h-3 w-3" />,
  silver: <Zap className="h-3 w-3" fill="currentColor" />,
  gold: <Crown className="h-3 w-3" fill="currentColor" />,
  diamond: <Diamond className="h-3 w-3" fill="currentColor" />,
};

export function normalizeLevelKey(key: string | null | undefined): LoyaltyLevelKey {
  const normalized = key?.toLowerCase();
  if (normalized === "bronze" || normalized === "silver" || normalized === "gold" || normalized === "diamond") {
    return normalized;
  }
  return "new";
}

export function LevelBadge({ levelKey, name }: { levelKey: string | null | undefined; name: string }) {
  const key = normalizeLevelKey(levelKey);
  return (
    <span className="level-badge" data-level={key}>
      <span className="level-badge-icon" aria-hidden>{LEVEL_ICONS[key]}</span>
      <span>{name}</span>
      {key === "diamond" && <Sparkles className="level-sparkle h-2.5 w-2.5" aria-hidden />}
    </span>
  );
}

export function LevelIcon({ levelKey }: { levelKey: string | null | undefined }) {
  const key = normalizeLevelKey(levelKey);
  return <span className="level-emblem" data-level={key} aria-hidden>{LEVEL_ICONS[key]}</span>;
}