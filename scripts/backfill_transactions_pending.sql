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
-- `pending = FALSE` guard.
UPDATE transactions
SET pending = TRUE
WHERE notes = '[pending]'
  AND pending = FALSE;

-- Step 2: strip the legacy marker from notes. Only touches rows whose
-- notes column is exactly the marker string (the historical write
-- pattern in plaidSync) so we never accidentally clobber a user-typed
-- note that happens to mention the word "pending".
UPDATE transactions
SET notes = NULL
WHERE notes = '[pending]';
