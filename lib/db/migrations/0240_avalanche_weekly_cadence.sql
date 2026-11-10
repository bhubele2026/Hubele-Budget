-- 0240_avalanche_weekly_cadence.sql — package AVAL-W (weekly avalanche payments).
--
-- The household can pay the avalanche every week instead of once a month
-- (owner, 2026-11-10: "weekly is easier to maintain for avalanche payments").
--   extra_cadence  'monthly' (the month-end extra, as before) or 'weekly' (one
--                  payment on extra_weekday each week: the most the forecast
--                  says is safe above the cash buffer).
--   extra_weekday  0 = Sunday … 6 = Saturday; 5 = Friday.
-- manual_extra keeps its meaning: the MONTHLY figure (with weekly, the target
-- shown beside what the forecast can actually pay).
--
-- Additive and idempotent: two columns with defaults, ADD COLUMN IF NOT EXISTS,
-- so every existing row reads 'monthly' / 5 and the old build keeps serving
-- against the new shape. No backfill. The values are checked by the API (zod),
-- not by a constraint. Must agree column for column with `avalanche_settings`
-- in lib/db/src/schema/index.ts.
ALTER TABLE avalanche_settings ADD COLUMN IF NOT EXISTS extra_cadence text NOT NULL DEFAULT 'monthly';
ALTER TABLE avalanche_settings ADD COLUMN IF NOT EXISTS extra_weekday integer NOT NULL DEFAULT 5;
