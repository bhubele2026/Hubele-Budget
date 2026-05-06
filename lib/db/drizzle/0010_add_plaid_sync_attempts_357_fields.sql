-- (#357) Enriched per-attempt Plaid failure metadata so Settings →
-- Recent activity can render exactly the structured Plaid failure the
-- live sync toast renders. All optional, populated only on failure
-- rows that came from extractPlaidError().
ALTER TABLE "plaid_sync_attempts"
  ADD COLUMN IF NOT EXISTS "plaid_display_message" text,
  ADD COLUMN IF NOT EXISTS "request_id" text,
  ADD COLUMN IF NOT EXISTS "http_status" integer,
  ADD COLUMN IF NOT EXISTS "error_kind" text;
