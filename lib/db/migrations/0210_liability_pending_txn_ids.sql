-- (F5 round 3 · card balance cap) Which rows were pending when a card's
-- balance was read.
--
-- Plaid's current balance on a card holds its POSTED rows. The everyday hooks
-- cap what H2 holds for a card paid in full at what the card owes now: the
-- balance read, plus the rows outside it. A row still pending is outside it.
-- But Plaid's pending -> posted re-key updates H2's own row in place (same id,
-- `pending` flipped, dated the posting day), so a purchase pending at a morning
-- read that posted later that day read as already inside the balance, and the
-- cap fell below what the card owed.
--
-- The liability fetch keeps, beside `liability_balance`, the ids of the
-- account's rows that were pending at that instant:
--     ["<transactions.id>", ...]
-- (Round 6) Every fetch keeps them, and `liability_pending_after_sync` says
-- whether the fetch followed a transactions sync of the same item in the same
-- request (the Sync button):
--   true          -> H2's rows were current at the read: the cap reads every
--                    row by the instant.
--   false / null  -> any other read (a link, a debt's Refresh): H2's pending
--                    flags may lag the balance, so the list is read for payment
--                    credits and refunds only (pending at the read = outside,
--                    even after it posts in place; a stale flag reads low).
-- A null list: none kept (a read before 0210, or too many pending rows).
--
-- Additive and idempotent: nullable columns with no default, no backfill.
ALTER TABLE plaid_accounts
  ADD COLUMN IF NOT EXISTS liability_pending_txn_ids jsonb;
ALTER TABLE plaid_accounts
  ADD COLUMN IF NOT EXISTS liability_pending_after_sync boolean;
