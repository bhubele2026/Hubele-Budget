-- (#474) Add the `exclude_from_budget` flag on budget_categories so the
-- system-managed "Uncategorized" category can exist as a real picker
-- option for transactions while staying out of every Budget page total
-- (planned, actual, group, summary). Mapping rules cannot target it.
--
-- Idempotent: safe to run on databases that already have the column.
ALTER TABLE "budget_categories"
  ADD COLUMN IF NOT EXISTS "exclude_from_budget" boolean NOT NULL DEFAULT false;
