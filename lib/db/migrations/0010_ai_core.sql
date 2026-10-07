-- 0010_ai_core.sql — AI platform core (package AI-0).
--
-- Idempotent and additive: every statement is IF NOT EXISTS, so running it
-- twice (or after `drizzle-kit push` already made the tables) changes
-- nothing. Must agree column for column with lib/db/src/schema/ai.ts;
-- aiSchemaParity.integration.test.ts checks that.
--
-- No foreign keys on purpose (see the schema file): ai_usage is an
-- append-only cost ledger, and the other two are keyed by values that code
-- checks before any model call.

CREATE TABLE IF NOT EXISTS ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid,
  task text NOT NULL,
  model text NOT NULL,
  prompt_version text,
  run_id uuid,
  input_tokens integer,
  output_tokens integer,
  cache_write_tokens integer,
  cache_read_tokens integer,
  cost_usd numeric(10, 6),
  latency_ms integer,
  status text NOT NULL,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_household_created_idx
  ON ai_usage (household_id, created_at);

CREATE TABLE IF NOT EXISTS ai_budget (
  household_id uuid PRIMARY KEY,
  monthly_cap_usd numeric(10, 2) NOT NULL DEFAULT '25',
  hard_cap_usd numeric(10, 2) NOT NULL DEFAULT '40',
  daily_caps jsonb,
  paused_until timestamptz,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_task_config (
  task text PRIMARY KEY,
  model text,
  effort text,
  enabled boolean NOT NULL DEFAULT true,
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
