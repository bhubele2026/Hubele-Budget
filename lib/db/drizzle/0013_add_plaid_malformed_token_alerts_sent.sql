-- (#396) De-dup state for the daily malformed-token operator alert
-- (#371). Without this, a config-level breakage that takes a few days
-- to fully clean up re-pages operators every morning until `flagged`
-- drops back below the threshold. Each row is the fingerprint of an
-- alert that actually went out (digest of sorted flagged item_row_ids
-- + the raw set + counts) so the next morning's sweep can short-
-- circuit when the spike is the same — and re-arm when additional
-- items appear or the count grows day-over-day.
--
-- Idempotent: safe to run on databases that already have the table.

CREATE TABLE IF NOT EXISTS "plaid_malformed_token_alerts_sent" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "sent_at" timestamp with time zone DEFAULT now() NOT NULL,
  "flagged" integer NOT NULL,
  "scanned" integer NOT NULL,
  "threshold" integer NOT NULL,
  "digest" text NOT NULL,
  "flagged_item_row_ids" jsonb NOT NULL,
  "channel" text NOT NULL,
  "recipient" text
);

CREATE INDEX IF NOT EXISTS "plaid_malformed_token_alerts_sent_sent_at_idx"
  ON "plaid_malformed_token_alerts_sent" ("sent_at");
