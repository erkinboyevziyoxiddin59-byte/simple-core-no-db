# Live Orders feed on the homepage

## What changes

Replace the three info blocks under the Stars/Premium buttons on the main page ("Tezkor yetkazish", "Real-time narxlar", "Buyurtmalarim" quick link) with a **Live Orders** section: the 10 most recent orders that are completed AND successfully delivered, refreshed by polling.

## Data rules

- Only orders where `orders.status = completed` AND the linked `deliveries.status = success`.
- Latest 10 by completion time; older ones simply fall outside the query (no deletion).
- Per entry: buyer's `@username` (never first/last name), profile photo (`users.photo_url`, circular avatar with a fallback icon when missing), product label (e.g. `100 Stars` / `Premium — 3 months`), amount in UZS, relative time ("hozir" / "N daqiqa oldin").
- Loyalty level badge (emoji + name) per user, based on their lifetime progress via existing `user_progress_value()` + `level_for()` DB functions — the new names (Starter/Insider/Elite/Prestige/Legend) appear automatically.
- Failed/never-delivered orders never appear.

## Implementation

1. **`src/lib/live-orders.functions.ts`** (new) — public `getLiveOrders` server function (no auth needed, like `getLoyaltyConfig`): uses the existing service-role `db`, queries deliveries success + order + user, maps to a plain DTO `{ username, photoUrl, productLabel, starsQty, amountUzs, completedAt, levelKey, levelEmoji, levelName }`. Level resolved by calling the existing DB functions per user (10 rows max).
2. **`src/routes/index.tsx`** — replace the Features section and the "Buyurtmalarim" link card with a "LIVE ORDERS" list: avatar circle, @username, level chip, product + amount, relative time. Styled to match the current dark card design (not the neon reference image). Poll with `useQuery` + `refetchInterval: 30s`; graceful empty state ("Hozircha buyurtmalar yo'k") if none or on error.
3. **`src/lib/i18n.ts`** — add uz/ru strings: `liveOrders` title, relative time (just now, N min ago, N h ago), empty state, Premium label. Existing `feature1*`/`feature2*`/`myOrders*` keys removed from the home page usage.

## Not touched

No database schema or RLS changes (reads go through the existing service-role server layer). No changes to payment, HUMO, Fragment, delivery, loyalty calculation, referral, mission logic, or the channel-notification system. Amounts show the real `amount_uzs`; no fake data.

## Verification

- `tsgo` typecheck + production build.
- Playwright check of the homepage rendering the feed (and empty state).
