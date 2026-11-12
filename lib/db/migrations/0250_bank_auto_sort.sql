-- 0250_bank_auto_sort.sql — package BANK-AUTO (bank rows arrive sorted).
--
-- New bank rows arrive already matched when H2 is sure: the auto-sort
-- (artifacts/api-server/src/lib/bankAutoSort.ts) writes a `matched` answer for
-- a row the forecast ledger paired with exactly one plan occurrence
-- unambiguously, or for the one obvious candidate no other row wants. Never a
-- partial, an ignore, or anything for an ambiguous row.
--
--   forecast_resolutions.source   'user' (a person) or 'auto' (the auto-sort).
--                                 Every existing answer is a person's: the
--                                 default fills them, no backfill needed.
--   bank_auto_match_declines      a bank row whose automatic match a person
--                                 undid or deleted: the auto-sort never matches
--                                 it again.
--
-- Additive and idempotent (ADD COLUMN / CREATE TABLE IF NOT EXISTS). Must agree
-- column for column with lib/db/src/schema/index.ts (forecast_resolutions) and
-- lib/db/src/schema/bankAutoSort.ts.
ALTER TABLE forecast_resolutions ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'user';

CREATE TABLE IF NOT EXISTS bank_auto_match_declines (
  household_id uuid NOT NULL,
  txn_id uuid NOT NULL,
  recurring_item_id text,
  occurrence_date date,
  declined_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_auto_match_declines_pkey PRIMARY KEY (household_id, txn_id),
  CONSTRAINT bank_auto_match_declines_household_id_households_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);
