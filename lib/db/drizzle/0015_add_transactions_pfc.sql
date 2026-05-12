-- (#636) Persist Plaid's `personal_finance_category.primary` /
-- `.detailed` on every transaction the Plaid sync writes so the
-- startup card-payment sweep (and any future audits) can catch rows
-- whose description is too bland to match the heuristic patterns
-- (e.g. "ACH WEB PAYMENT 12345") but whose PFC clearly identifies
-- them as a card payment / transfer (LOAN_PAYMENTS, TRANSFER_*).
-- Nullable on purpose: rows that did not originate from a Plaid sync
-- (manual entry, XLSX import) carry NULL, and existing rows
-- pre-dating this column also stay NULL until the next refresh from
-- Plaid backfills them.
--
-- Idempotent: safe to run on databases that already have the columns.

ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "pfc_primary" text;

ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "pfc_detailed" text;
