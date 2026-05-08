-- (#411) Per-user gate so the auto plaid_accounts dedupe runs once per
-- user (first hit on the Chase/transactions page or after a Plaid
-- (re)link) instead of re-firing on every request. Backfilled NULL so
-- existing users get one healing pass on their next eligible hit.
ALTER TABLE "forecast_settings"
  ADD COLUMN IF NOT EXISTS "auto_dedupe_ran_at" timestamptz;
