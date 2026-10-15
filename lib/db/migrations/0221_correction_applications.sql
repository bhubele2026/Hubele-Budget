-- 0221_correction_applications.sql — package PREM-Q2 (a fix you can undo).
--
-- The owner applies a proposed fix (GET /review/proposals) with one tap:
-- POST /review/proposals/:key/apply files its rows and/or marks them matched
-- in ONE transaction and keeps ONE record of it here — every row's columns
-- before and after, the resolutions it created and the neighbours it
-- deleted, the review-queue decisions it answered, and the merchant memory
-- before and after — so POST /review/proposals/applied/:id/undo can put
-- every one of them back exactly, or refuse (nothing written) when a row
-- changed since.
--
-- Its own table, not `agent_actions`: that log is the agent's (every row
-- names an `agent_runs` run, NOT NULL), and a person's fix has no run.
--
-- Additive and idempotent: a new table and index, IF NOT EXISTS. No backfill.
-- Must agree column for column with `correction_applications` in
-- lib/db/src/schema/categorization.ts.
CREATE TABLE IF NOT EXISTS correction_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  proposal_key text NOT NULL,
  proposal_kind text NOT NULL,
  proposal_hash text NOT NULL,
  label text NOT NULL,
  actor_user_id text NOT NULL,
  rows jsonb NOT NULL,
  resolutions jsonb NOT NULL,
  reopened_decision_ids jsonb NOT NULL,
  memory jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  undone_by text,
  CONSTRAINT correction_applications_household_id_households_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  CONSTRAINT correction_applications_kind_check
    CHECK (proposal_kind in ('loan_payment', 'transfer', 'bill_match', 'income_category'))
);

CREATE INDEX IF NOT EXISTS correction_applications_household_created_idx
  ON correction_applications (household_id, created_at);
