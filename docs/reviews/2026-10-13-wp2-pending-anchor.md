# WP2 — pending payments + Amex anchor (lane 1)

Branch `fin/wp2-pending-anchor`, from `origin/fin/integration` (e94016de) with WP1 (6f144156) merged in. Not merged. Not deployed. This is approved number move (a).

## The rule
A row tagged to a debt counts as "paid, not posted" when all three hold:
- **Direction:** it pays the debt down. The amount is positive. A row from a bank or card feed must also be one `classifyLiabilityRow` calls a payment.
- **Not a confirmed claim:** it is not the bank row that confirmed a payment claim.
- **Date:** it is dated after the household day of the debt's balance as-of. The as-of is the later of the card's liability fetch and `plaidLastSyncedAt` for a Plaid-sourced linked debt, and `lastBalanceUpdate` otherwise.

## Root cause (8b869e79)
- **Pending cutoff:** `debtPending.ts:77-80`. A row with no time was stamped 23:59:59Z, after any fetch that day, so a payment the balance already held stayed pending and was subtracted twice.
- **Sync tagging:** `plaidSync.ts:1436-1438`. It tagged every positive card row to the debt, refunds and credits included.
- **Anchor write:** `amexAnchor.ts:124-179`. It compared the debts' uuid with Plaid's text ids, never matched, and overwrote "the first debt named like amex".
- **"Statement balance":** `amexAnchor.ts:437-443` is Plaid's current balance under that name.

## What changed
- **`lib/debtPending.ts`:**
  - `pendingFromRows` is the rule above, pure.
  - `balanceAsOfForDebt` gives the balance's as-of.
  - `debtIdForSyncedRow` is the sync's tag rule.
- **Claim lookup:** a self left join on the unique `confirmed_by_txn_id`.
- **`plaidSync.ts`:** both tag sites (cursor and gap backfill) tag payments only. Stored tags are never rewritten; old mis-tags are excluded at read time.
- **`routes/debts.ts`:** one shaping read (`shapeDebts`). `Debt` gains `liabilityAsOf` (the as-of above) and `statement {date, balance, minPayment, dueDate} | null`, the latest `debt_statements` row.
- **`refreshAmexAnchor`** (`pickAnchorDebt`):
  - external ids are resolved to `plaid_accounts.id`;
  - it writes only a sole linked debt;
  - it never writes a Plaid-owned balance unless `adopt`;
  - the name match runs only among unlinked debts, and only when it names one.
- **Spec:** `DebtStatement`; the pending description is rewritten; `statementBalance` is documented as the current balance (no rename).

## Fixture before → after (`/api/debts`, `/api/spine`, `/home`, `/avalanche`)

| Scenario | Figure | Before | After |
|---|---|---|---|
| normal | everything | — | unchanged (HELOC $18,500.00, 26%) |
| +pending | Blue ••1001 pendingPaymentTotal | 54.19 (1) | null |
| +pending | Blue Owed | $629.93 | $684.12 |
| +pending | % paid (spine) | 27.81% (tile 28%) | 27.61% (tile 28%) |
| +pending | "$X left" / Total debt | $19,129.93 | $19,184.12 |
| +platinum-pending | Platinum ••1005 pendingPaymentTotal | 2615.71 (1) | null |
| +platinum-pending | Platinum Owed | $1,227.27 | $3,842.98 |
| +platinum-pending | % paid | 31.60% (32%) | 22.54% (23%) |
| +platinum-pending | "$X left" / Total debt | $19,727.27 | $22,342.98 |
| +platinum-pending | statement (new field) | — | $2,980.44 (Sep 27) |

- **Why +pending moved:** the $54.19 is "TARGET T-1123 REFUND", tagged by the old sync rule. It is not a payment.
- **Why +platinum-pending moved:** the $2,615.71 payment is dated on the as-of day (today), so the balance already holds it.
- **Figures that follow from these:** the debt-free date (Feb 2035 → Jun 2036, and May → Jun 2037), projected interest, and the next milestone on `/avalanche` and in Debt progress. The "Paid, not posted" fact leaves the Accounts rows.

## Tests
- **`debtPending.test.ts`:** one row per clause, the as-of, and the sync rule.
- **`debtsPendingPaymentDecrement`:**
  - a same-day payment timed after the sync is not pending; the next day is;
  - a refresh clears pending;
  - a feed refund does not count; a feed payment does;
  - a confirmed claim and its bank row count once;
  - `liabilityAsOf` and `statement` are served.
- **`plaidSyncDebtTagShape` (new):** the real cursor sync; an old mis-tag is kept but not counted. It fails on the old rule.
- **`amexAnchorDebtPick` (new) + `amexAnchorPick.test`:** 4 of 5 fail on the old code.

**Gates:** typecheck clean · API 243 files, 2,630 passed · web 1,893 / 1,894 passed (UTC / Chicago) · build and entry graph 621.9 KB · audit: 1 high, ignored.

## Flags for the lead
1. **`later()` edge:** `POST /plaid/sync` fetches liabilities without re-applying them to the debts. Until `GET /debts` re-applies (it does within an hour while the dashboard is open), the as-of can sit past a stale `debts.balance`, and pending can read low. This is the plan's rule as written.
2. **Manual same-day:** a payment tagged on the day of a manual balance edit is now taken to be in that balance.
3. **Confirmed-claim skip is defensive:** claims pair only with money-out rows, which the direction rule already drops. A test pins it, and that test caught a join bug.
4. **Historical mis-tags stay stored.** A read-only count would decide whether a backfill is worth it.

## Unverified
- Brad's live figures before → after need a read-only `GET /api/debts`.
- Whether Plaid's $3,842.98 already includes the $2,615.71 needs bank records.
