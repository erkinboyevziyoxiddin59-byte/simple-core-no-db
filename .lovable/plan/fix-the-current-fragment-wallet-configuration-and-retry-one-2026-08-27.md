# Fix the current Fragment wallet configuration and retry one delivery

The newest failure is no longer a response-parsing bug. The live provider accepted the request shape and returned `Invalid seed phrase` before creating a queue request (`provider_request_id` is empty). The configured value can pass the current Base64 syntax check while decoding to something that is not a supported wallet mnemonic. The official Fragment Stars API 2.1.6 requires the complete space-separated wallet seed phrase to be Base64-encoded; for a 12-word BIP39 wallet it defaults to V5R1 account index `0`, or the correct account can be resolved from a public TON wallet address.

## 1. Validate the decoded wallet seed safely

- Strengthen `src/lib/server/fragment.server.ts` so validation checks the decoded Base64 payload, not only Base64 syntax.
- Require a plausible complete mnemonic (normalized UTF-8 words with a supported word count) and fail locally with `delivery_seed_invalid` before any purchase request when the decoded value is arbitrary bytes, a placeholder, or an encoded non-phrase value.
- Never log, return, or store the encoded seed or decoded words.
- Preserve the existing base URL, endpoints, `@username` behavior, response-envelope handling, timeout safety, and no-blind-retry rules.

## 2. Support safe wallet-account resolution

- Add optional server-only `FRAGMENT_WALLET_ADDRESS` configuration for the wallet’s public TON address.
- When present, call `POST /api/v1/wallet/resolve` with the seed and public address before a purchase, then pass the returned `account_index` and verified `wallet_address` to Stars/Premium purchase requests.
- This handles the selected “not sure” account setup without guessing an index. Cache only the non-secret resolved address/index in server memory; never persist seed material.
- If the address does not match the seed or no account is found, return a configuration failure and do not purchase.

## 3. Improve provider error handling

- Preserve structured provider error codes such as `INVALID_SEED`, `INVALID_WALLET_SEED`, `WALLET_ADDRESS_MISMATCH`, and `ACCOUNT_INDEX_NOT_FOUND` instead of relying only on message text.
- Map seed/address/index failures to `not_configured`; retain existing user, balance, and uncertain-outcome classifications.
- Normalize nested/object error details so future records never store `[object Object]`. The two older rows are historical data from the previous parser and are not evidence of a new request failure.

## 4. Tests

- Add mocked coverage for decoded invalid mnemonic content being rejected before network access.
- Verify wallet resolution, propagation of `wallet_address`/`account_index`, mismatch failure, structured error serialization, seed redaction, and unchanged duplicate protection.
- Keep all Fragment traffic mocked; no real Stars purchase will occur during automated verification.

## 5. Production configuration and deliberate retry

- The production `FRAGMENT_WALLET_SEED` must be replaced through the server secrets UI with Base64 of the **complete space-separated real wallet phrase**. The phrase must never be pasted into chat or source code.
- Add the wallet’s public TON address as `FRAGMENT_WALLET_ADDRESS` so the API can resolve the correct account index safely.
- First run the non-purchasing wallet-resolution check. Only after it succeeds, reset exactly the newest listed delivery `0f8b30ce-01d6-477f-9073-41733fe116b2` from `failed` to `pending`, clearing its final failure fields. Do not alter the other two deliveries.
- Trigger that one delivery through the existing idempotent flow and inspect its queue result. No blind retry is performed because the failed attempt has no provider request ID and the provider explicitly rejected it before purchase.

## 6. Verification

- Run the delivery tests, TypeScript check, and production build.
- Confirm the newest delivery receives a provider request ID and progresses through queue polling, or report the exact sanitized provider error if wallet resolution still rejects the configuration.

## Files/configuration affected

- `src/lib/server/fragment.server.ts`
- `src/lib/server/delivery.server.ts`
- `src/lib/server/__tests__/delivery.test.ts`
- `.env.example` (server-only variable name placeholder)
- Server secrets: corrected `FRAGMENT_WALLET_SEED`; new `FRAGMENT_WALLET_ADDRESS`
- Database: only delivery `0f8b30ce-01d6-477f-9073-41733fe116b2`, and only after non-purchasing wallet validation succeeds

Payment verification, payment matching, order expiry, loyalty/referrals/missions, the deliveries schema, and the delivery architecture remain unchanged.
