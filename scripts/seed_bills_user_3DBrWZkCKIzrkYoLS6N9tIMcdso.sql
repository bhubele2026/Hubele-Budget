-- One-shot seeding of the user's 18 recurring bills (totaling $8,466.70/mo
-- for May 2026: 5 weekly events x $450 + monthly sum $6,216.70).
-- Mirrors SEED_RECURRING_ITEMS bills in artifacts/api-server/src/lib/budgetSeed.ts.
--
-- Idempotent skip-by-name at the *group* level: if the user already has any
-- recurring row with a given seed name we leave it untouched (so user-edited
-- bills survive re-runs). Names that appear multiple times in the seed
-- (PlayStation Network, Kwik Trip / gas) are inserted as a single atomic
-- group on a fresh user, because the NOT EXISTS check runs against the
-- pre-seed snapshot.
--
-- category_name values point at the *consolidated* SEED_CATEGORIES from
-- Task #65 (Subscriptions, Car Payments, Utilities, Insurance, etc). The
-- per-user migration in /budget/months/... has already created these for
-- this user, so we don't insert any categories here.
--
-- Target user: user_3DBrWZkCKIzrkYoLS6N9tIMcdso

\set ON_ERROR_STOP on

BEGIN;

WITH target AS (
  SELECT 'user_3DBrWZkCKIzrkYoLS6N9tIMcdso'::text AS user_id
),
seed(name, kind, amount, frequency, day_of_month, anchor_date, category_name) AS (
  VALUES
    ('PlayStation Network',                'bill',           18.98, 'monthly',    5, NULL,         'Subscriptions'),
    ('PlayStation Network',                'bill',           18.98, 'monthly',   16, NULL,         'Subscriptions'),
    ('Hannah''s Car (UW Credit Union)',    'bill',          651.55, 'monthly',    6, NULL,         'Car Payments'),
    ('Toyota Lease',                       'bill',          672.80, 'monthly',    7, NULL,         'Car Payments'),
    ('Kwik Trip / gas',                    'bill',          200.00, 'monthly',    9, NULL,         'Gas, Maintenance & Parking'),
    ('Kwik Trip / gas',                    'bill',          200.00, 'monthly',   24, NULL,         'Gas, Maintenance & Parking'),
    ('Weekly Spend',                       'bill',          450.00, 'weekly',  NULL, '2026-05-02', 'Misc / Buffer'),
    ('Monthly Spend',                      'bill',          440.45, 'monthly',    1, NULL,         'Misc / Buffer'),
    ('TruStage / Ethos',                   'bill',           95.00, 'monthly',   15, NULL,         'Insurance'),
    ('Mortgage (Lakeview)',                'bill',         1989.81, 'monthly',   14, NULL,         'Mortgage (Lakeview)'),
    ('Verizon Wireless',                   'bill',          342.00, 'monthly',   16, NULL,         'Utilities'),
    ('MGE Electric & Gas',                 'bill',          241.00, 'monthly',   20, NULL,         'Utilities'),
    ('Water/Sewer',                        'bill',          101.02, 'monthly',   24, NULL,         'Utilities'),
    ('Student Loan (Nelnet)',              'bill',          237.58, 'monthly',   29, NULL,         'Misc / Buffer'),
    ('Dog Waste Removal',                  'bill',           80.00, 'monthly',    1, NULL,         'Home Maintenance & Warranty'),
    ('State Farm',                         'bill',          121.54, 'monthly',    3, NULL,         'Insurance'),
    ('State Farm Insurance',               'bill',          128.59, 'monthly',    3, NULL,         'Insurance'),
    ('HELOC (Figure)',                     'bill',          677.40, 'monthly',    3, NULL,         'HELOC (Figure)')
),
to_insert AS (
  SELECT
    t.user_id,
    s.name,
    s.kind,
    s.amount,
    s.frequency,
    s.day_of_month,
    s.anchor_date::date AS anchor_date,
    bc.id AS category_id
  FROM target t
  CROSS JOIN seed s
  LEFT JOIN budget_categories bc
    ON bc.user_id = t.user_id AND bc.name = s.category_name
  WHERE NOT EXISTS (
    SELECT 1 FROM recurring_items ri
    WHERE ri.user_id = t.user_id
      AND ri.name = s.name
  )
),
inserted AS (
  INSERT INTO recurring_items
    (user_id, name, kind, amount, frequency, day_of_month, anchor_date, active, category_id)
  SELECT
    user_id, name, kind, amount, frequency, day_of_month, anchor_date, 'true', category_id
  FROM to_insert
  RETURNING id
)
SELECT count(*) AS bills_inserted FROM inserted;

COMMIT;
