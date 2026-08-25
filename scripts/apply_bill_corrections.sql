-- Recurring-bill corrections, reconciled against real Chase/Amex charges.
--
-- ⚠️⚠️ ONE TRANSACTION PER BILL. THIS IS THE WHOLE DESIGN, AND IT IS A LESSON
-- PAID FOR IN PRODUCTION.
--
-- The first version of this script put the mortgage and Verizon in ONE
-- transaction that asserted BOTH end states. On the day it ran (2026-08-25) the
-- Verizon row had drifted — the July audit recorded 342.00, the live row held
-- 442.00 — so its assertion failed and would have rolled back the mortgage fix
-- alongside it. The mortgage was confirmed by four identical charges and had
-- nothing to do with Verizon. An unrelated surprise on one bill must never
-- block a confirmed fix to another.
--
-- So: each bill gets its own BEGIN/COMMIT and its own assertion. One block
-- aborting leaves every other block committed, and the run reports which.
--
-- ⚠️ EVERY PREDICATE PINS `kind = 'bill'` AND THE EXACT CURRENT AMOUNT.
--   * `kind = 'bill'` because `name ILIKE '%verizon%'` also matches the
--     "Mom — Verizon reimbursement" $88 INCOME row. A rehearsal caught that
--     once; do not lose it.
--   * the exact amount so a row someone has already changed aborts its own
--     block instead of being silently overwritten — which is precisely how the
--     Verizon drift was caught rather than buried.
--
-- ⚠️ BACK UP FIRST:
--   pg_dump "$DATABASE_URL" --no-owner --no-privileges -t recurring_items \
--     -f recurring-items-backup-$(date +%Y-%m-%d).sql
--
-- INVOCATION (manual; deliberately NOT wired into post-merge.sh):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -v ALLOW_BILL_FIX=1 \
--     -f scripts/apply_bill_corrections.sql
--
-- ⚠️ ON_ERROR_STOP=0, not 1. Each block is meant to be able to fail on its own
-- without killing the ones after it. That is the point of splitting them.
--
-- The forecast reads recurring_items at request time, so nothing needs
-- recomputing afterwards. Past occurrences already matched to real
-- transactions are untouched — this changes what is PLANNED going forward.
--
-- Idempotent: every WHERE requires the OLD amount, so a second run changes
-- nothing and each assertion accepts "already applied".
--
-- ═══════════════════════════════════════════════════════════════════════════
-- RUN LOG
--
-- 2026-08-25 — mortgage: Mortgage (Lakeview) 1989.81 → 2085.79. APPLIED.
--   Confirmed by four identical charges from Lakeview Loan Servicing:
--   May 15, Jun 15, Jul 15, Aug 17, all exactly 2085.79.
--
-- 2026-08-25 — verizon: 342.00 → 425.45. NOT APPLIED, superseded.
--   The row had moved to 442.00. Actual charges ran 425.65 / 425.35 / 425.45 /
--   434.47 / 429.92 — drifting UP, so 425.45 was below every charge but June's
--   and 442.00 sat ~12 above the latest. Owner priced it at 430.00 instead.
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP off

\if :{?ALLOW_BILL_FIX}
\else
\echo '*** REFUSING: apply_bill_corrections.sql writes to financial data. ***'
\echo '*** Re-run with -v ALLOW_BILL_FIX=1 once the amounts are confirmed. ***'
\quit
\endif

\echo ''
\echo '=== BEFORE ==='
SELECT id, name, amount, frequency, kind, active
FROM recurring_items
WHERE kind = 'bill'
  AND (name ILIKE '%mortgage%' OR name ILIKE '%lakeview%' OR name ILIKE '%verizon%'
       OR name ILIKE '%heloc%' OR name ILIKE '%figure%' OR name ILIKE '%state farm%'
       OR name ILIKE '%playstation%' OR name ILIKE '%kwik%')
ORDER BY name, amount;

-- ── 1. Mortgage ────────────────────────────────────────────────────────────
-- Applied 2026-08-25. Kept so the script is a complete, re-runnable record of
-- the corrections; the WHERE no longer matches, and the assertion accepts that.
\echo ''
\echo '--- 1. Mortgage (Lakeview) -> 2085.79 ---'
BEGIN;
UPDATE recurring_items SET amount = '2085.79'
 WHERE kind = 'bill'
   AND (name ILIKE '%mortgage%' OR name ILIKE '%lakeview%')
   AND amount = '1989.81';
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM recurring_items
   WHERE kind = 'bill' AND (name ILIKE '%mortgage%' OR name ILIKE '%lakeview%')
     AND amount = '2085.79';
  IF n <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK mortgage: expected 1 row at 2085.79, found %.', n;
  END IF;
  RAISE NOTICE 'OK mortgage -> 2085.79';
END $$;
COMMIT;

-- ── 2. Verizon ─────────────────────────────────────────────────────────────
-- Owner-priced at 430.00 (2026-08-25) against a rising actual: the last five
-- charges were 425.65 / 425.35 / 425.45 / 434.47 / 429.92.
\echo ''
\echo '--- 2. Verizon Wireless 442.00 -> 430.00 ---'
BEGIN;
UPDATE recurring_items SET amount = '430.00'
 WHERE kind = 'bill' AND name ILIKE '%verizon%' AND amount = '442.00';
DO $$
DECLARE n_new int; n_old int; n_income int;
BEGIN
  SELECT count(*) INTO n_new FROM recurring_items
   WHERE kind = 'bill' AND name ILIKE '%verizon%' AND amount = '430.00';
  SELECT count(*) INTO n_old FROM recurring_items
   WHERE kind = 'bill' AND name ILIKE '%verizon%' AND amount = '442.00';
  -- The reimbursement row must be exactly where it was. If this ever trips,
  -- a predicate has leaked past `kind = 'bill'`.
  SELECT count(*) INTO n_income FROM recurring_items
   WHERE kind = 'income' AND name ILIKE '%verizon%' AND amount = '88.00';
  IF n_new <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK verizon: expected 1 bill at 430.00, found %.', n_new;
  END IF;
  IF n_old <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK verizon: % row(s) still hold 442.00.', n_old;
  END IF;
  IF n_income <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK verizon: the Mom reimbursement row was disturbed (found %).', n_income;
  END IF;
  RAISE NOTICE 'OK verizon -> 430.00 (reimbursement row untouched)';
END $$;
COMMIT;

-- ── 3. HELOC (Figure) ──────────────────────────────────────────────────────
-- :heloc_old / :heloc_new are supplied at invocation from the measured charge
-- history, because a HELOC payment moves with rates and hard-coding one here
-- would be inventing his number three months from now.
\echo ''
\echo '--- 3. HELOC (Figure) ---'
\if :{?heloc_new}
BEGIN;
-- ⚠️ psql does NOT interpolate :vars inside a dollar-quoted body, so the
-- assertion below reads the value back through current_setting() instead. The
-- SET LOCAL line IS outside the quoting, so it interpolates normally.
SET LOCAL h2.heloc_new = :'heloc_new';
UPDATE recurring_items SET amount = :'heloc_new'
 WHERE kind = 'bill' AND (name ILIKE '%heloc%' OR name ILIKE '%figure%')
   AND amount = :'heloc_old';
DO $$
DECLARE n int; target text := current_setting('h2.heloc_new');
BEGIN
  SELECT count(*) INTO n FROM recurring_items
   WHERE kind = 'bill' AND (name ILIKE '%heloc%' OR name ILIKE '%figure%')
     AND amount = target::numeric;
  IF n <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK heloc: expected 1 row at %, found %.', target, n;
  END IF;
  RAISE NOTICE 'OK heloc -> %', target;
END $$;
COMMIT;
\else
\echo 'SKIPPED — pass -v heloc_old=<current> -v heloc_new=<measured latest charge>'
\endif

-- ── 4. State Farm (the smaller policy) ─────────────────────────────────────
-- Two State Farm rows exist. Only the one holding :sf_old is touched; the
-- other is matched by name too, which is exactly why the amount is pinned.
\echo ''
\echo '--- 4. State Farm (smaller policy) ---'
\if :{?sf_new}
BEGIN;
SET LOCAL h2.sf_new = :'sf_new';
UPDATE recurring_items SET amount = :'sf_new'
 WHERE kind = 'bill' AND name ILIKE '%state farm%' AND amount = :'sf_old';
DO $$
DECLARE n int; target text := current_setting('h2.sf_new');
BEGIN
  SELECT count(*) INTO n FROM recurring_items
   WHERE kind = 'bill' AND name ILIKE '%state farm%' AND amount = target::numeric;
  IF n <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK state farm: expected 1 row at %, found %.', target, n;
  END IF;
  RAISE NOTICE 'OK state farm -> %', target;
END $$;
COMMIT;
\else
\echo 'SKIPPED — pass -v sf_old=<current> -v sf_new=<measured latest charge>'
\endif

-- ── 5. PlayStation Network — drop the duplicate ────────────────────────────
-- Keeps the OLDEST row (lowest ctid is unreliable; order by created_at, then
-- id, so the choice is deterministic and re-runnable).
\echo ''
\echo '--- 5. PlayStation Network: delete the duplicate ---'
BEGIN;
DELETE FROM recurring_items
 WHERE id IN (
   SELECT id FROM recurring_items
    WHERE kind = 'bill' AND name ILIKE '%playstation%'
    ORDER BY created_at ASC, id ASC
    OFFSET 1
 );
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM recurring_items
   WHERE kind = 'bill' AND name ILIKE '%playstation%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK playstation: expected exactly 1 row to remain, found %.', n;
  END IF;
  RAISE NOTICE 'OK playstation: 1 row remains';
END $$;
COMMIT;

-- ── 6. Kwik Trip / gas — remove BOTH ───────────────────────────────────────
-- Owner's call 2026-08-25: gas is variable spending, not a fixed bill. It is
-- already tracked as allowance spend, so leaving it in the bill schedule
-- committed the same money twice — the same fault the Budget page overhaul
-- fixed on the planning side.
\echo ''
\echo '--- 6. Kwik Trip / gas: delete BOTH rows ---'
BEGIN;
DELETE FROM recurring_items
 WHERE kind = 'bill' AND (name ILIKE '%kwik%' OR name ILIKE '%kwik trip%');
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM recurring_items
   WHERE kind = 'bill' AND name ILIKE '%kwik%';
  IF n <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK kwik trip: expected 0 rows to remain, found %.', n;
  END IF;
  RAISE NOTICE 'OK kwik trip: both rows gone';
END $$;
COMMIT;

\echo ''
\echo '=== AFTER ==='
SELECT id, name, amount, frequency, kind, active
FROM recurring_items
WHERE name ILIKE '%mortgage%' OR name ILIKE '%lakeview%' OR name ILIKE '%verizon%'
   OR name ILIKE '%heloc%' OR name ILIKE '%figure%' OR name ILIKE '%state farm%'
   OR name ILIKE '%playstation%' OR name ILIKE '%kwik%'
ORDER BY kind, name, amount;
