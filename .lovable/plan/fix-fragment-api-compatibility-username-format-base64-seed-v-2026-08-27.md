# Fix Fragment API compatibility: @username format + Base64 seed validation

Small, targeted fix to the existing delivery integration. No rebuild, no changes to payments, matching, expiry, loyalty, the deliveries table, or delivery architecture.

## 1. Username format — `src/lib/server/fragment.server.ts`

- `normalizeUsername()` currently strips leading `@`, but the live Fragment REST API requires the `@` form.
- Change it to a Fragment-specific normalization that **guarantees** a leading `@`:
  - `"Ziyoxidin"` → `"@Ziyoxidin"`
  - `"@Ziyoxidin"` → `"@Ziyoxidin"` (idempotent, no double `@@`)
- The database format is untouched — orders keep storing usernames without `@`; the `@` is added only at the Fragment request boundary (in `buyStars`, `checkPremiumEligibility`, `buyPremium`, which all already route through `normalizeUsername`).

## 2. Base64 seed validation — `src/lib/server/fragment.server.ts`

- In `walletSeed()`, after the existing missing-seed check, add a format check: non-empty string that matches Base64 (`^[A-Za-z0-9+/]+={0,2}$`, length multiple of 4) and round-trips through `Buffer.from(seed, "base64")`.
- An obviously invalid seed throws a new `InvalidSeedError` (message: `delivery_seed_invalid`) **before any network call** — same fail-safe path as the missing seed.
- The error message never contains the seed or any part of it; the existing `sanitize()` redaction stays in place.
- Env var name `FRAGMENT_WALLET_SEED` unchanged; still read inside the handler, server-only, never in `VITE_*`, never stored in the DB.

## 3. Delivery orchestrator — `src/lib/server/delivery.server.ts`

- Minimal touch only if needed so `InvalidSeedError` maps to the same safe configuration failure (`not_configured` / config error reason) as `MissingSeedError`, with no Fragment call and no retry. No state-machine changes; duplicate protection (unique `order_id`, atomic pending→processing flip, no blind retry after unknown outcomes) stays exactly as-is.

## 4. Tests — `src/lib/server/__tests__/delivery.test.ts`

- Set the test seed to a valid Base64 value (e.g. `Buffer.from("test-seed-value").toString("base64")`) so existing scenarios pass the new validation.
- Update the username assertion: `body.username` must now be `"@buyer"` (order row stores `"buyer"` without `@` — adjust the fake order's `recipient_username` to `"buyer"` to prove the boundary adds the `@`).
- Add a case: seed that is present but not Base64 → delivery fails with the config error, `fetchMock` never called.
- Keep all existing guarantees: unpaid order → no Fragment call; `request_id` stored; queue tracked; repeated runs → single purchase; timeout → no blind second purchase; seed never appears in stored records or returned values (update the redaction test to use the Base64 seed value).

## 5. Verification

- Run the vitest suite (all Fragment traffic mocked — no real purchases possible).
- Typecheck and production build.
- API contract unchanged: `https://api.fragment-api.space`, `POST /api/v1/stars/buy`, `GET /api/v1/queue/{request_id}`, `POST /api/v1/premium/check-eligibility`, `POST /api/v1/premium/buy`.

## Files changed

- `src/lib/server/fragment.server.ts` — `@` normalization + Base64 seed validation
- `src/lib/server/delivery.server.ts` — only if the new error type needs mapping (one branch)
- `src/lib/server/__tests__/delivery.test.ts` — updated/added assertions

Nothing else is touched.
