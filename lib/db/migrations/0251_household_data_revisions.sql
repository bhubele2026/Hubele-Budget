-- 0251_household_data_revisions.sql — package PERF (the forecast ledger's result cache).
--
-- ⭐ ONE NUMBER PER HOUSEHOLD THAT MOVES ON EVERY WRITE TO ITS MONEY DATA.
-- The API keeps a few computed forecast ledgers (and the weekly avalanche's
-- 400-day base) for a short while (artifacts/api-server/src/lib/ledgerCache.ts)
-- and serves one again only while this household's revision is still the one
-- it was built at. So the revision must move on EVERY write path — the routes,
-- the Plaid sync, background jobs, a hand-run script — which is why it is kept
-- here, by triggers, and not in application code.
--
--   household_data_revisions(household_id pk, rev, updated_at)
--     A row appears on a household's first write (rev 1); a household with no
--     row reads as rev 0. No foreign key on purpose: a bump must never be able
--     to fail the write that caused it.
--
--   h2_data_rev_bump()  one AFTER … FOR EACH STATEMENT trigger function, on
--     INSERT, UPDATE and DELETE (transition tables, so a 500-row insert bumps
--     once) and TRUNCATE (bumps every household). It bumps the household_id
--     of every row written, before and after an update; for tables that also
--     carry user_id, the households that user belongs to as well (a row whose
--     household_id is still null is caught that way).
--
-- The tables are every table the forecast ledger, the cash signal, the weekly
-- avalanche plan, the money position and the spine read, and the money tables
-- around them. `householdDataRevision.integration.test.ts` fails if anything
-- those builds read has no trigger.
--
-- Additive and idempotent: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE
-- FUNCTION / TRIGGER, skipping a table that does not exist. Must agree with
-- lib/db/src/schema/householdDataRevisions.ts.
CREATE TABLE IF NOT EXISTS household_data_revisions (
  household_id uuid PRIMARY KEY,
  rev bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION h2_data_rev_bump() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ids uuid[];
  by_user boolean := TG_ARGV[0] = 'both';
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    UPDATE household_data_revisions SET rev = rev + 1, updated_at = now();
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF by_user THEN
      SELECT array_agg(DISTINCT x) INTO ids FROM (
        SELECT household_id AS x FROM new_rows WHERE household_id IS NOT NULL
        UNION SELECT hm.household_id FROM household_members hm JOIN new_rows n ON n.user_id = hm.user_id
      ) s;
    ELSE
      SELECT array_agg(DISTINCT household_id) INTO ids FROM new_rows WHERE household_id IS NOT NULL;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF by_user THEN
      SELECT array_agg(DISTINCT x) INTO ids FROM (
        SELECT household_id AS x FROM new_rows WHERE household_id IS NOT NULL
        UNION SELECT household_id FROM old_rows WHERE household_id IS NOT NULL
        UNION SELECT hm.household_id FROM household_members hm JOIN new_rows n ON n.user_id = hm.user_id
        UNION SELECT hm.household_id FROM household_members hm JOIN old_rows o ON o.user_id = hm.user_id
      ) s;
    ELSE
      SELECT array_agg(DISTINCT x) INTO ids FROM (
        SELECT household_id AS x FROM new_rows WHERE household_id IS NOT NULL
        UNION SELECT household_id FROM old_rows WHERE household_id IS NOT NULL
      ) s;
    END IF;
  ELSE -- DELETE
    IF by_user THEN
      SELECT array_agg(DISTINCT x) INTO ids FROM (
        SELECT household_id AS x FROM old_rows WHERE household_id IS NOT NULL
        UNION SELECT hm.household_id FROM household_members hm JOIN old_rows o ON o.user_id = hm.user_id
      ) s;
    ELSE
      SELECT array_agg(DISTINCT household_id) INTO ids FROM old_rows WHERE household_id IS NOT NULL;
    END IF;
  END IF;
  IF ids IS NOT NULL THEN
    -- In id order, so two statements bumping the same households never wait on each other in a circle.
    INSERT INTO household_data_revisions AS r (household_id, rev, updated_at)
    SELECT x, 1, now() FROM unnest(ids) AS x ORDER BY x
    ON CONFLICT (household_id) DO UPDATE SET rev = r.rev + 1, updated_at = now();
  END IF;
  RETURN NULL;
END;
$$;

DO $$
DECLARE
  t text;
  mode text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'transactions', 'transaction_splits', 'forecast_resolutions', 'forecast_settings', 'forecast_closed_months',
    'recurring_items', 'debts', 'debt_ledger_events', 'debt_statements', 'debt_balance_history',
    'avalanche_settings', 'avalanche_week_payments', 'allowance_plans', 'plan_adjustments',
    'budget_categories', 'budget_lines', 'budget_months', 'dashboard_budgets', 'mapping_rules', 'merchant_aliases',
    'settings', 'plaid_items', 'plaid_accounts', 'bank_auto_match_declines', 'category_decisions',
    'correction_applications', 'weekly_settlements', 'goals', 'import_batches', 'import_snapshots',
    'monthly_snapshots', 'household_members', 'merchant_memory'
  ] LOOP
    IF to_regclass(quote_ident(t)) IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = t AND column_name = 'household_id') THEN
      CONTINUE;
    END IF;
    mode := CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = t AND column_name = 'user_id')
                 THEN 'both' ELSE 'hh' END;
    EXECUTE format('CREATE OR REPLACE TRIGGER h2_data_rev_ins AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION h2_data_rev_bump(%L)', t, mode);
    EXECUTE format('CREATE OR REPLACE TRIGGER h2_data_rev_upd AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION h2_data_rev_bump(%L)', t, mode);
    EXECUTE format('CREATE OR REPLACE TRIGGER h2_data_rev_del AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION h2_data_rev_bump(%L)', t, mode);
    EXECUTE format('CREATE OR REPLACE TRIGGER h2_data_rev_trunc AFTER TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION h2_data_rev_bump(%L)', t, mode);
  END LOOP;
END;
$$;
