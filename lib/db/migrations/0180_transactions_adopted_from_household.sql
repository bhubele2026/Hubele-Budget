-- (FIN-2 / WP2 review) A row the household typed in that a Plaid sync merge
-- later adopted: the first-sync merge (#361/#452) and the gap-backfill merge
-- give a typed row the Plaid transaction id instead of inserting a twin. The
-- pending-payment rule counts the household's own tagged rows whatever their
-- wording, but once adopted nothing else on the row says it was typed (the
-- first-sync merge even rewrites `source` to `plaid:<slug>`). The merges set
-- this when they adopt a `manual` row; nothing else writes it.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS adopted_from_household boolean NOT NULL DEFAULT false;

-- Backfill: the gap-backfill merge keeps `source = 'manual'` beside the Plaid
-- id, so those adoptions are still recognisable. (A first-sync merge rewrote
-- `source`; those rows cannot be told apart and stay false.) Idempotent.
UPDATE transactions
   SET adopted_from_household = true
 WHERE source = 'manual'
   AND plaid_transaction_id IS NOT NULL
   AND adopted_from_household = false;
