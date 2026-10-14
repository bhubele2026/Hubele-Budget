-- (S4 · banking review) The last bank-balance tie a manual Sync checked.
--
-- A manual Sync already compares the bank's own balance with the snapshot
-- rolled forward through the ledger's rows (`reconcileBankBalance`), but the
-- answer was returned to that one request and never kept. The banking review
-- reports "ties / drift / not checked" beside the review inbox, so the Sync now
-- keeps its last answer here, exactly where it computes it:
--     { "checkedAt": "<ISO instant>", "accountId": "<Plaid account id>",
--       "unexplained": "<bank − ledger, 2 decimals>", "status": "ties" | "drift" }
-- Null until a manual Sync checks the balance. Read-only everywhere else.
--
-- Additive and idempotent: a nullable column with no default, no backfill.
ALTER TABLE forecast_settings
  ADD COLUMN IF NOT EXISTS last_bank_reconciliation jsonb;
