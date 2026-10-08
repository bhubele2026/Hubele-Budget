-- 0080_goals.sql — savings goals, money reserved in checking, the buffer goal
-- (package PR-C).
--
-- Idempotent and additive: every statement is IF NOT EXISTS, so running it twice
-- (or after `drizzle-kit push` already made the table) changes nothing. Must
-- agree column for column with `goals` in lib/db/src/schema/goals.ts;
-- goals.integration.test.ts checks it.

CREATE TABLE IF NOT EXISTS goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  name text NOT NULL,
  kind text NOT NULL,
  target_amount numeric(12, 2),
  manual_current_amount numeric(12, 2) NOT NULL DEFAULT '0',
  plaid_account_id uuid,
  monthly_contribution numeric(12, 2) NOT NULL DEFAULT '0',
  target_date date,
  reserved_in_checking boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT goals_household_id_households_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  CONSTRAINT goals_plaid_account_id_plaid_accounts_id_fk
    FOREIGN KEY (plaid_account_id) REFERENCES plaid_accounts(id) ON DELETE SET NULL,
  CONSTRAINT goals_kind_check CHECK (kind in ('savings', 'buffer', 'sinking', 'debt_payoff')),
  CONSTRAINT goals_status_check CHECK (status in ('active', 'paused', 'reached', 'archived'))
);

CREATE INDEX IF NOT EXISTS goals_household_status_idx
  ON goals (household_id, status);
