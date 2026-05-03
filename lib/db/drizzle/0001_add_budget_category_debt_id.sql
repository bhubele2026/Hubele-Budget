-- Adds an optional debt_id link on budget_categories so auto_debts category
-- rows can be tied 1:1 to a row in the debts table, and removed automatically
-- when their debt is deleted. Idempotent and safe to re-run.

ALTER TABLE "budget_categories"
  ADD COLUMN IF NOT EXISTS "debt_id" uuid;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'budget_categories_debt_id_fk'
  ) THEN
    ALTER TABLE "budget_categories"
      ADD CONSTRAINT "budget_categories_debt_id_fk"
      FOREIGN KEY ("debt_id") REFERENCES "debts"("id") ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "budget_categories_user_debt_uq"
  ON "budget_categories" USING btree ("user_id", "debt_id");
--> statement-breakpoint

-- Retire the legacy placeholder/static auto_debts seed rows so the next
-- GET /budget/months/:monthStart will rebuild them from the live Debts tracker.
DELETE FROM "budget_categories"
  WHERE "source_kind" = 'auto_debts' AND "debt_id" IS NULL;
