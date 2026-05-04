-- (#258) Wall-clock timestamp of when we last successfully verified
-- consent_expiration_at against Plaid (any code path: exchange, on-sync
-- refresh, or the daily cron). Updated on every successful /item/get
-- call regardless of whether the cutoff value actually changed, so
-- support can answer "did the daily refresh run today?" without diffing
-- logs. Null until the first successful refresh (e.g. for items linked
-- before this column existed).
--
-- Idempotent: safe to run on databases that already have the column.

ALTER TABLE "plaid_items"
  ADD COLUMN IF NOT EXISTS "consent_expiration_last_refreshed_at" timestamp with time zone;
