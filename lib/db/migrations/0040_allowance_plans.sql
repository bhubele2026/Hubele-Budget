-- PR-B1 · allowance_plans — the everyday spending caps, one row per period.
--
-- member_user_id NULL is the household's shared pool; a member's Clerk id is
-- that member's own allowance (none are written yet). A row is in effect from
-- effective_from. Mirrors `allowancePlansTable` in lib/db/src/schema/index.ts
-- name for name, so `drizzle-kit push` (dev, tests) and this file (production)
-- build the same table. Idempotent: safe to run any number of times.
CREATE TABLE IF NOT EXISTS allowance_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  member_user_id text,
  period text NOT NULL,
  amount numeric(12, 2) NOT NULL,
  effective_from date NOT NULL,
  source text NOT NULL,
  derivation jsonb,
  created_by_kind text NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Named as drizzle-kit names it, so a later push sees no difference.
  CONSTRAINT allowance_plans_household_id_households_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  CONSTRAINT allowance_plans_period_check CHECK (period in ('weekly', 'monthly')),
  CONSTRAINT allowance_plans_source_check CHECK (source in ('owner', 'derived')),
  -- No job or agent may write a plan: only a person, through the owner route.
  CONSTRAINT allowance_plans_created_by_kind_check CHECK (created_by_kind = 'user')
);

CREATE INDEX IF NOT EXISTS allowance_plans_household_idx
  ON allowance_plans (household_id);

-- One plan per household, member (or the shared pool), period and start date.
CREATE UNIQUE INDEX IF NOT EXISTS allowance_plans_household_member_period_from_uq
  ON allowance_plans (household_id, (coalesce("member_user_id", '')), period, effective_from);

-- Backfill: the owner's standing allowances become the household pool's plans,
-- in effect from 2026-05-01 (when the household started tracking). One weekly
-- and one monthly row per household whose owner set a non-zero amount; a zero
-- amount means no plan was ever set, so no row is written for it (the money
-- position then reports "no weekly cap" instead of "over a $0 cap"). Both
-- `everydayPlan(settings)` and `everydayPlanFromRows(plans)` read 0 for that
-- household, so they agree. ON CONFLICT DO NOTHING: running this again, or
-- after the owner edited a backfilled row, writes nothing.
INSERT INTO allowance_plans (household_id, member_user_id, period, amount, effective_from, source)
SELECT h.id, NULL, 'weekly', s.weekly_allowance_amount, DATE '2026-05-01', 'owner'
  FROM settings s
  JOIN households h ON h.owner_user_id = s.user_id
 WHERE s.weekly_allowance_amount <> 0
ON CONFLICT DO NOTHING;

INSERT INTO allowance_plans (household_id, member_user_id, period, amount, effective_from, source)
SELECT h.id, NULL, 'monthly', s.monthly_allowance_amount, DATE '2026-05-01', 'owner'
  FROM settings s
  JOIN households h ON h.owner_user_id = s.user_id
 WHERE s.monthly_allowance_amount <> 0
ON CONFLICT DO NOTHING;
