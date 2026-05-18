-- Task #706 — clean up orphan duplicate plaid_items rows spawned by a
-- "Connect a bank" click that fired while an earlier item for the same
-- institution was already broken (INVALID_ACCESS_TOKEN /
-- ITEM_LOGIN_REQUIRED). The duplicate authenticates fine and returns the
-- balance, but Plaid's transaction cursor lives on the original dead
-- item, so /transactions/sync returns added=0 forever for the duplicate.
--
-- Safety guards — a candidate is deleted ONLY when:
--   1. A sibling plaid_item exists for the same household + institution
--      slug whose last_sync_error_code is in the reauth set
--      (INVALID_ACCESS_TOKEN, ITEM_LOGIN_REQUIRED). The dead item is
--      what we're trying to preserve so its history can be reconnected
--      via update mode — it is never deleted by this script.
--   2. The candidate itself is currently healthy
--      (last_sync_error_code IS NULL or empty).
--   3. The candidate has never staged a transactions/sync cursor
--      (cursor IS NULL or empty) — a non-empty cursor means Plaid has
--      already delivered rows against it and we cannot tell whether
--      they're duplicates without per-row inspection.
--   4. None of the candidate's plaid_accounts own any transactions.
--
-- Idempotent — once no row satisfies all four guards the script is a
-- no-op. Wrapped in a transaction so a partial accounts-delete can't
-- leave dangling rows.

BEGIN;

WITH dead_items AS (
  SELECT household_id, institution_slug, id
    FROM plaid_items
   WHERE last_sync_error_code IN ('INVALID_ACCESS_TOKEN', 'ITEM_LOGIN_REQUIRED')
),
candidates AS (
  SELECT p.id, p.item_id, p.institution_name, p.institution_slug, p.household_id
    FROM plaid_items p
    JOIN dead_items d
      ON d.household_id    = p.household_id
     AND d.institution_slug = p.institution_slug
     AND d.id <> p.id
   WHERE (p.last_sync_error_code IS NULL OR p.last_sync_error_code = '')
     AND (p.cursor IS NULL OR p.cursor = '')
     AND NOT EXISTS (
       SELECT 1
         FROM transactions t
         JOIN plaid_accounts pa
           ON pa.account_id = t.plaid_account_id
        WHERE pa.item_id = p.id
     )
),
report AS (
  SELECT id, item_id, institution_name, household_id FROM candidates
)
SELECT
  COUNT(*) AS orphan_items_to_delete,
  COALESCE(STRING_AGG(institution_name || ' (' || item_id || ')', ', '), '(none)')
    AS deleting
  FROM report;

-- Detach plaid_accounts first so the cascade order is explicit.
DELETE FROM plaid_accounts
 WHERE item_id IN (
   SELECT id FROM plaid_items p
    WHERE EXISTS (
      SELECT 1
        FROM plaid_items dead
       WHERE dead.household_id    = p.household_id
         AND dead.institution_slug = p.institution_slug
         AND dead.id <> p.id
         AND dead.last_sync_error_code IN (
           'INVALID_ACCESS_TOKEN', 'ITEM_LOGIN_REQUIRED'
         )
    )
    AND (p.last_sync_error_code IS NULL OR p.last_sync_error_code = '')
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
 WHERE EXISTS (
   SELECT 1
     FROM plaid_items dead
    WHERE dead.household_id    = p.household_id
      AND dead.institution_slug = p.institution_slug
      AND dead.id <> p.id
      AND dead.last_sync_error_code IN (
        'INVALID_ACCESS_TOKEN', 'ITEM_LOGIN_REQUIRED'
      )
 )
   AND (p.last_sync_error_code IS NULL OR p.last_sync_error_code = '')
   AND (p.cursor IS NULL OR p.cursor = '')
   AND NOT EXISTS (
     SELECT 1
       FROM transactions t
       JOIN plaid_accounts pa
         ON pa.account_id = t.plaid_account_id
      WHERE pa.item_id = p.id
   );

COMMIT;
