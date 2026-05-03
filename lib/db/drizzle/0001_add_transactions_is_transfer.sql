-- Additive migration: add is_transfer flag on transactions so bank/card payments
-- and ODP/transfer rows can be excluded from budget actuals (Task #42).
ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "is_transfer" boolean NOT NULL DEFAULT false;
