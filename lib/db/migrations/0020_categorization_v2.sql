-- PR-A · categorization engine v2
--
-- Decisions (what the engine or a person decided, why, how sure), merchant
-- memory (what corrections taught it), transaction splits (a charge split
-- across categories that survives Plaid upserts), and four transaction
-- columns. Additive and idempotent: safe where `drizzle-kit push` already
-- built these objects. No backfill: every new column starts at its default.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS category_provisional boolean NOT NULL DEFAULT false;
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS refund_of_txn_id uuid;
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS plaid_removed_at timestamptz;
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS splits_invalid boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS category_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  source text NOT NULL,
  category_id uuid,
  previous_category_id uuid,
  confidence numeric(4,3) NOT NULL,
  band text NOT NULL,
  explanation text NOT NULL,
  rule_id uuid,
  memory_id uuid,
  recurring_item_id uuid,
  model text,
  prompt_version text,
  input_hash text NOT NULL,
  resolved_at timestamptz,
  resolved_by text,
  resolution text,
  undone_at timestamptz,
  created_memory_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT category_decisions_source_ck CHECK (source IN ('locked','rule','memory','recurring','inherited','heuristic','model','user','refund')),
  CONSTRAINT category_decisions_band_ck CHECK (band IN ('auto','provisional','queue')),
  CONSTRAINT category_decisions_resolution_ck CHECK (resolution IS NULL OR resolution IN ('accepted','corrected','skipped'))
);
CREATE UNIQUE INDEX IF NOT EXISTS category_decisions_txn_hash_uq
  ON category_decisions (transaction_id, input_hash);
CREATE INDEX IF NOT EXISTS category_decisions_open_idx
  ON category_decisions (household_id, band)
  WHERE resolved_at IS NULL AND undone_at IS NULL;
CREATE INDEX IF NOT EXISTS category_decisions_txn_created_idx
  ON category_decisions (transaction_id, created_at);

CREATE TABLE IF NOT EXISTS merchant_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  signature text NOT NULL,
  scope text NOT NULL,
  plaid_account_id text,
  amount_band_lo numeric(12,2),
  amount_band_hi numeric(12,2),
  category_id uuid NOT NULL,
  count integer NOT NULL DEFAULT 1,
  last_confirmed_at timestamptz,
  learned_from_txn_id uuid,
  source text NOT NULL DEFAULT 'user',
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merchant_memory_scope_ck CHECK (scope IN ('merchant','merchant_account','merchant_amount'))
);
CREATE UNIQUE INDEX IF NOT EXISTS merchant_memory_key_uq
  ON merchant_memory (household_id, signature, scope, coalesce(plaid_account_id, ''), coalesce(amount_band_lo, 0));
CREATE INDEX IF NOT EXISTS merchant_memory_household_signature_idx
  ON merchant_memory (household_id, signature);

CREATE TABLE IF NOT EXISTS transaction_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL,
  member text,
  note text,
  source text NOT NULL DEFAULT 'user',
  user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transaction_splits_source_ck CHECK (source IN ('user','receipt','model'))
);
CREATE INDEX IF NOT EXISTS transaction_splits_txn_idx
  ON transaction_splits (transaction_id);
