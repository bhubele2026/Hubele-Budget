-- Additive migration: introduces an "owed by" tag on transactions so each
-- reimbursable charge can record who is going to pay it back.
--
-- Safe to run on databases that already have the column (e.g. created via
-- drizzle-kit push). The statement uses IF NOT EXISTS so this migration is
-- idempotent.

ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "owed_by" text;
