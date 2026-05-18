-- Task #728 — Backfill the new `transactions.pending` boolean column from
-- the legacy `notes='[pending]'` marker the Plaid sync used to write, then
-- strip the marker out of `notes` so it stops colliding with user-typed
-- notes. Idempotent: safe to re-run on databases where every row has
-- already been backfilled (the WHERE clauses skip the no-op rows).
--
-- Step 1: stamp pending=true for every row whose notes column still
-- carries the legacy marker. Plaid sync from #728 onward writes the
-- boolean directly, so newly-inserted pending rows already have
-- pending=true and notes IS NULL — those rows are skipped by the
-- `pending = FALSE` guard. Match is case-insensitive and substring
-- (`ILIKE '%[pending]%'`) so any historical row that ended up with
-- a user-typed prefix/suffix around the marker still gets migrated
-- — the task narrative explicitly calls out this broader predicate
-- to make sure no pending rows are left invisible after rollout.
UPDATE transactions
SET pending = TRUE
WHERE notes ILIKE '%[pending]%'
  AND pending = FALSE;

-- Step 2: strip the legacy marker from notes. We surgically remove
-- only the `[pending]` token (case-insensitive) and collapse any
-- whitespace it leaves behind, so a user-typed note like
-- "[pending] reimburse from work" becomes "reimburse from work"
-- instead of being nulled out wholesale. Rows whose notes was
-- exactly the marker collapse to an empty string, which we then
-- normalize to NULL so the field returns to clean free-text.
UPDATE transactions
SET notes = NULLIF(
  btrim(regexp_replace(notes, '\[pending\]', '', 'gi')),
  ''
)
WHERE notes ILIKE '%[pending]%';
