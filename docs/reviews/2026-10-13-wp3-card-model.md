# WP3 — one card model, one checking view, three freshness stamps (lane 2)

Branch `fin/wp3-card-model`, from `origin/main` 8b869e79, with `origin/fin/integration` (WP7a) and `origin/fin/wp1-checking-model` (6f144156, WP1) merged in. Not merged to main. Not deployed.

- **Implemented:** the card model and every card surface, the checking chip and Summary on WP1's spine view, the savings snapshot rule, the three freshness stamps, the two API pieces (`lib/bankCoverage.ts`, `PlaidAccount.snapshot`), the shared 48 h staleness constant on the web, and the parity test.
- **Tested:** unit, component and parity tests; the API suite; fixture before/after shots for seven scenarios at 1280 and 390.
- **Deployed / enabled:** no / nothing. No flag; no AI, SMS, sync or automation setting changed.

## Root causes (8b869e79)
1. **Platinum "Owed $1,227.27" vs "Current balance $3,842.98".** The dashboard row nets pending payments (`AccountsPanel.tsx:128`, `effectiveDebtBalance`); the account chip (`Accounts.tsx:100`), the detail's "Current balance" (`AccountSummary.tsx:36`) and the Amex register's tier-1 anchor (`amex.tsx:938-951`) print the raw `debt.balance`. Nothing named either figure.
2. **The debt match.** The dashboard matched a debt by the account's internal id OR Plaid's external `account_id` and skipped archived rows (`AccountsPanel.tsx:82-85`); the accounts page matched the internal id and kept archived rows (`Accounts.tsx:90`). `debts.plaid_account_id` is a uuid foreign key to `plaid_accounts.id`, so the external id can never be a real link. One card, two rules: an archived Platinum read "Owed $2,340.55" (Plaid's liability, labelled Owed) on the dashboard and "Owed $0.00" (the archived row) on its chip.
3. **Zero shown as "—".** `AccountSummary.tsx:13-18` treated 0 as missing; `Accounts.test.tsx:207-215` enforced it.
4. **"Statement balance" was the current balance.** The detail read the weekly payoff's `statementBalance` (`AccountSummary.tsx:37`), which is Plaid's current balance, else the debt row, else 0 (`amexAnchor.ts:437-443`). The Amex card band labelled the same field "Statement balance" (`amex-card-band.tsx:151`). The "This week's charges" hint printed `Math.round(pct)` of a 0–1 share ("0% of the statement", `AccountSummary.tsx:44`).
5. **Checking by mask.** `AccountsPanel.tsx:113-116` compared the cash signal's mask to each account's: `"" === ""` matched every account without a mask, and two accounts with the same last four both claimed "Cash held".
6. **Checking chip and detail showed the raw snapshot, undated** (`Accounts.tsx:91-100`, `AccountSummary.tsx:50-55`) beside the dashboard's rolled-forward figure.
7. **"Data through" was the sync day** on the dashboard (`AccountsPanel.tsx:112,167`) and in Settings (`categorizationSettings.ts:100-113`); the chip already used the newest bank row. Two staleness thresholds: 36 h on the web (`bankState.ts:4`), 48 h on the API.
8. **Savings said "not tracked"** on the dashboard and "Balance —" on its chip, while the Summary printed a stored reading under "Balance today".
9. **Debts page:** an archived debt still carrying a balance rendered as "Active" with a balance and counted in "Active" (`debts.tsx:193-196,256`), while the simulator already skipped it.

## What changed
### The card model — `artifacts/h2budget/src/lib/cardBalance.ts` (pure, on the landing path)
- `debtForAccount(debts, acct)`: `debt.plaidAccountId === acct.id` only, any status.
- `cardOwedView({ debt, liability })` → `{state, onPlan, archived, owed, pending {total,count,since}, creditorCurrent {balance, asOf, source}, statement, minPayment, dueDay, status}`:
  - **on the plan** (active): `owed` = `effectiveDebtBalance` (the app's one basis, the same sum `remainingDebtTotal` adds); `creditorCurrent` = the row's balance; `pending` from the payload, `since` = the creditor's last report (`liabilityAsOf` once WP2 sends it, else `plaidLastSyncedAt` / `lastBalanceUpdate` by `balanceSource`, the server's documented rule);
  - **archived**: `owed` null, status "Paid off · not on the payoff plan"; the card's own current balance is Plaid's stored liability figure when there is one, else the row's only if Plaid keeps it current (a manual archived row holds the $0.00 it was archived at);
  - **no debt row**: Plaid's stored liability figures as the card's own, status "Not on the payoff plan";
  - `minPayment` null for the API's "0" (not reported); `statement` = WP2's `Debt.statement` when sent (structurally optional, so nothing breaks before WP2).
- `needsLiability(debt)`: no row, or an archived one. Words: `CARD_WORDS`, `creditorLabel()` ("Card's current balance" / "Loan's current balance"), `asOfWords`, `pendingWords`.

### Surfaces
| Surface | Card | Checking (the spine's account, by id) | Savings / other depository |
|---|---|---|---|
| Dashboard Accounts row (`AccountsPanel.tsx`) | Owed (netted); the card's current balance beside it when a payment has not posted; Minimum, Due, Paid not posted; plan words when off the plan; a skeleton while an archived card's Plaid figures load | `isSpineAccount(acct, spine.bank.account, all)` (WP1); "Cash held" = the spine's balance; no cash-signal read | "Snapshot $X · as of <day> · not rolled forward", or "not tracked yet" |
| Account chip (`AccountSelector.tsx`, `Accounts.tsx`) | "Owed $X" on the plan; else the card's current balance + the plan words | "Balance $X" + "Snapshot $Y · <day> · +N entries" (WP1 `snapshotWords`) | the snapshot line, or the words |
| Summary (`AccountSummary.tsx`) | Owed (+ "after $P paid, not posted"), Card's current balance (+ as-of), Paid not posted (+ "N payments since <day>"), Statement balance (a real statement only), Minimum, Due, This week's charges (share ×100, "of the card's current balance") | "Balance today" = the spine's balance (+ "Includes N entries since the <day> snapshot"), and a "Bank snapshot" block (figure, "<day> · +N entries", the existing freshness line) | "Snapshot" + "as of <day> · not rolled forward", or the words |
| Amex register (`amex.tsx`) | tier-1 anchor = `creditorCurrent` (unchanged value and as-of for an on-plan or Plaid-sourced row); a note: "Running balances start from the card's current balance, $X as of <day>. Owed after payments not yet posted: $Y." | — | — |
| Amex card band | "Statement balance" → "Card's current balance" (same figure) | — | — |
| Debts page | an archived debt is never "Active": paid-off layout, no plan balance ("—") and "Not on the payoff plan" when it still reports a balance; not counted in Active | — | — |

- **Freshness: three stamps** (`lib/accountFreshness.ts`): "synced <t>" (`lastSyncedAt`) · "balance read <t>" (card `creditorCurrent.asOf`; checking `bank.snapshot.at`; savings `snapshot.at`) · "data through <d>" (`lastBankTxOn`). Dashboard row (after the state word), chip, Summary. `agoShort` moved here; `bankState.ts` re-exports it.
- **One staleness constant:** `bankState.ts` `STALE_MS = PLAID_FEED_QUIET_MS` (`@workspace/avalanche-core/freshness`, 48 h). Wording that moves: a bank silent 36–48 h now reads "Up to date" / "synced 1 d ago" (row) and "synced 1 d ago" (header) instead of "Out of date"; the server already called it fresh.
- **`Accounts.tsx` no longer reads the forecast** (`useGetForecast` and `deriveEffectiveSnapshot` dropped): checking comes from `useBankBalanceView()`, other depository accounts from `PlaidAccount.snapshot`, cards and loans from debts + stored liabilities (asked only when a card has no active debt row; same key as the dashboard).
- **Comment fixed:** the AccountsPanel note that the rows "add up to the summary tile's $X left" is gone (an off-plan or archived card is not in that total); the dashboard test is renamed to what it checks.

### API (two small pieces)
- **`lib/bankCoverage.ts` `lastBankTxOnByItem`**: extracted verbatim from GET /plaid/items (`routes/plaid.ts:1151-1180`). Settings › Automation (`categorizationSettings.ts`) now reads it: `lastDataOn` is the newest bank row's date (it was the sync day), and `lastSyncedAt` is a new field. Spec: `CategorizationBank.lastSyncedAt` (required, nullable); `lastDataOn` description. `automationWords.bankLine` prints both: "Chase · data through Oct 5, 2026 · last synced Oct 7, 2026 · Automatic updates On".
- **`PlaidAccount.snapshot {balance, at, source} | null`** on GET /plaid/items (`lib/accountSnapshot.ts`, the Chase page's own rule: the snapshot account reads the `bank_snapshot_*` columns, any other account its `forecast_settings.account_snapshots` entry; no mask fallback). Read-only, no Plaid call. Spec: `PlaidAccountSnapshot`; the property is optional (the single-item mutation responses leave it out).
- CI-style codegen; `git status` clean after a re-run (also after both merges; the spec auto-merge matched `merge-openapi.py` block for block, schema placement aside).

### Bundle
- `pages/next/dashboard/shared.tsx` takes `shortDate` from `lib/dates` (same "Oct 7" for every YYYY-MM-DD, checked month by month): the `components/next` copy lived in `TxnTable.tsx`, and the import kept the whole table (3.4 KB) in the entry chunk. (WP7b fixes the same leak at the barrel; WP1's `lib/bankBalance.ts` imports the barrel's copy.)
- **"Why this number?"**: its body is a lazy chunk (`components/bank-balance-why-body.tsx`); the trigger, the popover and the query stay eager, so nothing is fetched while closed and the answer is still asked afresh on open (−2,481 B).

## Figures that move (fixture, before 8b869e79 → after)
FIGURES_TABLE

## Tests
- **New:** `lib/cardBalance.test.ts` (debt match by internal id only; the live case; liabilityAsOf; manual vs Plaid cutoff; real zero; archived with and without Plaid figures; off the plan; nothing known; statement), `lib/accountFreshness.test.ts` (stamps, short times, household days, the snapshot words), `pages/accountsParity.test.tsx` on `pages/__fixture__/accountsScenario.ts` — the summary row, the dashboard Accounts panel, the accounts page (chips and every Summary), the Debts page and the Avalanche page from one fixture: live case, duplicate mask, zero, archived, missing mask, off the plan, missing, stale, savings (reading and none), checking (balance + snapshot), the amount left, the stamps. Mutation-checked: Owed as the raw balance fails 5 cases; archived read as on the plan fails the archived case.
- **API:** `plaidItemsSnapshot.integration.test.ts` (the snapshot account reads the newer manual columns, another account its map entry, a real "0.00" stays, none is null, never borrowed by mask; data through is household-scoped; no Plaid call); `categorizationVerified` (data date ≠ sync day; another household's newer row never counts; `lastSyncedAt`).
- **Updated:** `dashboard.test.tsx` (off-plan figure is the card's own, archived with and without Plaid figures, the live case, one figure when nothing is pending, stamps, savings, debt link by internal id), `Accounts.test.tsx` (chips and Summary on the model and the spine view; split zero test; a same-mask second checking account; no-mask accounts never match), `bankBalanceWhy.test.tsx` (awaits the lazy body), `automationWords.test.ts`, `AutomationTab.test.tsx`.

## Gates
GATES

## Unverified
- **Live data.** Whether the live Platinum row is active-with-pending (the dashboard nets it to $1,227.27) or archived (then it reads "Paid off · not on the payoff plan" beside Plaid's figure): `GET /api/debts` would say; both paths are built and tested.
- **Statement balance** stays "—" until WP2 sends `Debt.statement`; the fixture's `debt_statements` row (Sep 27, $2,980.44) is not read yet.
- **The register's pending row:** the fixture's $2,615.71 payment raises the register's running "bal" (the card's own feed, pending until posted) — unchanged here; WP2 owns which rows count as pending.
- The plan's `householdScenario` extension (per-step `sinceNet/sinceCount`, a Platinum debt with a liability fetch, a feed payment and a refund) was not in this lane's brief; it sits with WP1/WP2's server pieces.
- E2E specs need Clerk keys; not run.
