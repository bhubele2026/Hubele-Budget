-- 0050_ask_agent.sql — Ask: conversations, proposals, memory, wish list
-- (package AI-2). Additive and idempotent; must agree column for column with
-- lib/db/src/schema/agent.ts (askAgentSchemaParity.integration.test.ts).

CREATE TABLE IF NOT EXISTS agent_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  user_id text NOT NULL,
  title text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_conversations_household_id_households_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS agent_conversations_household_user_idx
  ON agent_conversations (household_id, user_id, last_message_at);

CREATE TABLE IF NOT EXISTS agent_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  role text NOT NULL,
  content jsonb NOT NULL,
  run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_messages_conversation_id_agent_conversations_id_fk
    FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE,
  CONSTRAINT agent_messages_role_check CHECK (role in ('user', 'assistant', 'tool'))
);
CREATE INDEX IF NOT EXISTS agent_messages_conversation_created_idx
  ON agent_messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS agent_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  run_id uuid NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  rationale text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'proposed',
  decided_by text,
  decided_at timestamptz,
  applied_action_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_proposals_household_id_households_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  CONSTRAINT agent_proposals_run_id_agent_runs_id_fk
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
  CONSTRAINT agent_proposals_kind_check
    CHECK (kind in ('set_category', 'weekly_limit', 'budget_line', 'extra_debt_payment', 'bill_amount')),
  CONSTRAINT agent_proposals_status_check
    CHECK (status in ('proposed', 'approved', 'rejected', 'applied', 'expired'))
);
CREATE INDEX IF NOT EXISTS agent_proposals_household_status_idx
  ON agent_proposals (household_id, status, created_at);

CREATE TABLE IF NOT EXISTS agent_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  member_user_id text,
  scope text NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL,
  source text NOT NULL,
  created_by_kind text NOT NULL,
  created_by_user_id text,
  evidence_txn_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  confidence numeric(4, 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT agent_memory_household_id_households_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  CONSTRAINT agent_memory_scope_check
    CHECK (scope in ('categorization', 'spending', 'debt', 'general')),
  CONSTRAINT agent_memory_source_check
    CHECK (source in ('user_stated', 'inferred', 'agent_proposed')),
  CONSTRAINT agent_memory_created_by_kind_check
    CHECK (created_by_kind in ('user', 'agent'))
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_memory_household_member_scope_key_uq
  ON agent_memory (household_id, coalesce(member_user_id, ''), scope, key);

CREATE TABLE IF NOT EXISTS wishlist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  title text NOT NULL,
  amount numeric(12, 2),
  url text,
  category_id uuid,
  target_date date,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  waiting_until date NOT NULL,
  decision text NOT NULL DEFAULT 'pending',
  decided_at timestamptz,
  last_evaluation jsonb,
  CONSTRAINT wishlist_items_household_id_households_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  CONSTRAINT wishlist_items_decision_check
    CHECK (decision in ('pending', 'approved', 'declined', 'bought'))
);
CREATE INDEX IF NOT EXISTS wishlist_items_household_idx
  ON wishlist_items (household_id, requested_at);
