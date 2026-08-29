# Fix Fragment delivery: response envelope parsing

I checked the official SDK source and called the live API. The integration's endpoints, `@username` format and Base64 seed are all correct — the bug is in how responses are read.

## What's actually wrong

Every Fragment response is wrapped in an envelope:

```text
success:   {"success": true,  "data": { ... }}
failure:   {"success": false, "error": {"code": ..., "message": "...", "error_code": "..."}}
```

Verified live:
- `GET /api/v1/commission/rates` → `{"success":true,"data":{...}}`
- `POST /api/v1/premium/check-eligibility` (bad user) → HTTP 200, `{"success":false,"eligible":false,"error":{"message":"Please enter a username assigned to a user."}}`
- `GET /api/v1/queue/{bad id}` → `{"success":false,"error":{"code":422,"message":"...","error_code":"VALIDATION_ERROR"}}`

Current `src/lib/server/fragment.server.ts` reads fields off the top level (`request_id`, `status`, `eligible`) and only treats non-2xx as an error. Consequences:

1. Queue polling reads `data.status` from the top level, gets `undefined`, and always maps to `processing`. This is why the two test orders sat on "Доставляется" forever and never flipped to delivered or failed.
2. A failed purchase returns HTTP 200 with `success:false`, so the code thinks it succeeded, finds no `request_id`, and dumps the order into `needs_review` with no real reason.
3. Real error messages (`error.message`) are never surfaced, so the failure reason shown to the user is generic.

Queue status values from the SDK are `queued | processing | completed | failed | timeout` — the current success list already covers `completed`, but `timeout` is unhandled.

## The fix (parsing only)

`src/lib/server/fragment.server.ts`:

- In `request()`, after parsing JSON: if the body has `success === false`, treat it as a provider error using `error.message` (and `error.error_code`), regardless of HTTP status. Keep the existing rule that 5xx / 429 / network / timeout stay `unknown` so no blind re-purchase can happen.
- Unwrap `data` once, centrally, and hand the inner object to each caller.
- `buyStars` / `buyPremium`: read `request_id` from the unwrapped `data`; keep the existing fallbacks.
- `getQueueStatus`: read `status` from the unwrapped `data`; map `completed` → success, `failed` → failed, `timeout` → failed with reason, `queued`/`processing` → processing; read the failure text from `data.error`.
- `checkPremiumEligibility`: read `eligible` / `reason` from the unwrapped `data`, and treat the observed top-level `eligible:false` + `error.message` form as a definite not-eligible with that reason.
- Seed handling, `@username` normalization, the 20s timeout, and `sanitize()` redaction are unchanged.

Not touched: the deliveries table, the delivery state machine, duplicate protection, HUMO verification, payment matching, order expiry, loyalty/referrals/missions.

## Tests

`src/lib/server/__tests__/delivery.test.ts` — existing mocks return bare bodies, so they'd pass against the broken parser. Wrap the mock responses in the real `{"success":true,"data":{...}}` envelope and add cases:

- queue returns `{"success":true,"data":{"status":"completed"}}` → delivery becomes `success`
- queue returns `status: "failed"` with an `error` → delivery `failed` with a classified reason
- buy returns HTTP 200 `{"success":false,"error":{...}}` → delivery `failed`, no second purchase attempt
- 5xx / timeout still map to `unknown` → stays in flight, never re-buys

All existing guarantees (unpaid order never calls Fragment, `@buyer` username, request_id stored, one purchase per order, seed never leaked) stay asserted.

## Stuck orders

Orders currently parked in `processing` with a stored `request_id` will resolve themselves on the next poll once parsing is fixed — no data changes needed. If you want the two old test orders cleared instead, say so and I'll handle them separately.

## Verification

Run vitest (all Fragment traffic mocked — no real purchases), typecheck, and a production build.
