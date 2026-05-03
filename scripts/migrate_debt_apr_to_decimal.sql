-- APR data migration: percentage-form → decimal form.
--
-- Historically the avalanche/debts UI and importers stored APR as a *raw
-- percentage* (e.g. 24.99 for a 24.99% card). The simulator and Plaid
-- ingestion pipeline both interpret APR as a *decimal* (0.2499). Anything
-- ≥ 1.0 was therefore being treated as 100%+ APR, making the simulator
-- return ∞ for every debt.
--
-- This migration is idempotent: any APR < 1.0 is already in decimal form
-- and is left alone. Only the legacy percentage rows (≥ 1.0) get divided.
UPDATE debts SET apr = apr / 100 WHERE apr >= 1.0;

-- Belt-and-braces: enforce the decimal contract at the DB level so any
-- future writer (direct SQL, new importer, etc.) can't reintroduce the
-- percentage-shaped APR bug. Idempotent via DO/EXCEPTION.
DO $$
BEGIN
  ALTER TABLE debts ADD CONSTRAINT debts_apr_decimal_chk CHECK (apr >= 0 AND apr < 1);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
