-- PR-0 · transactions.category_locked_by_user
--
-- True when a person chose this row's category by hand. The categorizer
-- (PR-A) never moves a locked row. Plaid sync never writes the column.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS category_locked_by_user boolean NOT NULL DEFAULT false;

-- Backfill from the best stored evidence of a hand-filed category: PATCH
-- /transactions/:id, bulk-update and recategorize-by-pattern have always set
-- is_transfer_user_overridden whenever a person picks a category. It is an
-- approximation: it also covers a row whose transfer flag alone was toggled
-- on top of a rule-filed category, and it misses hand-typed rows created with
-- a category. Idempotent: it only touches rows still false.
UPDATE transactions
   SET category_locked_by_user = true
 WHERE is_transfer_user_overridden = true
   AND category_id IS NOT NULL
   AND category_locked_by_user = false;
