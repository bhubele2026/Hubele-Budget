-- Task #828 — one-time operator cleanup: clear the Chase "Review Bucket"
-- backlog for a single household by flipping forecast_flag = false on the
-- genuinely-stuck, already-occurred, non-terminally-resolved plaid:chase
-- rows on one specific Chase checking account.
--
-- This REPLACES the retired `runStartupChaseReviewBacklogClear` startup
-- hook (#812 / tests #817). That hook ran on EVERY boot and was a footgun:
-- because new Plaid syncs insert awaiting-match rows with forecast_flag =
-- true, the hook would silently flip genuinely-new review items out of the
-- Debrief / Review queue on each restart, not just the original backlog.
-- Per the #706 convention, a one-time risky prod data mutation belongs in
-- an explicit, parameterized operator script that a human runs once — not
-- in an unconditional boot hook.
--
-- INVOCATION (manual; intentionally NOT wired into post-merge.sh):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v household_id='a7182af8-49f0-48f3-920e-f916c7eab872' \
--     -v chase_account_external_id='YEvBBznkA3updAzAk7wyILEPd31z6BSQK184R' \
--     -f scripts/clear_chase_review_backlog.sql
--
-- Both `:'household_id'` and `:'chase_account_external_id'` are REQUIRED —
-- the script aborts if either is unset so it can never run unscoped across
-- every household / account.
--
-- Predicate mirrors the awaiting-match chip exactly:
--   * source = 'plaid:chase'
--   * plaid_account_id = :chase_account_external_id
--   * forecast_flag = true
--   * occurred_on <= CURRENT_DATE  (future / pending rows are NEVER touched)
--   * NO terminal forecast_resolutions row (status in matched,
--     ignored_unforecasted, unplanned) pointing at it.
-- sent_to_review_at is deliberately left untouched.
--
-- Safety: aborts WITHOUT updating if >= 400 rows would clear (a runaway-
-- predicate guard, mirroring the retired hook's SAFETY_THRESHOLD).
-- Idempotent: flipped rows no longer match the predicate, so re-running is
-- a no-op. The `UPDATE NNN` line printed by psql is the cleared count.
-- Wrapped in a transaction so the safety check and the update are atomic.

\set ON_ERROR_STOP on

-- Hard-stop if the operator forgot to pass -v household_id=...
-- (psql substitutes the empty string when the var is unset; when it is set
-- but to nothing it stays empty; the literal ':household_id' guards the
-- "flag passed without a value" case).
SELECT CASE
  WHEN :'household_id' = '' OR :'household_id' = ':household_id'
  THEN 1/0  -- intentionally explode with a clear divide-by-zero
  ELSE 0
END AS household_id_required;

SELECT CASE
  WHEN :'chase_account_external_id' = ''
    OR :'chase_account_external_id' = ':chase_account_external_id'
  THEN 1/0  -- intentionally explode with a clear divide-by-zero
  ELSE 0
END AS chase_account_external_id_required;

BEGIN;

-- Safety guard: count first and abort if the predicate is too broad. This
-- protects against a bad scope accidentally zapping thousands of rows.
--
-- NOTE on the shape: the threshold lives in the DIVISOR (1 / (CASE ...)),
-- not as a `THEN 1/0` arm. A literal `1/0` inside a CASE whose WHEN is a
-- runtime subquery gets evaluated during planning (PostgreSQL constant
-- folding), so it would raise "division by zero" even when zero rows
-- match. Putting the zero in the denominator forces runtime evaluation:
-- the divisor is 0 (=> abort) only when >= 400 rows actually match.
SELECT 1 / (
  CASE
    WHEN (
      SELECT count(*)
        FROM transactions t
       WHERE t.household_id = :'household_id'
         AND t.source = 'plaid:chase'
         AND t.plaid_account_id = :'chase_account_external_id'
         AND t.forecast_flag = true
         AND t.occurred_on <= CURRENT_DATE
         AND NOT EXISTS (
           SELECT 1
             FROM forecast_resolutions fr
            WHERE fr.matched_txn_id = t.id
              AND fr.status IN ('matched', 'ignored_unforecasted', 'unplanned')
         )
    ) >= 400
    THEN 0  -- safety threshold exceeded => divisor 0 => abort, no update
    ELSE 1
  END
) AS within_safety_threshold;

UPDATE transactions t
   SET forecast_flag = false
 WHERE t.household_id = :'household_id'
   AND t.source = 'plaid:chase'
   AND t.plaid_account_id = :'chase_account_external_id'
   AND t.forecast_flag = true
   AND t.occurred_on <= CURRENT_DATE
   AND NOT EXISTS (
     SELECT 1
       FROM forecast_resolutions fr
      WHERE fr.matched_txn_id = t.id
        AND fr.status IN ('matched', 'ignored_unforecasted', 'unplanned')
   );

COMMIT;
