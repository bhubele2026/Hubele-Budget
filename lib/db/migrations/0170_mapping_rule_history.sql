-- 0170_mapping_rule_history.sql — financial consistency WP5b (rule audit).
--
-- A mapping rule decides where every matching charge is filed, and until now a
-- rule could be re-pointed, re-ordered or deleted without leaving a trace. Two
-- additions:
--
--   * `mapping_rules.updated_at`: when the rule was last edited directly (its
--     pattern, match type, category or priority). NULL = not edited since this
--     history began. A reorder is recorded in the history below but does not
--     count as an edit, so one drag does not mark every rule in the list.
--   * `mapping_rule_history`: one row per change, with the rule before
--     (`previous`) and after (`next`) as {pattern, matchType, categoryId,
--     priority}, who made it (`actor`: a user id, 'seed', 'script:<name>' or
--     'system') and an optional note saying why.
--
-- `rule_id` deliberately has no foreign key: a deleted rule keeps its history.
--
-- Idempotent and additive: every statement is IF NOT EXISTS, so it is safe
-- where `drizzle-kit push` already built these objects. No backfill: existing
-- rules keep updated_at NULL and the history starts empty. Must agree column
-- for column with `mappingRulesTable` (lib/db/src/schema/index.ts) and
-- `mappingRuleHistoryTable` (lib/db/src/schema/categorization.ts); the
-- schemaMigrations integration test replays this file and compares them.

ALTER TABLE mapping_rules
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

CREATE TABLE IF NOT EXISTS mapping_rule_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  action text NOT NULL,
  actor text NOT NULL,
  previous jsonb,
  next jsonb,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mapping_rule_history_household_id_households_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  CONSTRAINT mapping_rule_history_action_ck
    CHECK (action IN ('created', 'updated', 'deleted', 'reordered', 'seeded'))
);

CREATE INDEX IF NOT EXISTS mapping_rule_history_rule_idx
  ON mapping_rule_history (household_id, rule_id, created_at);
