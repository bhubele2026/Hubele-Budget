-- 0220_category_decision_flags.sql — package PREM-Q2 (a fix you can undo).
--
-- A person's category pick can move more than the category: picking Transfer
-- marks the row a transfer and clears its weekly / monthly / unplanned
-- allowance flags, and any hand pick marks the transfer flag as a person's
-- (`is_transfer_user_overridden`). Undoing the decision restored the category
-- only, so a transfer stayed a transfer and its allowance flags stayed off.
--
-- Each `user` decision now keeps those five flags as they were before and
-- after its write:
--     { "isTransfer": bool, "isTransferUserOverridden": bool,
--       "weeklyAllowance": bool, "monthlyAllowance": bool,
--       "unplannedAllowance": bool }
-- Undo puts back each flag the decision changed, while the row still holds
-- the value the decision wrote. Null on every decision written before this
-- file (its undo restores the category only, as before).
--
-- Additive and idempotent: two nullable columns, no default, no backfill.
-- Must agree with `flagsBefore` / `flagsAfter` in
-- lib/db/src/schema/categorization.ts.
ALTER TABLE category_decisions
  ADD COLUMN IF NOT EXISTS flags_before jsonb;
ALTER TABLE category_decisions
  ADD COLUMN IF NOT EXISTS flags_after jsonb;
