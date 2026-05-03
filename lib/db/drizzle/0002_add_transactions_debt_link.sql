-- Additive migration: link transactions to debts so the dashboard can count
-- ALL debt payments (Plaid-imported, manually-entered, etc.) toward progress
-- rather than relying on a "Payment — " description-prefix heuristic.
--
-- Idempotent: safe to run on databases that already have the column/index.

ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "debt_id" uuid;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "transactions"
    ADD CONSTRAINT "transactions_debt_id_debts_id_fk"
    FOREIGN KEY ("debt_id") REFERENCES "public"."debts"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "transactions_debt_idx"
  ON "transactions" USING btree ("user_id", "debt_id");
--> statement-breakpoint

-- Backfill A: tie existing manually-logged debt payments (created by
-- POST /debts/:id/payments) to their debt by matching the description
-- convention "Payment — <debt name>" or "Payment — <debt name> (PAID OFF)".
-- We only backfill rows that are not already linked and have amount < 0.
UPDATE "transactions" AS t
SET "debt_id" = d.id
FROM "debts" AS d
WHERE t."debt_id" IS NULL
  AND t."user_id" = d."user_id"
  AND t."amount" < 0
  AND (
    t."description" = 'Payment — ' || d."name"
    OR t."description" = 'Payment — ' || d."name" || ' (PAID OFF)'
  );
--> statement-breakpoint

-- Backfill B: tie existing Plaid-imported transactions to a debt when their
-- plaid_account_id matches the Plaid account that the debt is linked to AND
-- the transaction is a balance-reducing payment, not a purchase.
--
-- Sign convention: Plaid uses positive=debit/charge for liability accounts;
-- our app flips the sign (`amount = -Plaid.amount`), so PAYMENTS appear as
-- POSITIVE amounts in our `transactions` table and purchases as negative.
-- We must only link payments — linking purchases would make the dashboard
-- mistakenly count new debt as "paid off".
UPDATE "transactions" AS t
SET "debt_id" = d.id
FROM "debts" AS d
JOIN "plaid_accounts" AS pa ON pa.id = d.plaid_account_id
WHERE t."debt_id" IS NULL
  AND t."user_id" = d."user_id"
  AND t."plaid_account_id" IS NOT NULL
  AND t."plaid_account_id" = pa."account_id"
  AND t."amount" > 0;
