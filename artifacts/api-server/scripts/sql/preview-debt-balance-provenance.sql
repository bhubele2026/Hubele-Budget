-- PR-E preview: debt balance provenance, the Amex page and the Amex sweep. READ ONLY.
--
-- Run BEFORE merging fix/amex-updater-balance-provenance to size, per household,
-- what the merge changes. Nothing here writes: the transaction is READ ONLY and
-- ends in ROLLBACK.
--
--   psql "$DATABASE_URL" -f artifacts/api-server/scripts/sql/preview-debt-balance-provenance.sql
--
-- Query 1 — every debt: whose balance it is, the bank's beside it, and which of
--   the three new row lines the Debts / Future Goal page will show.
-- Query 2 — the Amex page per household: the source it uses today and after the
--   merge, its label, the date a debt-row answer carries, and the saved anchor.
-- Query 3 — the Amex cards the automatic sweep will link to a same-name manual
--   debt (it used to overwrite that debt's balance, APR and minimum).
--
-- `artifacts/api-server/src/__tests__/previewDebtBalanceProvenanceSql.integration.test.ts`
-- runs this file against seeded households and checks every flag.

BEGIN READ ONLY;

-- 1. Every debt, per household.
--   after_merge                         'plaid' = the bank balance, kept current by refreshes (unchanged);
--                                       anything else is kept as entered, never overwritten.
--   entered_date_unknown                a kept balance with no date: shows "date unknown" until edited.
--   entered_date_behind_balance_change  a kept balance whose date is older than the last day
--                                       its balance changed in debt_balance_history: the hand-edit
--                                       symptom (PATCH used to leave the old date).
--   entered_date_older_than_updated_at  looser: any later write (an APR edit, an hourly refresh) counts.
--   shows_use_bank_balance              "Entered … · Bank … · Difference" and the button.
--   shows_refresh_failed                "Couldn't refresh the bank balance" (hidden under the reconnect banner).
--   shows_bank_balance_old              "Bank balance old" (older than 48 hours; hidden under the banner).
--   old_amex_updater_name_match         a debt the old Amex updater could overwrite (first match, no ORDER BY).
WITH history AS (
  SELECT dbh.debt_id, dbh.recorded_on, dbh.balance,
         lag(dbh.balance) OVER (PARTITION BY dbh.debt_id ORDER BY dbh.recorded_on) AS prev_balance
  FROM debt_balance_history dbh
),
last_change AS (
  SELECT debt_id, max(recorded_on) AS last_balance_change_on
  FROM history
  WHERE prev_balance IS NULL OR prev_balance <> balance
  GROUP BY debt_id
),
base AS (
  SELECT
    d.household_id,
    h.owner_user_id,
    d.id                                   AS debt_id,
    d.name,
    d.status,
    d.sort_order,
    d.balance,
    d.balance_source,
    d.last_balance_update,
    d.updated_at,
    lc.last_balance_change_on,
    d.plaid_last_synced_at,
    d.plaid_account_id                     AS linked_plaid_account_uuid,
    pa.account_id                          AS linked_plaid_account_external_id,
    pa.name                                AS linked_account_name,
    pa.mask                                AS linked_account_mask,
    pa.liability_balance                   AS bank_balance,
    pa.liability_last_fetched_at           AS bank_balance_at,
    pi.institution_name,
    pi.last_synced_at                      AS item_last_synced_at,
    pi.last_sync_error_code                AS item_error_code,
    la.attempted_at                        AS last_liabilities_refresh_at,
    la.success                             AS last_liabilities_refresh_ok,
    coalesce(la.error_message, la.error_code) AS last_liabilities_refresh_error,
    coalesce(
      pi.last_sync_error_code IN
        ('ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT', 'INVALID_ACCESS_TOKEN'),
      false
    )                                      AS reconnect_banner_covers
  FROM debts d
  LEFT JOIN households h      ON h.id = d.household_id
  LEFT JOIN plaid_accounts pa ON pa.id = d.plaid_account_id
  LEFT JOIN plaid_items pi    ON pi.id = pa.item_id
  LEFT JOIN last_change lc    ON lc.debt_id = d.id
  LEFT JOIN LATERAL (
    SELECT a.attempted_at, a.success, a.error_code, a.error_message
    FROM plaid_sync_attempts a
    WHERE a.plaid_item_id = pa.item_id
      AND a.kind = 'liabilities'
    ORDER BY a.attempted_at DESC
    LIMIT 1
  ) la ON true
)
SELECT
  household_id,
  owner_user_id,
  debt_id,
  name,
  status,
  balance,
  balance_source,
  CASE WHEN balance_source = 'plaid'
       THEN 'bank (refresh keeps it current)'
       ELSE 'kept as entered (never overwritten)'
  END                                      AS after_merge,
  last_balance_update,
  updated_at,
  last_balance_change_on,
  (balance_source <> 'plaid' AND last_balance_update IS NULL) AS entered_date_unknown,
  (
    balance_source <> 'plaid'
    AND last_balance_update IS NOT NULL
    AND last_balance_change_on IS NOT NULL
    AND (last_balance_update AT TIME ZONE 'America/Chicago')::date < last_balance_change_on
  )                                        AS entered_date_behind_balance_change,
  (
    balance_source <> 'plaid'
    AND last_balance_update IS NOT NULL
    AND last_balance_update < updated_at
  )                                        AS entered_date_older_than_updated_at,
  plaid_last_synced_at,
  linked_plaid_account_uuid,
  linked_plaid_account_external_id,
  linked_account_name,
  linked_account_mask,
  bank_balance,
  bank_balance_at,
  institution_name,
  item_last_synced_at,
  item_error_code,
  last_liabilities_refresh_at,
  last_liabilities_refresh_ok,
  last_liabilities_refresh_error,
  (balance - bank_balance)                 AS entered_minus_bank,
  (
    balance_source <> 'plaid'
    AND bank_balance IS NOT NULL
    AND abs(balance - bank_balance) >= 0.005
  )                                        AS shows_use_bank_balance,
  (last_liabilities_refresh_ok IS FALSE AND NOT reconnect_banner_covers) AS shows_refresh_failed,
  (
    bank_balance IS NOT NULL
    AND last_liabilities_refresh_ok IS NOT FALSE
    AND (bank_balance_at IS NULL OR bank_balance_at < now() - interval '48 hours')
    AND NOT reconnect_banner_covers
  )                                        AS shows_bank_balance_old,
  reconnect_banner_covers,
  (name ~* '(amex|american\s*express)')    AS old_amex_updater_name_match
FROM base
ORDER BY household_id, status, sort_order, name;

-- 2. The Amex page, per household (GET /amex/anchor, combined view).
--   Tiers in order: plaid (a cached card balance) → debt (debts linked to the
--   Amex cards, else debts named Amex) → anchor (a saved balance) → computed
--   (the rows summed) → missing.
--   source_after_merge differs from source_today in one case: a household with
--   Amex rows and an Amex Plaid item but no saved anchor gets one on its next
--   Amex sync, so "Calculated" becomes "From saved anchor". (Before the merge the
--   refresh threw for these households and never wrote one.)
--   debt_tier_as_of_today / _after_merge: the date the debt-row answer carries.
--   Today it is the later of the debts' updated_at and the anchor's asOf. After
--   the merge it is each debt's balance date — the later of last_balance_update
--   (else created_at) and the day its balance last changed in
--   debt_balance_history (noon UTC on that day), the latest across the debts —
--   the rule in lib/debtBalanceDate.ts. The page counts Amex rows only after it.
--   debt_tier_date_move / _risk / amex_rows_between_dates / page_total_change:
--   the dollar effect. Earlier → the page now adds the rows between (right if
--   the balance lacked them, counted twice if it held them). Later → it stops
--   adding them (right if the balance held them, dropped if not).
--   anchor_after_merge: what the estimate refresh does with the saved anchor.
WITH history AS (
  SELECT dbh.debt_id, dbh.recorded_on, dbh.balance,
         lag(dbh.balance) OVER (PARTITION BY dbh.debt_id ORDER BY dbh.recorded_on) AS prev_balance
  FROM debt_balance_history dbh
),
last_change AS (
  SELECT debt_id, max(recorded_on) AS last_balance_change_on
  FROM history
  WHERE prev_balance IS NULL OR prev_balance <> balance
  GROUP BY debt_id
),
amex_accounts AS (
  SELECT pa.household_id, pa.id, pa.type, pa.liability_kind, pa.liability_balance
  FROM plaid_accounts pa
  LEFT JOIN plaid_items pi ON pi.id = pa.item_id
  WHERE (
          pi.institution_slug ~* '(amex|american[-_\s]*express)'
          OR EXISTS (
            SELECT 1 FROM transactions t
            WHERE t.household_id = pa.household_id
              AND t.source IN ('amex', 'plaid:amex')
              AND t.plaid_account_id = pa.account_id
          )
        )
    AND NOT ((coalesce(pa.name, '') || ' ' || coalesce(pa.official_name, '')) ~* 'delta')
),
per_household AS (
  SELECT
    h.id AS household_id,
    h.owner_user_id,
    s.preferences -> 'amexAnchor' AS anchor,
    EXISTS (
      SELECT 1 FROM amex_accounts a
      WHERE a.household_id = h.id
        AND a.type = 'credit'
        AND (a.liability_kind IS NULL OR a.liability_kind = 'credit')
        AND a.liability_balance IS NOT NULL
    ) AS has_plaid_tier,
    EXISTS (
      SELECT 1 FROM debts d JOIN amex_accounts a ON a.id = d.plaid_account_id
      WHERE d.household_id = h.id
    ) AS has_linked_amex_debt,
    EXISTS (
      SELECT 1 FROM debts d
      WHERE d.household_id = h.id AND d.name ~* '(amex|american\s*express)'
    ) AS has_named_amex_debt,
    EXISTS (
      SELECT 1 FROM plaid_items pi
      WHERE pi.household_id = h.id
        AND pi.institution_slug ~* '(amex|american[-_\s]*express)'
    ) AS has_amex_item,
    (SELECT count(*) FROM transactions t
      WHERE t.household_id = h.id AND t.source IN ('amex', 'plaid:amex')) AS household_amex_rows,
    (SELECT count(*) FROM transactions t
      WHERE t.user_id = h.owner_user_id AND t.source IN ('amex', 'plaid:amex')) AS owner_amex_rows,
    (SELECT sum(t.amount) FROM transactions t
      WHERE t.user_id = h.owner_user_id AND t.source IN ('amex', 'plaid:amex')) AS estimate_now
  FROM households h
  LEFT JOIN settings s ON s.user_id = h.owner_user_id
),
debt_tier AS (
  SELECT
    p.household_id,
    sum(d.balance)                                   AS debt_tier_balance,
    max(d.updated_at)                                AS max_updated_at,
    max(
      CASE
        WHEN lc.last_balance_change_on IS NOT NULL
         AND (coalesce(d.last_balance_update, d.created_at) AT TIME ZONE 'America/Chicago')::date
             < lc.last_balance_change_on
        THEN (lc.last_balance_change_on::text || 'T12:00:00Z')::timestamptz
        ELSE coalesce(d.last_balance_update, d.created_at)
      END
    )                                                AS max_balance_date
  FROM per_household p
  JOIN debts d ON d.household_id = p.household_id
  LEFT JOIN last_change lc ON lc.debt_id = d.id
  WHERE (p.has_linked_amex_debt
         AND d.plaid_account_id IN (SELECT a.id FROM amex_accounts a WHERE a.household_id = p.household_id))
     OR (NOT p.has_linked_amex_debt AND d.name ~* '(amex|american\s*express)')
  GROUP BY p.household_id
),
judged AS (
  SELECT
    p.*,
    dt.debt_tier_balance,
    dt.max_updated_at,
    dt.max_balance_date,
    coalesce((p.anchor ->> 'balance') ~ '^-?[0-9]+(\.[0-9]+)?$', false) AS anchor_has_balance,
    CASE WHEN (p.anchor ->> 'asOf') ~ '^\d{4}-\d{2}-\d{2}'
         THEN (p.anchor ->> 'asOf')::timestamptz END            AS anchor_as_of,
    (
      (p.anchor ->> 'balance') IS NULL
      OR (
        coalesce((p.anchor ->> 'lastAutoBalance') ~ '^-?[0-9]+(\.[0-9]+)?$', false)
        AND coalesce((p.anchor ->> 'balance') ~ '^-?[0-9]+(\.[0-9]+)?$', false)
        AND abs((p.anchor ->> 'balance')::numeric - (p.anchor ->> 'lastAutoBalance')::numeric) < 0.005
      )
    )                                                            AS anchor_refresh_owned
  FROM per_household p
  LEFT JOIN debt_tier dt ON dt.household_id = p.household_id
),
sourced AS (
  SELECT
    j.*,
    CASE
      WHEN has_plaid_tier THEN 'plaid'
      WHEN has_linked_amex_debt OR has_named_amex_debt THEN 'debt'
      WHEN anchor_has_balance THEN 'anchor'
      WHEN household_amex_rows > 0 THEN 'computed'
      ELSE 'missing'
    END AS source_today,
    CASE
      WHEN has_plaid_tier THEN 'plaid'
      WHEN has_linked_amex_debt OR has_named_amex_debt THEN 'debt'
      WHEN anchor_has_balance OR (owner_amex_rows > 0 AND has_amex_item) THEN 'anchor'
      WHEN household_amex_rows > 0 THEN 'computed'
      ELSE 'missing'
    END AS source_after_merge
  FROM judged j
),
moved AS (
  SELECT
    s.*,
    dates.date_today,
    dates.date_after,
    (dates.date_today AT TIME ZONE 'America/Chicago')::date AS day_today,
    (dates.date_after AT TIME ZONE 'America/Chicago')::date AS day_after
  FROM sourced s
  CROSS JOIN LATERAL (
    SELECT
      CASE WHEN s.source_today = 'debt' THEN greatest(s.max_updated_at, s.anchor_as_of) END AS date_today,
      CASE WHEN s.source_after_merge = 'debt' THEN s.max_balance_date END                AS date_after
  ) dates
)
SELECT
  household_id,
  owner_user_id,
  source_today,
  source_after_merge,
  CASE source_today
    WHEN 'plaid' THEN 'Live from Plaid'
    WHEN 'debt' THEN 'From saved anchor'
    WHEN 'anchor' THEN 'From saved anchor'
    WHEN 'computed' THEN 'Calculated'
    ELSE 'none'
  END AS page_label_today,
  CASE source_after_merge
    WHEN 'plaid' THEN 'Live from Plaid'
    WHEN 'debt' THEN 'From saved anchor'
    WHEN 'anchor' THEN 'From saved anchor'
    WHEN 'computed' THEN 'Calculated'
    ELSE 'none'
  END AS page_label_after_merge,
  debt_tier_balance,
  date_today                          AS debt_tier_as_of_today,
  date_after                          AS debt_tier_as_of_after_merge,
  CASE
    WHEN day_today IS NULL OR day_after IS NULL THEN NULL
    WHEN day_after < day_today THEN 'earlier'
    WHEN day_after > day_today THEN 'later'
    ELSE 'same day'
  END                                 AS debt_tier_date_move,
  CASE
    WHEN day_today IS NULL OR day_after IS NULL OR day_after = day_today THEN NULL
    WHEN day_after < day_today THEN 'counted twice if the balance already held these rows'
    ELSE 'dropped if the balance did not hold these rows'
  END                                 AS debt_tier_date_move_risk,
  btw.between_sum                     AS amex_rows_between_dates,
  CASE
    WHEN day_after < day_today THEN btw.between_sum
    WHEN day_after > day_today THEN -btw.between_sum
  END                                 AS page_total_change,
  (anchor IS NOT NULL)                AS has_amex_anchor,
  anchor ->> 'balance'                AS anchor_balance,
  anchor ->> 'asOf'                   AS anchor_as_of_text,
  anchor ->> 'lastAutoBalance'        AS anchor_last_auto_balance,
  anchor ->> 'refreshError'           AS anchor_refresh_error,
  CASE
    WHEN owner_amex_rows = 0 THEN 'no Amex rows: the refresh writes nothing'
    WHEN (anchor ->> 'balance') IS NULL AND has_amex_item THEN 'none: the next Amex sync writes balance + estimate'
    WHEN (anchor ->> 'balance') IS NULL THEN 'none: written only by a workbook import'
    WHEN anchor_refresh_owned THEN 'refresh-written: the refresh keeps moving it'
    ELSE 'entered or unknown: kept; the estimate is stored beside it'
  END                                 AS anchor_after_merge,
  household_amex_rows,
  owner_amex_rows,
  estimate_now
FROM moved m
LEFT JOIN LATERAL (
  SELECT coalesce(sum(t.amount), 0) AS between_sum
  FROM transactions t
  WHERE t.household_id = m.household_id
    AND t.source IN ('amex', 'plaid:amex')
    AND t.occurred_on > least(m.day_today, m.day_after)
    AND t.occurred_on <= greatest(m.day_today, m.day_after)
) btw ON m.day_today IS NOT NULL AND m.day_after IS NOT NULL AND m.day_today <> m.day_after
ORDER BY m.household_id;

-- 3. Amex cards the automatic sweep (linkRevolvingAmexDebts) will link to a
--    same-name manual debt. Before the merge it replaced that debt's balance,
--    APR and minimum with the bank's; after, it links only and fills an empty
--    due/statement day.
SELECT
  pa.household_id,
  pa.id                       AS plaid_account_uuid,
  pa.name                     AS account_name,
  pa.mask,
  pi.institution_name,
  pa.liability_balance        AS bank_balance,
  pa.liability_apr            AS bank_apr,
  pa.liability_min_payment    AS bank_min_payment,
  pa.liability_due_day        AS bank_due_day,
  pa.liability_statement_day  AS bank_statement_day,
  d.id                        AS debt_id,
  d.name                      AS debt_name,
  d.balance                   AS entered_balance,
  d.apr                       AS entered_apr,
  d.min_payment               AS entered_min_payment,
  d.balance_source,
  d.due_day,
  d.statement_day,
  'adopted: balance, APR, minimum replaced by the bank''s'                  AS before_merge,
  'linked only: entered values kept; empty due/statement days filled'     AS after_merge
FROM plaid_accounts pa
JOIN plaid_items pi ON pi.id = pa.item_id
LEFT JOIN debts linked ON linked.plaid_account_id = pa.id
JOIN debts d
  ON d.household_id = pa.household_id
 AND d.plaid_account_id IS NULL
 AND d.name = CASE
       WHEN btrim(coalesce(pi.institution_name, '')) <> '' AND btrim(coalesce(pa.mask, '')) <> ''
         THEN btrim(pi.institution_name) || ' ••' || btrim(pa.mask)
       WHEN btrim(coalesce(pi.institution_name, '')) <> ''
         THEN btrim(pi.institution_name) || ' — '
              || coalesce(nullif(btrim(pa.official_name), ''), nullif(btrim(pa.name), ''), 'Account')
       WHEN btrim(coalesce(pa.mask, '')) <> ''
         THEN coalesce(nullif(btrim(pa.official_name), ''), nullif(btrim(pa.name), ''), 'Account')
              || ' ••' || btrim(pa.mask)
       ELSE coalesce(nullif(btrim(pa.official_name), ''), nullif(btrim(pa.name), ''), 'Account')
     END
WHERE pi.institution_slug ~* '(amex|american[-_\s]*express)'
  AND pa.type = 'credit'
  AND (pa.liability_kind IS NULL OR pa.liability_kind = 'credit')
  AND pa.liability_apr IS NOT NULL
  AND pa.liability_min_payment IS NOT NULL
  AND pa.liability_balance IS NOT NULL
  AND pa.liability_balance::numeric >= 1000
  AND linked.id IS NULL
ORDER BY pa.household_id, pa.name, d.name;

ROLLBACK;
