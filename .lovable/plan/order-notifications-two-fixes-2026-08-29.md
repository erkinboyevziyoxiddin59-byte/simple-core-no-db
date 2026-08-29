# Order notifications + two fixes

## Why your Stars order failed

Order `27ec14a0` failed with `not_configured` / "Wallet account could not be verified."

That exact message comes from one place only: the Fragment wallet check in `fragment.server.ts`. Before buying, the server asks Fragment to resolve the wallet address in `FRAGMENT_WALLET_ADDRESS` against the wallet seed. Fragment answered with a different address than the one configured, so the code refused to buy (deliberately — it will never spend from an unverified wallet) and marked the delivery failed after 1 attempt.

The earlier order `67bf5618` succeeded on its 2nd attempt, so the credentials worked at that moment. So this is a configuration/consistency problem with `FRAGMENT_WALLET_ADDRESS` vs. the seed's actual wallet, not a payment or code bug. Nothing in this plan changes the Fragment or wallet logic; fixing the env value is a separate step you can decide on after seeing the notifications.

Payment recognition already works the way you described: the user pays, taps "I paid", the server matches the exact amount against the HUMO bank message, completes the order and starts delivery automatically. No change needed there.

## 1. Telegram notifications (main work)

New server-only module `src/lib/server/order-notify.server.ts`:

- Sends via the existing StarjBot token (`TELEGRAM_BOT_TOKEN`) using `sendMessage`, server-side only.
- Two new server env vars: `TELEGRAM_COMPLETED_ORDERS_CHAT_ID`, `TELEGRAM_FAILED_ORDERS_CHAT_ID`. Names only go into `.env.example`; the IDs are never hardcoded and never reach the browser.
- Loads order number, buyer username, product, amount and time from the database; never includes seeds, cookies, Fragment credentials or tokens.
- Every send is wrapped in try/catch. A Telegram error is logged and ignored — order and delivery status are never affected.

Message formats exactly as you specified:

```text
✅ ORDER COMPLETED

Order: #123
User: @username
Product: 100 Stars
Amount: 10,124 UZS
Time: 14:35
```

```text
❌ ORDER FAILED

Order: #125
User: @username
Product: 100 Stars
Amount: 10,124 UZS
Reason: Fragment delivery failed
Time: 14:45
```

Trigger point: the single `finish()` helper in `delivery.server.ts` that writes the final `success` / `failed` state. Nothing else in delivery, payment, HUMO, Fragment, loyalty, referral or mission logic changes.

Duplicate prevention: the final-status write becomes conditional — it only updates the row while it is still non-final, and the notification is sent only when that write actually changed a row. So one completed message and one failure message per order, even with the cron retry loop or two concurrent polls.

Not notified: new order, awaiting payment, "I paid", checking, payment not found, processing, sending, cancelled, expired.

## 2. Remove "Bank xabarlari (HUMO)" from the admin panel

Delete only the read-only HUMO bank-messages section from `src/routes/admin.tsx` (and its now-unused query/labels). The bank parsing and payment matching behind it stay untouched — only the admin display goes away.

## 3. Failed deliveries must not show "Yetkazildi"

Today "Buyurtmalarim" labels any completed order "Yetkazildi", even when the Fragment delivery failed. Fix:

- `listMyOrders` also returns the delivery status for each order (read-only join on `deliveries`).
- In the orders list, a completed order whose delivery failed shows a red "Yetkazilmadi — admin siz bilan bog'lanadi" chip instead of the green "Yetkazildi". Deliveries still in flight keep the "Yetkazilmoqda" style.
- Uzbek and Russian strings added to `src/lib/i18n.ts`. The order detail page already shows the correct failure banner and stays as is.

Note (no change made): points are awarded by the database `complete_order()` function when payment completes, before delivery finishes — so a failed delivery still leaves points. Tell me if you want that changed; it is loyalty logic and out of scope here.

## Technical summary

- New: `src/lib/server/order-notify.server.ts` (server-only, dynamic-imported from the delivery module).
- Edited: `delivery.server.ts` (conditional final write + notify hook), `orders.functions.ts` (delivery status in the list), `src/routes/orders.tsx`, `src/routes/admin.tsx`, `src/lib/i18n.ts`, `.env.example`.
- No database migration, no schema or RLS change.
- After approval you must set `TELEGRAM_COMPLETED_ORDERS_CHAT_ID` and `TELEGRAM_FAILED_ORDERS_CHAT_ID` as server env vars, and StarjBot must be an admin of `@starjlive` and a member of the private channel.
