-- (#762 — Phase B) Manual Send-to-Review gate. NULL = the row has not
-- been promoted into the Review workflow yet; a timestamp = the moment
-- the user clicked "Send to Review". Source-of-truth views
-- (Chase / Amex / GET /transactions) keep showing every row; only the
-- Review pipeline on /forecast filters on this column. Backfill of
-- historical rows (the grandfather pass) is deferred to a follow-up
-- task so the gate can be exercised in production in isolation first.
--
-- Idempotent: safe to run on databases that already have the column
-- (the table was first picked up by an earlier `drizzle-kit push` in
-- this same task).

ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "sent_to_review_at" timestamp with time zone;
