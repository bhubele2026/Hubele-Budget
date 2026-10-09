-- ============================================================================
-- H2 Budget — why is a paycheck credit filed under Dining & Coffee?
-- READ-ONLY. It looks; it changes nothing. It opens a read-only transaction
-- (the database refuses any write inside it) and ends with ROLLBACK.
-- ============================================================================
--
-- HOW TO RUN IT (about 5 minutes)
--
--  1. Open https://dashboard.render.com and sign in.
--  2. Click the database named "h2budget" (the Postgres one, not the web service).
--  3. Click the "Connect" button near the top right.
--  4. Click the "External" tab. Find "PSQL Command" and click the copy icon
--     beside it. (It starts with PGPASSWORD=... and contains the password.
--     Never paste it into chat.)
--  5. Open the Terminal app (Cmd+Space, type Terminal, press Return).
--  6. Copy this line, paste it into Terminal, press Return. It tells Terminal
--     to use the psql that comes with Postgres.app:
--
--        export PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH"
--
--  7. Paste the PSQL Command from step 4 into Terminal and press Return.
--     Wait for a prompt that ends in  =>  (for example  h2budget=> ).
--  8. Press Cmd+K. This clears the screen so the password line is gone.
--  9. Come back to this file. Press Cmd+A to select all of it, then Cmd+C.
-- 10. Click in Terminal, press Cmd+V, then press Return.
--     It prints four short tables and then the word ROLLBACK.
-- 11. In Terminal press Cmd+A, then Cmd+C, and paste it into the chat.
-- 12. Type  \q  and press Return to disconnect. Close Terminal.
--
-- WHAT IT SHOWS (only these tables: transactions, budget_categories,
-- category_decisions, mapping_rules, merchant_memory — no emails, no tokens)
--   1. Money coming IN (amount above zero) filed in any category whose name
--      contains "Dining", over the last 6 months.
--   2. The categorizer's history for each of those rows: who or what filed
--      it, from which category to which, how sure, and why.
--   3. The mapping rules that point at a Dining category.
--   4. The merchant memories that point at a Dining category.
-- Note: on rows whose source is "amex" (the old Amex workbook import), an
-- amount above zero is a CHARGE, not money in; the first table says which.
-- ============================================================================

\pset pager off
\pset null '(none)'
\x auto

BEGIN;
SET TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

-- 1. Money in, filed under Dining, last 6 months --------------------------------
SELECT
  'positive rows in Dining'                AS "section 1",
  left(t.id::text, 8)                      AS txn_ref,
  t.occurred_on                            AS date,
  t.amount,
  t.description,
  t.source,
  (t.source <> 'amex')                     AS is_money_in,
  c.name                                   AS category,
  t.category_locked_by_user,
  t.category_provisional,
  t.pfc_detailed                           AS bank_says
FROM transactions t
JOIN budget_categories c ON c.id = t.category_id
WHERE c.name ILIKE '%Dining%'
  AND t.amount > 0
  AND t.occurred_on >= (current_date - interval '6 months')
ORDER BY t.occurred_on DESC, t.amount DESC;

-- 2. The categorizer's history for those rows -----------------------------------
SELECT
  'decision history'                       AS "section 2",
  left(t.id::text, 8)                      AS txn_ref,
  t.occurred_on                            AS date,
  t.amount,
  d.source                                 AS decided_by,
  prev.name                                AS previous_category,
  cur.name                                 AS new_category,
  d.confidence,
  d.band,
  d.explanation,
  d.rule_id,
  r.pattern                                AS rule_pattern,
  d.memory_id,
  m.signature                              AS memory_signature,
  d.model,
  d.resolution,
  d.created_at
FROM transactions t
JOIN budget_categories c   ON c.id = t.category_id
JOIN category_decisions d  ON d.transaction_id = t.id
LEFT JOIN budget_categories prev ON prev.id = d.previous_category_id
LEFT JOIN budget_categories cur  ON cur.id = d.category_id
LEFT JOIN mapping_rules r        ON r.id = d.rule_id
LEFT JOIN merchant_memory m      ON m.id = d.memory_id
WHERE c.name ILIKE '%Dining%'
  AND t.amount > 0
  AND t.occurred_on >= (current_date - interval '6 months')
ORDER BY t.occurred_on DESC, txn_ref, d.created_at;

-- 3. Mapping rules that point at a Dining category ------------------------------
SELECT
  'rules pointing at Dining'               AS "section 3",
  c.name                                   AS category,
  r.pattern,
  r.match_type,
  r.priority,
  r.created_at
FROM mapping_rules r
JOIN budget_categories c ON c.id = r.category_id
WHERE c.name ILIKE '%Dining%'
ORDER BY r.priority DESC, r.created_at;

-- 4. Merchant memories that point at a Dining category --------------------------
SELECT
  'memories pointing at Dining'            AS "section 4",
  c.name                                   AS category,
  m.signature,
  m.scope,
  m.count,
  m.source,
  left(m.learned_from_txn_id::text, 8)     AS learned_from_txn_ref,
  m.disabled_at,
  m.created_at
FROM merchant_memory m
JOIN budget_categories c ON c.id = m.category_id
WHERE c.name ILIKE '%Dining%'
ORDER BY m.count DESC, m.created_at;

ROLLBACK;
