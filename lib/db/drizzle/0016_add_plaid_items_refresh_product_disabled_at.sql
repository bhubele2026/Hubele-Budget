-- (#720) Track when a Plaid item's institution returned INVALID_PRODUCT
-- for the premium /transactions/refresh endpoint. The plaidSync hot
-- path stamps this column on the failure and then skips the refresh
-- call for 7 days, so we stop burning API quota on a doomed endpoint
-- (Chase, Amex, etc. don't have the transactions_refresh add-on
-- enabled on the Plaid Dashboard for this tenant). Manual sync still
-- falls back to /transactions/get on stale cursors, so users keep
-- seeing fresh data even with refresh suppressed.
--
-- Nullable: NULL means the refresh has never been observed to fail,
-- so the sync path will attempt it on forceRefresh syncs. Idempotent:
-- safe to re-run on databases that already have the column.

ALTER TABLE "plaid_items"
  ADD COLUMN IF NOT EXISTS "refresh_product_disabled_at" timestamp;
