-- (#262) Tracks which (plaid_item, consent cutoff) pairs we have already
-- emailed an "about to disconnect" reminder for so the daily sweep does
-- not spam the same user every morning while an item sits inside the
-- alert window. Same cutoff = already notified; a re-consent that
-- pushes the cutoff out falls naturally outside the alert window so
-- silence after re-consent is automatic.
--
-- Idempotent: safe to run on databases that already have the table.

CREATE TABLE IF NOT EXISTS "plaid_consent_reminders_sent" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "plaid_item_id" uuid NOT NULL REFERENCES "plaid_items"("id") ON DELETE CASCADE,
  "cutoff_sent_for" timestamp with time zone NOT NULL,
  "channel" text NOT NULL,
  "recipient" text,
  "sent_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "plaid_consent_reminders_sent_item_cutoff_uq"
  ON "plaid_consent_reminders_sent" ("plaid_item_id", "cutoff_sent_for");

CREATE INDEX IF NOT EXISTS "plaid_consent_reminders_sent_user_idx"
  ON "plaid_consent_reminders_sent" ("user_id");
