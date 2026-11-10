-- 0241_avalanche_week_payments.sql — package AVAL-W (weekly avalanche payments).
--
-- "We paid it" on the home page and the Debt page (POST /avalanche/weekly/pay)
-- closes one week of the weekly avalanche and lowers each manual debt's balance
-- by what the week paid it. This table keeps ONE record of each press — the
-- answer it wrote and the answers that answer replaced, and per debt the
-- amount, whether the bank carries its balance, its balance, status and as-of
-- before and after, the day's history row before, and the claim transaction
-- it wrote — so POST /avalanche/weekly/pay/:id/undo can put every one of them
-- back exactly, or refuse (nothing written) when a balance changed since.
--
-- One live record per household and week (the partial unique index): a second
-- press for the same week is refused. An undone record stays as history.
--
-- Additive and idempotent: a new table and two indexes, IF NOT EXISTS. No
-- backfill. Must agree column for column with `avalanche_week_payments` in
-- lib/db/src/schema/avalancheWeekPayments.ts.
CREATE TABLE IF NOT EXISTS avalanche_week_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  week_date date NOT NULL,
  total numeric(12, 2) NOT NULL,
  resolution_id uuid NOT NULL,
  replaced jsonb NOT NULL,
  debts jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  undone_by text,
  CONSTRAINT avalanche_week_payments_household_id_households_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS avalanche_week_payments_household_created_idx
  ON avalanche_week_payments (household_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS avalanche_week_payments_live_week_uq
  ON avalanche_week_payments (household_id, week_date)
  WHERE undone_at IS NULL;
