-- Additive migration: per-occurrence reschedule override on
-- forecast_resolutions. When a resolution row has status = 'rescheduled',
-- `rescheduled_to` carries the new ISO date. The forecast projector swaps
-- the original occurrence onto this date and the API enforces that the
-- new date is strictly after the original occurrence date.
--
-- Idempotent: safe to run on databases that already have the column.

ALTER TABLE "forecast_resolutions"
  ADD COLUMN IF NOT EXISTS "rescheduled_to" date;
