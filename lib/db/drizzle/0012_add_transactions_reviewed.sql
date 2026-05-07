-- (#484) Add the `reviewed` flag on transactions so users can mark a
-- row as done after categorizing it on the Amex page. The UI greys
-- reviewed rows out so the eye skips over them and focuses on what's
-- left to handle. Defaults to false; existing rows are unreviewed.
--
-- Idempotent: safe to run on databases that already have the column.
ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "reviewed" boolean NOT NULL DEFAULT false;
