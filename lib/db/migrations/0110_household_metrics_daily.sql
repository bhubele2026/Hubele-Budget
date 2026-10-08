-- 0110_household_metrics_daily.sql — one row of progress metrics per household
-- per day (package PR-E, the nightly `metrics.snapshot` job).
--
-- Idempotent and additive: every statement is IF NOT EXISTS, so running it twice
-- (or after `drizzle-kit push` already made the table) changes nothing. Must
-- agree column for column with `household_metrics_daily` in
-- lib/db/src/schema/metrics.ts; metricsSchemaParity.integration.test.ts checks it.

CREATE TABLE IF NOT EXISTS household_metrics_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  as_of date NOT NULL,
  version integer NOT NULL DEFAULT 1,
  metrics jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT household_metrics_daily_household_id_households_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS household_metrics_daily_household_as_of_uq
  ON household_metrics_daily (household_id, as_of);
