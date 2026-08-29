# Real Fragment delivery for Stars and Premium

Connect successful payment verification to automatic delivery through the Fragment API. The HUMO payment system stays exactly as it is.

## What changes for the user

- After "I paid" → "Checking" → payment verified, delivery starts automatically.
- Stars orders: a Fragment Stars purchase is created and tracked in its queue until it finishes.
- Premium orders: eligibility is checked first, then the Premium purchase is made; the result is final immediately.
- The payment page keeps its current design. "Delivered" now only appears once Fragment confirms success; while delivery runs the page shows "Sending"; if delivery fails, a clear delivery-failed message appears with a short reason.
- Nothing is purchased twice, even if the user taps repeatedly, refreshes, or the server retries.

## Database (one small migration)

There is no delivery storage today, so a minimal table is added — nothing existing is modified.

`public.deliveries`
- `order_id` (unique, one delivery per order — this uniqueness is the duplicate guard)
- `product_kind` (stars / premium)
- `status`: pending | processing | success | failed
- `provider_request_id` (Fragment `request_id` for Stars)
- `attempt_count`, `last_error`, `failure_code`
- timestamps

RLS enabled, no anon/authenticated grants needed beyond service-role — all access happens through server code with the admin client, matching how orders are already read.

## Delivery logic (server only)

New `src/lib/server/fragment.server.ts`
- Thin client for `https://api.fragment-api.space`:
  - `POST /api/v1/stars/buy` (username, amount, seed)
  - `GET /api/v1/queue/{request_id}`
  - `POST /api/v1/premium/check-eligibility`
  - `POST /api/v1/premium/buy` (username, duration, seed)
- Reads `FRAGMENT_WALLET_SEED` from `process.env` inside each call. Missing seed → `delivery_not_configured`, and delivery is marked failed without any network call.
- The seed is never logged, never returned, never part of an error message.
- Explicit timeouts via `AbortSignal.timeout`. A timeout is reported as an *uncertain* result, never as a failure that permits a retry purchase.

New `src/lib/server/delivery.server.ts` — the orchestration:
1. Load order with the admin client; require `status = 'completed'` and a `payments` row with `status = 'verified'`. Otherwise Fragment is never called.
2. Claim the delivery row: insert `pending` with `on conflict (order_id) do nothing`, then read it back.
   - `success` → return immediately, no purchase.
   - `processing` with a `provider_request_id` → check the queue status only.
   - `processing` without a request id (uncertain earlier outcome) → do not purchase; mark for manual review and surface a failure reason rather than risk a double purchase.
   - `pending` → atomically flip to `processing` (`update ... where status = 'pending'`); only the winner may call Fragment.
3. Recipient username and quantity/duration are read from the order row — never from the request payload.
4. Stars: buy → store `request_id` immediately → poll queue → map final state to success/failed.
   Premium: eligibility check → if already Premium or ineligible, mark failed with a clear reason and buy nothing → otherwise buy, and use the direct final result.
5. Known failure reasons handled safely: invalid username, already has Premium, insufficient wallet balance, API error, timeout/unknown.

## Wiring it up

- `src/lib/payments.functions.ts`: after `verifyPaymentNow` reports `verified`, kick off delivery (best effort, never blocks or breaks verification). `payment-matching.server.ts` is untouched.
- New server fn `getDeliveryStatus(orderId)` — ownership-checked, returns only `{ status, reason }`, never the request id internals or the seed.
- New server fn `advanceDelivery(orderId)` — safe to call repeatedly; resumes/checks an existing delivery.
- New cron route `src/routes/api/public/advance-deliveries.ts`, authenticated with the existing cron credential, which advances stuck `pending`/`processing` deliveries so progress continues when nobody has the app open.

## UI (payment page only, no redesign)

- Poll `getDeliveryStatus` while the order is completed and delivery is not final.
- "Delivered" banner requires delivery `success`; `processing`/`pending` keeps the existing "Sending" state; `failed` renders a new failure banner using existing banner styles.
- New translation strings in `src/lib/i18n.ts` (uz/ru) for the sending and delivery-failed states.

## Testing (mocked — no real purchases)

Vitest suite with `fetch` mocked; the Fragment base URL is never actually contacted:
unpaid/expired order → no Fragment call; verified Stars → request created and tracked; queue processing → stays tracked; queue failed → delivery failed; Premium eligible → purchased; Premium already active → no purchase; invalid username / insufficient balance / API error → safe failure; timeout → no second purchase; repeated and concurrent execution → single purchase; recipient and amount sourced from the order row; seed absent from any returned value or log.

## Configuration

`.env.example` gains `FRAGMENT_WALLET_SEED=` (name only). The real value is set as a server secret; it is never exposed to the client and never used in a `VITE_*` variable.

## Not touched

`telegram-webhook.ts`, `humo-parser.server.ts`, `bank-transactions.server.ts`, `payment-matching.server.ts`, matching/time-window/expiry rules, unique amounts, the 2-active-order limit, loyalty, referrals, missions, auth, card settings.
