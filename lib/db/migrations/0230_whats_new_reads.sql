-- 0230_whats_new_reads.sql — package WN (What's new reads).
--
-- The household's "What's new" sheet stays in front of each person until they
-- press "I've read this" (owner, 2026-10-15). That press is recorded HERE, for
-- the PERSON, on the server — never in the browser — so it holds on every
-- device they use, and the owner can see "Read by <name> on <day>" or
-- "Not read yet" under each note (GET /whats-new/reads).
--
-- One row per person per note. The primary key (user_id, update_id) makes the
-- press idempotent: a repeat (two tabs, a retry) inserts nothing and keeps the
-- first read_at. user_id is the signed-in Clerk id and carries no foreign key,
-- like user_ui_preferences; the owner's report joins household_members, so a
-- removed member's reads simply stop appearing. update_id is a note id from
-- lib/avalanche-core/src/whatsNew.ts (YYYY-MM-DD, then .2 … .9).
--
-- Additive and idempotent: a new table and index, IF NOT EXISTS. No backfill
-- (the interim app's one "seen" id in user_ui_preferences is not a read).
-- Must agree column for column with `whats_new_reads` in
-- lib/db/src/schema/whatsNew.ts.
CREATE TABLE IF NOT EXISTS whats_new_reads (
  user_id text NOT NULL,
  household_id uuid NOT NULL,
  update_id text NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whats_new_reads_pkey PRIMARY KEY (user_id, update_id),
  CONSTRAINT whats_new_reads_household_id_households_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS whats_new_reads_household_idx
  ON whats_new_reads (household_id);
