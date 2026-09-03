# Fix referral registration

## Why no referral row was created

Your link is a **bot deep link**: `https://t.me/Starjbot?start=ref_1208388326`. Opening it sends
`/start ref_1208388326` to the bot as a normal Telegram message.

- The referral code is only ever read in one place today: `attachReferral()` in
  `src/lib/server/core.server.ts`, called from `authenticate` (`src/lib/auth.functions.ts:50`)
  with `startParam` taken from the Mini App's `initDataUnsafe.start_param`.
- `initDataUnsafe.start_param` is only populated when the app is opened through a
  **Mini App** link (`?startapp=...`). With `?start=...` the user lands in the bot chat, and
  when they later open the app from the menu button there is no start param at all.
- The webhook (`src/routes/api/telegram-webhook.ts`) receives that `/start ref_…` message but
  only writes a diagnostics row and parses HUMO bank messages — it never handles `/start`.

So the code is parsed nowhere, the referrer is never looked up, and no `referrals` row is
inserted. The insert logic itself (`attachReferral`) is correct and already guards
self-referral, invalid codes, duplicates, and an existing referrer.

## Changes (minimal)

1. **Handle `/start <code>` in the webhook** (`src/routes/api/telegram-webhook.ts`)
   - For a private `message` whose text starts with `/start`, extract the payload.
   - Reuse existing server helpers: `upsertTelegramUser()` to register/refresh the user from the
     verified webhook `from` object, then `attachReferral(user, code)` — no new referral logic.
   - Wrapped in try/catch; webhook still always returns 200. HUMO/business-message branch untouched.

2. **Keep the Mini App path working** (`src/hooks/useSession.ts`, unchanged server side)
   - Continue passing `start_param`/`startapp`; the webhook path is additive, and `attachReferral`
     is idempotent so both paths together cannot create duplicates.

3. **Referral counter** — no change needed. Profile already shows
   `t.countSuffix(referrals.total)` from `getMyReferrals()`, which counts real rows in
   `referrals`, including `pending` ones (before any purchase).

4. **Reward trigger** — no change. `complete_order()` in the database rewards the referrer only
   on a completed Stars order, flipping `pending → rewarded` under `for update`, so it can never
   fire twice.

5. **Admin reward amount** — already exists in Admin → loyalty settings (`referralPoints`, read
   server-side from `app_settings.loyalty` by `complete_order`). I will verify it saves and is
   clearly labelled as "Referral reward (Star Points)"; no second config system.

6. **Tests** — extend `src/lib/server/__tests__` with a referral test file covering: valid code
   creates a row, invalid code creates nothing, self-referral rejected, existing referrer not
   replaced, duplicate insert ignored, and that registration alone adds no points ledger entry.
   Reward-side cases (first purchase, no double reward, admin amount) stay in SQL and are covered
   by assertion against the existing `complete_order` behaviour rather than rewriting it.

## Not touched

Payment verification, HUMO parsing, Fragment delivery, orders, loyalty level math, missions,
authentication, the `ref_<telegramId>` link format, and the database schema.

## Verification

Referral tests, `bunx tsgo --noEmit`, and `bun run build`, then a report answering all ten of
your questions.

## Note

For the webhook fix to take effect the bot's webhook must point at
`/api/telegram-webhook` for `message` updates (it currently receives business messages). I'll
confirm from incoming diagnostics whether plain `/start` messages reach it; if Telegram's
`allowed_updates` excludes `message`, that setting has to be updated on the bot side.
