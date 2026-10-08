-- 0115_plan_adjustments.sql — a week the household chose to start lower
-- (package V5, "a way back when the week is over").
--
-- Idempotent and additive: every statement is IF NOT EXISTS, so running it twice
-- (or after `drizzle-kit push` already made the table) changes nothing. Must
-- agree column for column with `plan_adjustments` in lib/db/src/schema/money.ts;
-- weekAdjustments.integration.test.ts checks it.
--
-- amount_cents is whole cents and strictly negative: an adjustment can only
-- LOWER a week. No backfill: no household has a row until its owner chooses one.

CREATE TABLE IF NOT EXISTS plan_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  week_start date NOT NULL,
  amount_cents integer NOT NULL,
  kind text NOT NULL,
  reason text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_adjustments_household_id_households_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  CONSTRAINT plan_adjustments_household_week_kind_uq UNIQUE (household_id, week_start, kind),
  CONSTRAINT plan_adjustments_amount_negative_check CHECK (amount_cents < 0),
  CONSTRAINT plan_adjustments_kind_check CHECK (kind in ('carry_over'))
);

CREATE INDEX IF NOT EXISTS plan_adjustments_household_week_idx
  ON plan_adjustments (household_id, week_start);
