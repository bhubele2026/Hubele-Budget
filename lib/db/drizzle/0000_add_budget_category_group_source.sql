-- Additive migration: introduces grouping/source metadata on budget_categories
-- and a uniqueness guarantee for budget_lines per (user, month, category).
--
-- Safe to run on databases that already have the base schema (created via
-- drizzle-kit push). All statements use IF NOT EXISTS so this migration is
-- idempotent and will not conflict with existing tables/columns/indexes.

ALTER TABLE "budget_categories"
  ADD COLUMN IF NOT EXISTS "group_name" text NOT NULL DEFAULT 'Other';
--> statement-breakpoint

ALTER TABLE "budget_categories"
  ADD COLUMN IF NOT EXISTS "source_kind" text NOT NULL DEFAULT 'manual';
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "budget_lines_user_month_cat_uq"
  ON "budget_lines" USING btree ("user_id", "month_start", "category_id");
