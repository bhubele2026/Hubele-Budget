-- 0030_agent_runs.sql — the agent's run log and action trail (package AI-3;
-- AI-1 reuses both tables).
--
-- Idempotent and additive: IF NOT EXISTS throughout, so a second run (or a
-- run after `drizzle-kit push` made the tables) changes nothing. Must agree
-- column for column with lib/db/src/schema/agent.ts
-- (agentSchemaParity.integration.test.ts checks that).

CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  kind text NOT NULL,
  trigger text NOT NULL,
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(10, 6),
  summary text,
  error text,
  conversation_id uuid,
  job_id text,
  -- Named as drizzle-kit names them, so a later push sees no difference.
  CONSTRAINT agent_runs_household_id_households_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  CONSTRAINT agent_runs_job_id_unique UNIQUE (job_id),
  CONSTRAINT agent_runs_kind_check
    CHECK (kind in ('chat', 'categorize', 'monitor', 'recap', 'receipt', 'sms_question')),
  CONSTRAINT agent_runs_trigger_check
    CHECK (trigger in ('user', 'txn_arrived', 'schedule', 'sms', 'retry')),
  CONSTRAINT agent_runs_status_check
    CHECK (status in ('running', 'succeeded', 'failed', 'refused', 'budget_exceeded')),
  CONSTRAINT agent_runs_summary_len_check CHECK (char_length(summary) <= 300)
);

CREATE INDEX IF NOT EXISTS agent_runs_household_started_idx
  ON agent_runs (household_id, started_at);

CREATE TABLE IF NOT EXISTS agent_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  run_id uuid NOT NULL,
  type text NOT NULL,
  target_kind text NOT NULL,
  target_id uuid,
  before jsonb,
  after jsonb,
  outcome text NOT NULL,
  reversible boolean NOT NULL DEFAULT false,
  undone_at timestamptz,
  undone_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_actions_household_id_households_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  CONSTRAINT agent_actions_run_id_agent_runs_id_fk
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
  CONSTRAINT agent_actions_type_check
    CHECK (type in ('set_category', 'remember', 'propose', 'wishlist', 'finding', 'recap')),
  CONSTRAINT agent_actions_outcome_check
    CHECK (outcome in ('applied', 'proposed', 'needs_attention'))
);

CREATE INDEX IF NOT EXISTS agent_actions_household_created_idx
  ON agent_actions (household_id, created_at);
CREATE INDEX IF NOT EXISTS agent_actions_run_idx
  ON agent_actions (run_id);
