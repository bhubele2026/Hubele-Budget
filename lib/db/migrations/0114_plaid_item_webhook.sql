-- 0114_plaid_item_webhook.sql — which webhook address each linked bank
-- (Plaid item) was last told to call, when that was checked, and the bank's
-- refusal if there was one (package V3, automatic bank updates).
--
-- Idempotent and additive: ADD COLUMN IF NOT EXISTS, nullable, no default, so
-- the old build keeps serving against the new schema. Must agree with
-- `plaid_items` in lib/db/src/schema/index.ts.

ALTER TABLE plaid_items ADD COLUMN IF NOT EXISTS webhook_url text;
ALTER TABLE plaid_items ADD COLUMN IF NOT EXISTS webhook_checked_at timestamptz;
ALTER TABLE plaid_items ADD COLUMN IF NOT EXISTS webhook_error text;
