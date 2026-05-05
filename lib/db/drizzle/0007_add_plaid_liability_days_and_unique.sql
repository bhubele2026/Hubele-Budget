-- (#44) Day-of-month fields cached from Plaid liabilities so the
-- post-Link "Add as debts" dialog can pre-fill due/statement day for
-- credit / student / mortgage accounts. Both are nullable since not
-- every Plaid product/institution returns the underlying ISO dates.
ALTER TABLE "plaid_accounts"
  ADD COLUMN IF NOT EXISTS "liability_due_day" integer;--> statement-breakpoint
ALTER TABLE "plaid_accounts"
  ADD COLUMN IF NOT EXISTS "liability_statement_day" integer;--> statement-breakpoint

-- (#44) Race-safe guarantee that a Plaid account is linked to at most
-- one debt row. The non-Plaid debts (plaid_account_id IS NULL) are
-- unaffected by the partial WHERE clause.
CREATE UNIQUE INDEX IF NOT EXISTS "debts_plaid_account_unique"
  ON "debts" ("plaid_account_id")
  WHERE "plaid_account_id" IS NOT NULL;
