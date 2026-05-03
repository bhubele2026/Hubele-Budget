-- Additive migration: add optional occurred_at timestamp on transactions so
-- Plaid sync and CSV imports can store the real time-of-day when available.
-- Used by the Reports → Behavior & Fun hourly spending clock (Task #49).
--
-- Idempotent: safe to run on databases that already have the column.

ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "occurred_at" timestamp with time zone;
