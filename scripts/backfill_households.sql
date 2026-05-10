-- (#623) Shared-household backfill — idempotent, safe to re-run.
--
-- Builds the households + household_members tables from the existing
-- per-user data, and stamps household_id on every user-scoped row so
-- the route layer can switch to filtering by household_id.
--
-- Strategy: each existing distinct user_id (across every user-scoped
-- table) becomes its own household with role='owner'. Subsequent
-- re-invites of additional family members are inserted by the
-- requireAuth middleware on first sign-in (it sees an accepted Clerk
-- invitation and links the new userId to the owner's household).
--
-- Re-runnable: ON CONFLICT clauses + IS NULL guards on every UPDATE
-- mean repeated runs are no-ops once the data is converged.

BEGIN;

-- 1. One household per distinct existing user_id (across all data
--    tables). The OWNER_EMAIL user — typically the only existing
--    real user in production — gets their household first; any
--    other historical user_ids (e.g. test users from prior
--    deployments) are isolated into their own empty households.

INSERT INTO households (owner_user_id)
SELECT DISTINCT user_id
FROM (
  SELECT id AS user_id FROM profiles
  UNION SELECT user_id FROM debts
  UNION SELECT user_id FROM debt_balance_history
  UNION SELECT user_id FROM avalanche_settings
  UNION SELECT user_id FROM budget_categories
  UNION SELECT user_id FROM budget_months
  UNION SELECT user_id FROM budget_lines
  UNION SELECT user_id FROM recurring_items
  UNION SELECT user_id FROM transactions
  UNION SELECT user_id FROM plaid_items
  UNION SELECT user_id FROM plaid_accounts
  UNION SELECT user_id FROM plaid_sync_attempts
  UNION SELECT user_id FROM plaid_consent_reminders_sent
  UNION SELECT user_id FROM mapping_rules
  UNION SELECT user_id FROM monthly_snapshots
  UNION SELECT user_id FROM settings
  UNION SELECT user_id FROM import_batches
  UNION SELECT user_id FROM forecast_resolutions
  UNION SELECT user_id FROM forecast_closed_months
  UNION SELECT user_id FROM forecast_settings
  UNION SELECT user_id FROM dashboard_budgets
) AS u
WHERE user_id IS NOT NULL
  AND user_id != ''
ON CONFLICT (owner_user_id) DO NOTHING;

-- 2. Every household gets a self-membership row for its owner.
INSERT INTO household_members (user_id, household_id, role)
SELECT h.owner_user_id, h.id, 'owner'
FROM households h
ON CONFLICT (user_id) DO NOTHING;

-- 3. Backfill household_id on every user-scoped table. The IS NULL
--    guard makes each statement a no-op on subsequent runs.
UPDATE debts SET household_id = h.id FROM households h
  WHERE h.owner_user_id = debts.user_id AND debts.household_id IS NULL;
UPDATE debt_balance_history SET household_id = h.id FROM households h
  WHERE h.owner_user_id = debt_balance_history.user_id AND debt_balance_history.household_id IS NULL;
UPDATE avalanche_settings SET household_id = h.id FROM households h
  WHERE h.owner_user_id = avalanche_settings.user_id AND avalanche_settings.household_id IS NULL;
UPDATE budget_categories SET household_id = h.id FROM households h
  WHERE h.owner_user_id = budget_categories.user_id AND budget_categories.household_id IS NULL;
UPDATE budget_months SET household_id = h.id FROM households h
  WHERE h.owner_user_id = budget_months.user_id AND budget_months.household_id IS NULL;
UPDATE budget_lines SET household_id = h.id FROM households h
  WHERE h.owner_user_id = budget_lines.user_id AND budget_lines.household_id IS NULL;
UPDATE recurring_items SET household_id = h.id FROM households h
  WHERE h.owner_user_id = recurring_items.user_id AND recurring_items.household_id IS NULL;
UPDATE transactions SET household_id = h.id FROM households h
  WHERE h.owner_user_id = transactions.user_id AND transactions.household_id IS NULL;
UPDATE plaid_items SET household_id = h.id FROM households h
  WHERE h.owner_user_id = plaid_items.user_id AND plaid_items.household_id IS NULL;
UPDATE plaid_accounts SET household_id = h.id FROM households h
  WHERE h.owner_user_id = plaid_accounts.user_id AND plaid_accounts.household_id IS NULL;
UPDATE plaid_sync_attempts SET household_id = h.id FROM households h
  WHERE h.owner_user_id = plaid_sync_attempts.user_id AND plaid_sync_attempts.household_id IS NULL;
UPDATE plaid_consent_reminders_sent SET household_id = h.id FROM households h
  WHERE h.owner_user_id = plaid_consent_reminders_sent.user_id AND plaid_consent_reminders_sent.household_id IS NULL;
UPDATE mapping_rules SET household_id = h.id FROM households h
  WHERE h.owner_user_id = mapping_rules.user_id AND mapping_rules.household_id IS NULL;
UPDATE monthly_snapshots SET household_id = h.id FROM households h
  WHERE h.owner_user_id = monthly_snapshots.user_id AND monthly_snapshots.household_id IS NULL;
UPDATE settings SET household_id = h.id FROM households h
  WHERE h.owner_user_id = settings.user_id AND settings.household_id IS NULL;
UPDATE import_batches SET household_id = h.id FROM households h
  WHERE h.owner_user_id = import_batches.user_id AND import_batches.household_id IS NULL;
UPDATE forecast_resolutions SET household_id = h.id FROM households h
  WHERE h.owner_user_id = forecast_resolutions.user_id AND forecast_resolutions.household_id IS NULL;
UPDATE forecast_closed_months SET household_id = h.id FROM households h
  WHERE h.owner_user_id = forecast_closed_months.user_id AND forecast_closed_months.household_id IS NULL;
UPDATE forecast_settings SET household_id = h.id FROM households h
  WHERE h.owner_user_id = forecast_settings.user_id AND forecast_settings.household_id IS NULL;
UPDATE dashboard_budgets SET household_id = h.id FROM households h
  WHERE h.owner_user_id = dashboard_budgets.user_id AND dashboard_budgets.household_id IS NULL;

COMMIT;
