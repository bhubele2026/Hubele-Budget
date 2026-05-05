-- (#265) Latest /item/get failure captured during the
-- consent_expiration refresh path (manual "Refresh disconnect dates"
-- button, on-sync PENDING_EXPIRATION refresh, or daily cron).
-- Cleared on the next successful refresh. Settings → Linked Accounts
-- renders this inline under the per-item "Disconnect date checked …"
-- line so a user who walks away after running the refresh can still
-- see *why* this bank's check failed without having to re-trigger it.
-- Distinct from `last_sync_error` so a healthy /transactions/sync does
-- not erase the consent-refresh failure (and vice versa).
--
-- Idempotent: safe to run on databases that already have the columns.

ALTER TABLE "plaid_items"
  ADD COLUMN IF NOT EXISTS "consent_expiration_last_refresh_error" text;

ALTER TABLE "plaid_items"
  ADD COLUMN IF NOT EXISTS "consent_expiration_last_refresh_error_code" text;
