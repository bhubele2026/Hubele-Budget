-- (PERF-3) Three read paths on `transactions` that every page load runs,
-- given indexes that match them. Additive and idempotent: a database where
-- `drizzle-kit push` already built them (dev, tests) changes nothing. Plain
-- CREATE INDEX (no CONCURRENTLY): the runner wraps each file in a transaction,
-- and the table is small enough to build within the file's lock_timeout.
-- The drizzle schema (lib/db/src/schema/index.ts, transactionsTable) declares
-- the same three, by the same names.

-- The pending pairing (supersededPending.ts): each pending row of a household,
-- by account and day, joined to the posted rows that could replace it.
CREATE INDEX IF NOT EXISTS transactions_household_account_pending_idx
  ON transactions (household_id, plaid_account_id, occurred_on)
  WHERE pending;

-- A card's or account's rows over a window (the Amex summary and payoff, the
-- pairing's posted side): account first, then the day range.
CREATE INDEX IF NOT EXISTS transactions_account_occurred_idx
  ON transactions (plaid_account_id, occurred_on);

-- Card discovery (amexAnchorRead.ts): the distinct accounts a household's
-- card-sourced rows sit on.
CREATE INDEX IF NOT EXISTS transactions_household_source_account_idx
  ON transactions (household_id, source, plaid_account_id);
