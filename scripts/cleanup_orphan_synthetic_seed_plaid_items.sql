-- Task #710 — manual cleanup for the synthetic Chase seed placeholder
-- row spawned by `aprilChaseSeed.ts` (SYNTHETIC_ITEM_ID =
-- "seed-april-2026-chase"). That row is not a real Plaid connection:
-- it exists only so the dashboard bank-snapshot tile has a stable
-- foreign-key target before the user has completed real Plaid OAuth.
--
-- Once the user does link a real Chase item, the synthetic row is
-- left behind. Until Task #710 patched `remediate_plaid_env_mismatch.sql`,
-- that script would also stamp the synthetic row with
-- INVALID_ACCESS_TOKEN every time it ran (because its placeholder
-- token starts with `access-sandbox-…` and the prod env wants
-- `access-production-…`). The reauth banner + Connect-a-bank guard
-- would then surface "Chase needs reconnect" forever, even though the
-- user's real Chase item is healthy. The UI now filters synthetic
-- rows out, but operators still want a way to physically delete the
-- ghost row so it doesn't keep tripping future debugging sessions.
--
-- INVOCATION (manual; not wired into post-merge.sh — see review feedback
-- on the sibling cleanup_orphan_duplicate_plaid_items.sql script):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v household_id='<the-affected-household-uuid>' \
--     -f scripts/cleanup_orphan_synthetic_seed_plaid_items.sql
--
-- The `:'household_id'` variable is REQUIRED. Without it the script
-- aborts — we deliberately refuse to run global cleanup across every
-- household because a household that hasn't yet linked the real Chase
-- item legitimately needs the placeholder to back the snapshot tile.
--
-- Safety guards — a candidate is deleted ONLY when:
--   0. It belongs to the supplied household_id.
--   1. Its item_id begins with `seed-` (matches the SYNTHETIC_ITEM_ID
--      family in aprilChaseSeed.ts). Real Plaid item ids never have
--      this prefix.
--   2. Its cursor is NULL or empty — i.e. /transactions/sync has never
--      successfully staged rows against it.
--   3. None of its plaid_accounts own any transactions. Combined with
--      guard #2 this guarantees deleting the row strands zero data.
--
-- Idempotent — once the row is gone the next run is a no-op. Wrapped
-- in a transaction so a partial accounts-delete can't leave dangling
-- rows.

\set ON_ERROR_STOP on

-- Hard-stop if the operator forgot to pass -v household_id=...
-- (psql substitutes the empty string when the var is unset).
SELECT CASE
  WHEN :'household_id' = '' OR :'household_id' = ':household_id'
  THEN 1/0  -- intentionally explode with a clear divide-by-zero
  ELSE 0
END AS household_id_required;

BEGIN;

-- Report what we're about to remove so the operator has a paper trail
-- before the DELETE fires (psql runs both statements in the same tx).
WITH candidates AS (
  SELECT p.id, p.item_id, p.institution_name
    FROM plaid_items p
   WHERE p.household_id = :'household_id'
     AND p.item_id LIKE 'seed-%'
     AND (p.cursor IS NULL OR p.cursor = '')
     AND NOT EXISTS (
       SELECT 1
         FROM transactions t
         JOIN plaid_accounts pa
           ON pa.account_id = t.plaid_account_id
        WHERE pa.item_id = p.id
     )
)
SELECT
  COUNT(*) AS synthetic_items_to_delete,
  COALESCE(STRING_AGG(institution_name || ' (' || item_id || ')', ', '), '(none)')
    AS deleting
  FROM candidates;

-- Detach plaid_accounts first so the cascade order is explicit.
DELETE FROM plaid_accounts
 WHERE item_id IN (
   SELECT id FROM plaid_items p
    WHERE p.household_id = :'household_id'
      AND p.item_id LIKE 'seed-%'
      AND (p.cursor IS NULL OR p.cursor = '')
      AND NOT EXISTS (
        SELECT 1
          FROM transactions t
          JOIN plaid_accounts pa
            ON pa.account_id = t.plaid_account_id
         WHERE pa.item_id = p.id
      )
 );

DELETE FROM plaid_items p
 WHERE p.household_id = :'household_id'
   AND p.item_id LIKE 'seed-%'
   AND (p.cursor IS NULL OR p.cursor = '')
   AND NOT EXISTS (
     SELECT 1
       FROM transactions t
       JOIN plaid_accounts pa
         ON pa.account_id = t.plaid_account_id
      WHERE pa.item_id = p.id
   );

COMMIT;
