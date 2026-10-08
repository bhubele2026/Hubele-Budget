-- 0060_debt_plan.sql — the debt plan (package PR-D).
--
-- Idempotent and additive: every statement is IF NOT EXISTS (or guarded), so
-- running it twice, or after `drizzle-kit push` already made the objects,
-- changes nothing. Must agree column for column with
-- lib/db/src/schema/debt.ts and the two transactions columns in
-- lib/db/src/schema/index.ts (schemaMigrations.integration.test.ts replays it).
--
-- No backfill: payments logged before this release keep payment_state NULL
-- and are not claims (see the review note for why).

-- ── Planned vs confirmed: a payment logged in the app is a CLAIM ──────────
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_state text;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS confirmed_by_txn_id uuid
  CONSTRAINT transactions_confirmed_by_txn_id_transactions_id_fk
  REFERENCES transactions(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'transactions_payment_state_check'
       AND conrelid = 'transactions'::regclass
  ) THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_payment_state_check
      CHECK (payment_state IS NULL OR payment_state IN ('claimed', 'confirmed'));
  END IF;
END $$;

-- One bank row confirms at most one claim.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_confirmed_by_txn_uq
  ON transactions (confirmed_by_txn_id) WHERE confirmed_by_txn_id IS NOT NULL;

-- ── Milestones reached (insert-only) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS debt_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL
    CONSTRAINT debt_milestones_household_id_households_id_fk
    REFERENCES households(id) ON DELETE CASCADE,
  debt_id uuid
    CONSTRAINT debt_milestones_debt_id_debts_id_fk
    REFERENCES debts(id) ON DELETE SET NULL,
  key text NOT NULL,
  label text NOT NULL,
  achieved_on date NOT NULL,
  evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS debt_milestones_household_key_uq
  ON debt_milestones (household_id, key);

-- ── Statement facts (Plaid liabilities, or typed in) ──────────────────────
CREATE TABLE IF NOT EXISTS debt_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL
    CONSTRAINT debt_statements_household_id_households_id_fk
    REFERENCES households(id) ON DELETE CASCADE,
  debt_id uuid NOT NULL
    CONSTRAINT debt_statements_debt_id_debts_id_fk
    REFERENCES debts(id) ON DELETE CASCADE,
  statement_date date NOT NULL,
  statement_balance numeric(12, 2),
  min_payment numeric(12, 2),
  due_date date,
  source text NOT NULL
    CONSTRAINT debt_statements_source_check CHECK (source IN ('plaid', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS debt_statements_debt_date_uq
  ON debt_statements (debt_id, statement_date);
CREATE INDEX IF NOT EXISTS debt_statements_household_idx
  ON debt_statements (household_id);

-- ── The liability ledger: each card/loan row, classified ──────────────────
CREATE TABLE IF NOT EXISTS debt_ledger_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL
    CONSTRAINT debt_ledger_events_household_id_households_id_fk
    REFERENCES households(id) ON DELETE CASCADE,
  debt_id uuid NOT NULL
    CONSTRAINT debt_ledger_events_debt_id_debts_id_fk
    REFERENCES debts(id) ON DELETE CASCADE,
  transaction_id uuid
    CONSTRAINT debt_ledger_events_transaction_id_transactions_id_fk
    REFERENCES transactions(id) ON DELETE CASCADE,
  kind text NOT NULL
    CONSTRAINT debt_ledger_events_kind_check
    CHECK (kind IN ('interest', 'fee', 'payment', 'charge', 'credit')),
  amount numeric(12, 2) NOT NULL,
  occurred_on date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS debt_ledger_events_transaction_uq
  ON debt_ledger_events (transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS debt_ledger_events_debt_day_idx
  ON debt_ledger_events (debt_id, occurred_on);
CREATE INDEX IF NOT EXISTS debt_ledger_events_household_idx
  ON debt_ledger_events (household_id, occurred_on);

-- ── Daily progress per debt (upserted; re-running a day changes nothing) ──
CREATE TABLE IF NOT EXISTS debt_progress_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL
    CONSTRAINT debt_progress_snapshots_household_id_households_id_fk
    REFERENCES households(id) ON DELETE CASCADE,
  debt_id uuid NOT NULL
    CONSTRAINT debt_progress_snapshots_debt_id_debts_id_fk
    REFERENCES debts(id) ON DELETE CASCADE,
  as_of date NOT NULL,
  balance_effective numeric(12, 2) NOT NULL,
  delta numeric(12, 2) NOT NULL,
  payments_confirmed numeric(12, 2) NOT NULL,
  interest numeric(12, 2) NOT NULL,
  fees numeric(12, 2) NOT NULL,
  new_charges numeric(12, 2) NOT NULL,
  credits numeric(12, 2) NOT NULL DEFAULT '0',
  unexplained numeric(12, 2) NOT NULL,
  transfer_pair_txn_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS debt_progress_snapshots_debt_day_uq
  ON debt_progress_snapshots (debt_id, as_of);
CREATE INDEX IF NOT EXISTS debt_progress_snapshots_household_idx
  ON debt_progress_snapshots (household_id, as_of);
