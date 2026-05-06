-- (#361) First-sync dedupe gate for newly linked Plaid accounts. The
-- cutoff defaults to the latest manual / imported transaction Plaid
-- might overlap with at link time; the first sync skips inserts at or
-- before that date and tries a ±7-day merge with unattached manual rows
-- to attach `plaid_transaction_id` instead of duplicating. The
-- completion timestamp is stamped at the end of the first successful
-- /transactions/sync for this account, after which the gate is off and
-- subsequent cursor-based syncs behave exactly as before.
--
-- Idempotent: safe to run on databases that already have the columns.

ALTER TABLE "plaid_accounts"
  ADD COLUMN IF NOT EXISTS "import_cutoff_date" date;

ALTER TABLE "plaid_accounts"
  ADD COLUMN IF NOT EXISTS "first_sync_completed_at" timestamp with time zone;
