-- PR-E preview: debt balance provenance + the Amex estimate. READ ONLY.
--
-- Run BEFORE merging fix/amex-updater-balance-provenance to see, per household,
-- which balances are the bank's, which are kept as entered, what the bank says
-- beside each, and what the Amex estimate would do. Nothing here writes: the
-- transaction is READ ONLY and ends in ROLLBACK.
--
--   psql "$DATABASE_URL" -f artifacts/api-server/scripts/sql/preview-debt-balance-provenance.sql
--
-- After the merge:
--   - balance_source = 'plaid'      the bank balance, kept current by refreshes (unchanged).
--   - anything else (manual, other) kept as entered; never overwritten by a refresh,
--                                   a sync, the Amex estimate or the Amex auto-link sweep.
--   - shows_use_bank_balance        the Debts / Future Goal row will show both figures,
--                                   dated, with the difference and "Use bank balance".
--   - old_amex_updater_name_match   a debt the old Amex updater could have overwritten
--                                   with the all-card transaction sum (first match, no
--                                   ORDER BY). It no longer writes any debt.

BEGIN READ ONLY;

-- 1. Every debt, per household.
SELECT
  d.household_id,
  h.owner_user_id,
  d.id                                   AS debt_id,
  d.name,
  d.status,
  d.balance,
  d.balance_source,
  CASE WHEN d.balance_source = 'plaid'
       THEN 'bank (refresh keeps it current)'
       ELSE 'kept as entered (never overwritten)'
  END                                    AS after_merge,
  d.last_balance_update,
  d.plaid_last_synced_at,
  d.plaid_account_id                     AS linked_plaid_account_uuid,
  pa.account_id                          AS linked_plaid_account_external_id,
  pa.name                                AS linked_account_name,
  pa.mask                                AS linked_account_mask,
  pa.liability_balance                   AS bank_balance,
  pa.liability_last_fetched_at           AS bank_balance_at,
  pi.institution_name,
  pi.last_synced_at                      AS item_last_synced_at,
  la.attempted_at                        AS last_liabilities_refresh_at,
  la.success                             AS last_liabilities_refresh_ok,
  coalesce(la.error_message, la.error_code) AS last_liabilities_refresh_error,
  (d.balance - pa.liability_balance)     AS entered_minus_bank,
  (
    d.balance_source <> 'plaid'
    AND pa.liability_balance IS NOT NULL
    AND abs(d.balance - pa.liability_balance) >= 0.005
  )                                      AS shows_use_bank_balance,
  (d.name ~* '(amex|american\s*express)') AS old_amex_updater_name_match
FROM debts d
LEFT JOIN households h      ON h.id = d.household_id
LEFT JOIN plaid_accounts pa ON pa.id = d.plaid_account_id
LEFT JOIN plaid_items pi    ON pi.id = pa.item_id
LEFT JOIN LATERAL (
  SELECT a.attempted_at, a.success, a.error_code, a.error_message
  FROM plaid_sync_attempts a
  WHERE a.plaid_item_id = pa.item_id
    AND a.kind = 'liabilities'
  ORDER BY a.attempted_at DESC
  LIMIT 1
) la ON true
ORDER BY d.household_id, d.status, d.sort_order, d.name;

-- 2. The Amex estimate (settings.preferences.amexAnchor), per household.
--    anchor_after_merge: whether the refresh may still move `balance`/`asOf`
--    (it wrote them last) or keeps them (typed in, or origin unknown).
--    estimate_now: what the refresh computes today — every Amex row summed.
SELECT
  h.id                                            AS household_id,
  h.owner_user_id,
  coalesce(s.preferences ? 'amexAnchor', false)   AS has_amex_anchor,
  s.preferences -> 'amexAnchor' ->> 'balance'         AS anchor_balance,
  s.preferences -> 'amexAnchor' ->> 'asOf'            AS anchor_as_of,
  s.preferences -> 'amexAnchor' ->> 'lastAutoBalance' AS anchor_last_auto_balance,
  s.preferences -> 'amexAnchor' ->> 'refreshError'    AS anchor_refresh_error,
  CASE
    WHEN s.preferences -> 'amexAnchor' ->> 'balance' IS NULL
      THEN 'none: refresh writes balance + estimate'
    WHEN s.preferences -> 'amexAnchor' ->> 'lastAutoBalance' ~ '^-?[0-9]+(\.[0-9]+)?$'
     AND s.preferences -> 'amexAnchor' ->> 'balance'         ~ '^-?[0-9]+(\.[0-9]+)?$'
     AND abs((s.preferences -> 'amexAnchor' ->> 'balance')::numeric
           - (s.preferences -> 'amexAnchor' ->> 'lastAutoBalance')::numeric) < 0.005
      THEN 'refresh-written: refresh keeps moving it'
    ELSE 'entered or unknown: kept; estimate stored beside it'
  END                                             AS anchor_after_merge,
  amex.txn_count,
  amex.estimate_now
FROM households h
LEFT JOIN settings s ON s.user_id = h.owner_user_id
LEFT JOIN LATERAL (
  SELECT count(*) AS txn_count, sum(t.amount) AS estimate_now
  FROM transactions t
  WHERE t.user_id = h.owner_user_id
    AND t.source IN ('amex', 'plaid:amex')
) amex ON true
ORDER BY h.id;

ROLLBACK;
