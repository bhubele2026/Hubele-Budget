-- One-time operator fix: two recurring bills whose budgeted amount no longer
-- matches what the bank actually charges.
--
-- Reconciled against real Chase charges (2026-07-15 audit, two consecutive
-- months confirmed for each):
--
--   Mortgage (Lakeview)   1989.81  ->  2085.79
--   Verizon                342.00  ->   425.45
--
-- Owner-authorized 2026-08-25: "Apply the confirmed mortgage and Verizon bill
-- amounts to the H2 Budget production database."
--
-- ⚠️ SCOPE. Only these two rows, and only when they still hold the OLD amount.
-- The same audit left three questions open that this script deliberately does
-- NOT touch, because the owner has not answered them:
--   * HELOC (Figure) — budgeted 677.40, last charge 600.00 (was 677.40 in June)
--   * State Farm — two items (121.54 + 128.59) against actuals 159.95 + 128.59
--   * Duplicates — PlayStation x2 (18.98) and Kwik Trip / gas x2 (200)
-- Do not add them here. They need an answer, not a guess.
--
-- The forecast reads recurring_items at request time, so there is nothing to
-- recompute afterwards: the next forecast load already reflects the new
-- amounts. Past occurrences that were already matched to real transactions are
-- untouched — this changes what is PLANNED going forward, not what happened.
--
-- INVOCATION (manual):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v ALLOW_BILL_FIX=1 \
--     -f scripts/apply_confirmed_bill_amounts.sql
--
-- Idempotent: the WHERE clauses require the old amount, so a second run
-- updates nothing and the assertions below accept "already applied".

\set ON_ERROR_STOP on

\if :{?ALLOW_BILL_FIX}
\else
\echo '*** REFUSING: apply_confirmed_bill_amounts.sql writes to financial data. ***'
\echo '*** Re-run with -v ALLOW_BILL_FIX=1 once the amounts are confirmed.      ***'
\quit
\endif

BEGIN;

\echo '--- before ---'
SELECT id, name, amount, frequency, active
FROM recurring_items
WHERE name ILIKE '%mortgage%' OR name ILIKE '%lakeview%' OR name ILIKE '%verizon%'
ORDER BY name;

-- Mortgage. Matched on name + the exact old amount so a row that has already
-- been corrected, or a differently-named mortgage row, is never touched.
UPDATE recurring_items
SET amount = '2085.79'
WHERE (name ILIKE '%mortgage%' OR name ILIKE '%lakeview%')
  AND amount = '1989.81';

-- Verizon.
UPDATE recurring_items
SET amount = '425.45'
WHERE name ILIKE '%verizon%'
  AND amount = '342.00';

-- Assert the end state rather than the number of rows changed, so a re-run is
-- a clean no-op: exactly one mortgage row and one Verizon row, each holding
-- the confirmed amount, and nothing left behind on the old amount.
DO $$
DECLARE
  mortgage_at_new int;
  mortgage_at_old int;
  verizon_at_new  int;
  verizon_at_old  int;
BEGIN
  SELECT count(*) INTO mortgage_at_new FROM recurring_items
   WHERE (name ILIKE '%mortgage%' OR name ILIKE '%lakeview%') AND amount = '2085.79';
  SELECT count(*) INTO mortgage_at_old FROM recurring_items
   WHERE (name ILIKE '%mortgage%' OR name ILIKE '%lakeview%') AND amount = '1989.81';
  SELECT count(*) INTO verizon_at_new FROM recurring_items
   WHERE name ILIKE '%verizon%' AND amount = '425.45';
  SELECT count(*) INTO verizon_at_old FROM recurring_items
   WHERE name ILIKE '%verizon%' AND amount = '342.00';

  IF mortgage_at_new <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK: expected exactly 1 mortgage row at 2085.79, found %.', mortgage_at_new;
  END IF;
  IF verizon_at_new <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK: expected exactly 1 Verizon row at 425.45, found %.', verizon_at_new;
  END IF;
  IF mortgage_at_old <> 0 OR verizon_at_old <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK: % mortgage and % Verizon row(s) still hold the old amount — more rows match these names than the audit found.',
      mortgage_at_old, verizon_at_old;
  END IF;

  RAISE NOTICE 'OK: mortgage -> 2085.79, Verizon -> 425.45.';
END $$;

\echo '--- after ---'
SELECT id, name, amount, frequency, active
FROM recurring_items
WHERE name ILIKE '%mortgage%' OR name ILIKE '%lakeview%' OR name ILIKE '%verizon%'
ORDER BY name;

COMMIT;
