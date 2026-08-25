-- D2 — drop the advisor / debrief / budget-health storage.
--
-- The overhaul (2026-08-23/24) removed every feature that wrote to these:
-- A3/A4 tore out the advisor framework client and server, A5 removed the
-- Weekly Debrief, and the health card went with C1's gamification purge. The
-- TABLES survived on purpose — code first, data a soak later — and this is
-- the later. Nothing in `lib/db/src/schema/index.ts` references them once the
-- companion commit lands, and nothing has read or written them since 4539628
-- went live.
--
-- Owner-authorized 2026-08-25: "Drop the advisor and debrief tables from the
-- H2 Budget production database."
--
-- ⚠️ BACK UP FIRST. This is not reversible from the app, and these tables hold
-- the only copy of anything the advisor ever recorded:
--
--   pg_dump "$DATABASE_URL" --data-only --no-owner \
--     -t advisor_audit_log -t advisor_proposals -t advisor_memory \
--     -t budget_health_history -t weekly_debriefs \
--     -f advisor-tables-backup-$(date +%Y-%m-%d).sql
--
--   pg_dump "$DATABASE_URL" --data-only --no-owner -t forecast_settings \
--     -f forecast-settings-backup-$(date +%Y-%m-%d).sql
--
-- The forecast_settings dump matters too: this script drops four advisor
-- columns off that table, and forecast_settings is a LIVE table — the bank
-- snapshot lives there. The dump is the undo for the columns; it is also the
-- reason this script never touches any other column on it.
--
-- INVOCATION (manual; deliberately NOT wired into post-merge.sh):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v ALLOW_DROP_ADVISOR=1 \
--     -f scripts/drop_advisor_tables.sql
--
-- Idempotent: every drop is IF EXISTS, so a second run is a no-op that still
-- prints the row counts it found (zero).

\set ON_ERROR_STOP on

\if :{?ALLOW_DROP_ADVISOR}
\else
\echo '*** REFUSING: drop_advisor_tables.sql destroys data permanently. ***'
\echo '*** pg_dump the five tables + forecast_settings first (see header),  ***'
\echo '*** then re-run with -v ALLOW_DROP_ADVISOR=1.                        ***'
\quit
\endif

BEGIN;

-- What is about to be lost, on the record. Printed BEFORE the drop so the
-- psql transcript is itself evidence of what the tables held.
\echo '--- row counts before the drop ---'
SELECT 'advisor_audit_log'     AS table_name, count(*) AS rows FROM advisor_audit_log
UNION ALL SELECT 'advisor_proposals',     count(*) FROM advisor_proposals
UNION ALL SELECT 'advisor_memory',        count(*) FROM advisor_memory
UNION ALL SELECT 'budget_health_history', count(*) FROM budget_health_history
UNION ALL SELECT 'weekly_debriefs',       count(*) FROM weekly_debriefs
ORDER BY table_name;

\echo '--- forecast_settings rows carrying advisor payloads ---'
SELECT
  count(*) FILTER (WHERE avalanche_advisor_summary IS NOT NULL)  AS avalanche_summaries,
  count(*) FILTER (WHERE reports_advisor_summaries IS NOT NULL)  AS reports_summaries,
  count(*)                                                       AS forecast_settings_rows
FROM forecast_settings;

-- ⚠️ Refuse if anything OUTSIDE this set still depends on these tables. A
-- view or a foreign key we forgot about would otherwise turn a clean drop
-- into a cascade decision made under time pressure.
DO $$
DECLARE
  dependents int;
BEGIN
  SELECT count(*) INTO dependents
  FROM pg_constraint c
  JOIN pg_class referenced ON referenced.oid = c.confrelid
  JOIN pg_class referencing ON referencing.oid = c.conrelid
  WHERE c.contype = 'f'
    AND referenced.relname IN (
      'advisor_audit_log', 'advisor_proposals', 'advisor_memory',
      'budget_health_history', 'weekly_debriefs'
    )
    AND referencing.relname NOT IN (
      'advisor_audit_log', 'advisor_proposals', 'advisor_memory',
      'budget_health_history', 'weekly_debriefs'
    );

  IF dependents > 0 THEN
    RAISE EXCEPTION
      'REFUSING: % foreign key(s) outside the advisor set still point at these tables. Investigate before dropping.',
      dependents;
  END IF;
END $$;

-- The tables. No CASCADE on purpose: if something unexpected depends on one,
-- this should fail loudly rather than quietly take the dependency with it.
DROP TABLE IF EXISTS advisor_audit_log;
DROP TABLE IF EXISTS advisor_proposals;
DROP TABLE IF EXISTS advisor_memory;
DROP TABLE IF EXISTS budget_health_history;
DROP TABLE IF EXISTS weekly_debriefs;

-- The four advisor columns on the live forecast_settings table. Every other
-- column on it — the bank snapshot above all — is untouched.
ALTER TABLE forecast_settings
  DROP COLUMN IF EXISTS avalanche_advisor_summary,
  DROP COLUMN IF EXISTS avalanche_advisor_facts_hash,
  DROP COLUMN IF EXISTS reports_advisor_summaries,
  DROP COLUMN IF EXISTS reports_advisor_facts_hashes;

-- Prove the intended end state before committing: five tables gone, four
-- columns gone, forecast_settings still standing with its bank snapshot.
DO $$
DECLARE
  leftover_tables int;
  leftover_columns int;
  snapshot_column int;
BEGIN
  SELECT count(*) INTO leftover_tables
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN (
      'advisor_audit_log', 'advisor_proposals', 'advisor_memory',
      'budget_health_history', 'weekly_debriefs'
    );

  SELECT count(*) INTO leftover_columns
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'forecast_settings'
    AND column_name IN (
      'avalanche_advisor_summary', 'avalanche_advisor_facts_hash',
      'reports_advisor_summaries', 'reports_advisor_facts_hashes'
    );

  SELECT count(*) INTO snapshot_column
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'forecast_settings'
    AND column_name = 'bank_snapshot_balance';

  IF leftover_tables <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK: % advisor table(s) still present after the drop.', leftover_tables;
  END IF;
  IF leftover_columns <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK: % advisor column(s) still on forecast_settings.', leftover_columns;
  END IF;
  IF snapshot_column <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK: forecast_settings.bank_snapshot_balance is missing — this script took something it should not have.';
  END IF;

  RAISE NOTICE 'OK: 5 tables dropped, 4 advisor columns dropped, forecast_settings intact.';
END $$;

COMMIT;

\echo '--- done. Remaining advisor-named objects (expect zero rows): ---'
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND (table_name LIKE 'advisor%' OR table_name IN ('budget_health_history', 'weekly_debriefs'));
