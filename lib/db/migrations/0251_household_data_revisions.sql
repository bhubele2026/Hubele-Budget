-- 0251_household_data_revisions.sql — package PERF (the forecast ledger's result cache).
--
-- ⭐ ONE NUMBER PER HOUSEHOLD THAT MOVES ON EVERY COMMITTED WRITE TO ITS MONEY DATA.
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
--   h2_data_rev_bump()  a DEFERRED row-level CONSTRAINT TRIGGER on INSERT,
--     UPDATE and DELETE: it runs at COMMIT, after every statement of the
--     transaction, so the revision row is locked only for the commit itself.
--     (An immediate trigger would hold that row from the transaction's first
--     write to its end: a long import, or a job writing several statements,
--     would block every other writer of the household, and a writer holding a
--     row the job needs next would deadlock against it.) One bump per household
--     per transaction: a transaction-local setting marks a household as bumped,
--     so a 500-row insert costs one upsert. A rolled-back transaction fires
--     nothing. An UPDATE that writes a row back unchanged bumps nothing; a row
--     moved between households bumps both. For tables with user_id, the
--     households that user belongs to are bumped too (a row whose household_id
--     is still null is caught that way); `households` bumps its own id.
--   h2_data_rev_truncate()  AFTER TRUNCATE (statement): every household,
--     a row created for any that has none.
--
-- The tables are every table the forecast ledger, the cash signal and the weekly
-- avalanche plan can read, and the money tables around them. Not
-- debt_balance_history: GET /debts writes the day's balance snapshot on a read,
-- and no cached build reads it. `householdDataRevision.integration.test.ts`
-- fails if anything those builds read has no trigger.
--
-- Additive and idempotent: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE
-- FUNCTION, DROP TRIGGER IF EXISTS + CREATE (a constraint trigger cannot be
-- replaced), skipping a table that does not exist. Must agree with
-- lib/db/src/schema/householdDataRevisions.ts.
CREATE TABLE IF NOT EXISTS household_data_revisions (
  household_id uuid PRIMARY KEY,
  rev bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Bump one household once in this transaction (transaction-local marker).
CREATE OR REPLACE FUNCTION h2_data_rev_bump_one(hh uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  marker text;
BEGIN
  IF hh IS NULL THEN RETURN; END IF;
  marker := 'h2_rev.h' || replace(hh::text, '-', '');
  IF current_setting(marker, true) = '1' THEN RETURN; END IF;
  INSERT INTO household_data_revisions AS r (household_id, rev, updated_at)
  VALUES (hh, 1, now())
  ON CONFLICT (household_id) DO UPDATE SET rev = r.rev + 1, updated_at = now();
  PERFORM set_config(marker, '1', true);
END;
$$;

CREATE OR REPLACE FUNCTION h2_data_rev_bump() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mode text := TG_ARGV[0];  -- 'hh' (household_id), 'both' (household_id + user_id), 'self' (households.id)
  o jsonb;
  n jsonb;
  hh uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN o := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN n := to_jsonb(NEW); END IF;
  -- The same values written back: nothing changed.
  IF TG_OP = 'UPDATE' AND o = n THEN RETURN NULL; END IF;
  IF mode = 'self' THEN
    PERFORM h2_data_rev_bump_one((o->>'id')::uuid);
    PERFORM h2_data_rev_bump_one((n->>'id')::uuid);
    RETURN NULL;
  END IF;
  PERFORM h2_data_rev_bump_one((o->>'household_id')::uuid);
  PERFORM h2_data_rev_bump_one((n->>'household_id')::uuid);
  IF mode = 'both' THEN
    FOR hh IN
      SELECT hm.household_id FROM household_members hm
       WHERE hm.user_id IN (o->>'user_id', n->>'user_id')
    LOOP
      PERFORM h2_data_rev_bump_one(hh);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION h2_data_rev_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO household_data_revisions AS r (household_id, rev, updated_at)
  SELECT h.id, 1, now() FROM households h
  ON CONFLICT (household_id) DO UPDATE SET rev = r.rev + 1, updated_at = now();
  UPDATE household_data_revisions SET rev = rev + 1, updated_at = now()
   WHERE household_id NOT IN (SELECT id FROM households);
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
    'recurring_items', 'debts', 'debt_ledger_events', 'debt_statements',
    'avalanche_settings', 'avalanche_week_payments', 'allowance_plans', 'plan_adjustments',
    'budget_categories', 'budget_lines', 'budget_months', 'dashboard_budgets', 'mapping_rules', 'merchant_aliases',
    'settings', 'plaid_items', 'plaid_accounts', 'bank_auto_match_declines', 'category_decisions',
    'correction_applications', 'weekly_settlements', 'goals', 'import_batches', 'import_snapshots',
    'monthly_snapshots', 'household_members', 'merchant_memory', 'households'
  ] LOOP
    IF to_regclass(quote_ident(t)) IS NULL THEN CONTINUE; END IF;
    IF t = 'households' THEN
      mode := 'self';
    ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = t AND column_name = 'household_id') THEN
      CONTINUE;
    ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = t AND column_name = 'user_id') THEN
      mode := 'both';
    ELSE
      mode := 'hh';
    END IF;
    -- (Earlier drafts of this file used immediate statement triggers under these names.)
    EXECUTE format('DROP TRIGGER IF EXISTS h2_data_rev_ins ON %I', t);
    EXECUTE format('DROP TRIGGER IF EXISTS h2_data_rev_upd ON %I', t);
    EXECUTE format('DROP TRIGGER IF EXISTS h2_data_rev_del ON %I', t);
    EXECUTE format('DROP TRIGGER IF EXISTS h2_data_rev_row ON %I', t);
    EXECUTE format('CREATE CONSTRAINT TRIGGER h2_data_rev_row AFTER INSERT OR UPDATE OR DELETE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION h2_data_rev_bump(%L)', t, mode);
    EXECUTE format('DROP TRIGGER IF EXISTS h2_data_rev_trunc ON %I', t);
    EXECUTE format('CREATE TRIGGER h2_data_rev_trunc AFTER TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION h2_data_rev_truncate()', t);
  END LOOP;
END;
$$;
