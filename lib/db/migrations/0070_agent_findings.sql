-- 0070_agent_findings.sql — what the proactive monitor noticed (package AI-3).
--
-- Idempotent and additive. Must agree column for column with
-- lib/db/src/schema/agent.ts (agentSchemaParity.integration.test.ts).

CREATE TABLE IF NOT EXISTS agent_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  kind text NOT NULL,
  dedupe_key text NOT NULL,
  severity text NOT NULL,
  confidence text NOT NULL,
  payload jsonb NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  dismissed_at timestamptz,
  surfaced_in_recap_id uuid,
  CONSTRAINT agent_findings_household_id_households_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  CONSTRAINT agent_findings_kind_check
    CHECK (kind in ('bill_increase', 'category_acceleration', 'shortfall_before_income', 'duplicate_charge', 'goal_behind', 'limit_near', 'bank_stale')),
  CONSTRAINT agent_findings_severity_check CHECK (severity in ('info', 'watch', 'high')),
  CONSTRAINT agent_findings_confidence_check CHECK (confidence in ('estimate', 'confirmed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_findings_household_dedupe_uq
  ON agent_findings (household_id, dedupe_key);
CREATE INDEX IF NOT EXISTS agent_findings_household_seen_idx
  ON agent_findings (household_id, last_seen);
