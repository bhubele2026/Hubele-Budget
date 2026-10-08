-- 0090_recaps.sql — one drafted morning recap per member per day (package AI-4a).
--
-- Idempotent and additive: every statement is IF NOT EXISTS, so running it
-- twice (or after `drizzle-kit push` already made the table) changes nothing.
-- Must agree column for column with the `recaps` table in
-- lib/db/src/schema/recap.ts; recapsSchemaParity.integration.test.ts checks it.
-- recap_deliveries.recap_id (0100) stays a plain uuid: no FK is added to a
-- table that is already serving.

CREATE TABLE IF NOT EXISTS recaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  user_id text NOT NULL,
  for_date date NOT NULL,
  facts jsonb NOT NULL,
  text text NOT NULL,
  source text NOT NULL,
  prompt_version text,
  model text,
  status text NOT NULL DEFAULT 'drafted',
  generated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recaps_household_id_households_id_fk
    FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE,
  CONSTRAINT recaps_source_check CHECK (source in ('model', 'template')),
  CONSTRAINT recaps_status_check CHECK (status in ('drafted', 'sent', 'failed', 'skipped'))
);

CREATE UNIQUE INDEX IF NOT EXISTS recaps_user_date_uq
  ON recaps (user_id, for_date);
CREATE INDEX IF NOT EXISTS recaps_household_generated_idx
  ON recaps (household_id, generated_at);
