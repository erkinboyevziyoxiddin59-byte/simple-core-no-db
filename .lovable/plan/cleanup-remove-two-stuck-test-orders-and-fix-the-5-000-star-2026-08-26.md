# Cleanup: remove two stuck test orders and fix the 5 000 star limit text

## 1. Delete test orders #30 and #31

Both orders belong to @Ziyoxidin, are 100 Stars, and are stuck in "processing":

- #31 — id 50225aa6-18b0-4a11-91f9-251a568eb16c
- #30 — id 39354f80-b3bc-4ea4-9f48-3019e48e6122

Each has 1 payment row attached; neither has delivery, points, or bank-transaction records. So the deletion is: remove the two payment rows, then the two orders. No other order is touched, and no schema or backend logic changes.

## 2. Fix the leftover "5 000" maximum

The real limit is already 1 000 everywhere that matters (app settings in the database, server validation, admin defaults, the Stars page input and presets). Only two display strings still say 5 000, in both languages:

- Uzbek and Russian home-tile subtitle: "50 — 5 000"
- Uzbek and Russian custom-amount placeholder: "50 – 5 000"

These will be updated to 1 000 so the UI matches the actual limit.

## Technical notes

- Data deletion runs as a data-only SQL statement (no migration, no schema change).
- Text change is limited to `src/lib/i18n.ts` (`starsTileSub`, `customAmountPh` for uz and ru).
