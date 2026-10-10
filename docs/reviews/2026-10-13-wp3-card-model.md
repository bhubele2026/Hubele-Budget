# WP3 — one card model, one checking view, three freshness stamps (lane 2)

Branch `fin/wp3-card-model` (from 8b869e79; `fin/integration` merged: WP7a, WP1, WP5b). Not merged to main. Not deployed. Nothing enabled.

## Root causes (8b869e79)
- **Platinum $1,227.27 vs $3,842.98:** the dashboard row nets pending payments (`AccountsPanel.tsx:128`); the chip (`Accounts.tsx:100`), the detail's "Current balance" (`AccountSummary.tsx:36`) and the Amex register's tier-1 anchor (`amex.tsx:938-951`) print the raw `debt.balance`. Neither figure was named.
- **Two debt matches:** the dashboard matched the internal OR external id and skipped archived rows (`AccountsPanel.tsx:82-85`); the accounts page kept archived rows (`Accounts.tsx:90`). `debts.plaid_account_id` is a uuid FK to `plaid_accounts.id`, so an external id is never a link. An archived Platinum read "Owed $2,340.55" on the dashboard and "Owed $0.00" on its chip.
- **Zero as "—":** `AccountSummary.tsx:13-18` (enforced by `Accounts.test.tsx:207-215`).
- **"Statement balance" was the current balance** (`AccountSummary.tsx:37`; the payoff card's `statementBalance` = Plaid current → debt → 0, `amexAnchor.ts:437-443`; same caption on the Amex band). The weekly share printed `Math.round` of a 0–1 fraction ("0%").
- **Checking by mask** (`AccountsPanel.tsx:113-116`): `"" === ""`, and same-last-four accounts all claimed "Cash held". **Chip/detail showed the raw snapshot, undated** (`Accounts.tsx:91-100`, `AccountSummary.tsx:50-55`).
- **"Data through" = the sync day** (`AccountsPanel.tsx:112,167`; Settings `categorizationSettings.ts:100-113`). 36 h staleness on the web (`bankState.ts:4`) vs 48 h on the API.
- **Debts page:** an archived debt with a balance was "Active" (`debts.tsx:193-196,256`); the simulator already skipped it.

## What changed
- **`lib/cardBalance.ts`** (pure): `debtForAccount` (internal id only, any status); `cardOwedView({debt, liability})` → owed (netted, active debts only), creditorCurrent {balance, asOf, source}, pending {total, count, since}, statement (WP2's `Debt.statement`, optional), minPayment (null for "0"), dueDay, plan words. Archived ⇒ "Paid off · not on the payoff plan", never Owed, never in a total; its card's current balance is Plaid's stored figure when there is one, else the row's only if Plaid keeps it current (a manual archived row holds the $0.00 it was archived at). No debt row ⇒ Plaid's stored figures, "Not on the payoff plan". `needsLiability()`.
- **Surfaces:** dashboard row, chip, Summary, Amex register (tier-1 = `creditorCurrent`, same value and as-of; note "Running balances start from the card's current balance, $X as of <day>. Owed after payments not yet posted: $Y."), Amex band caption, Debts page (archived ⇒ paid-off layout, "—", "Not on the payoff plan", not Active).
- **Checking (on WP1):** `isSpineAccount` by id on the dashboard (no cash-signal read); chip "Balance $X" + "Snapshot $Y · <day> · +N entries"; Summary "Balance today" (+ "Includes N entries since the <day> snapshot") and a "Bank snapshot" block. `Accounts.tsx` drops `useGetForecast`.
- **Savings / other depository:** `PlaidAccount.snapshot` ⇒ "Snapshot $X · as of <day> · not rolled forward", or "not tracked yet" (`lib/snapshotWords.ts`).
- **Freshness:** "synced <t> · balance read <t> · data through <d>" (`lib/accountFreshness.ts`) on the row, chip and Summary. `bankState.ts` `STALE_MS = PLAID_FEED_QUIET_MS` (48 h): a bank silent 36–48 h now reads "Up to date · synced 1 d ago", not "Out of date".
- **API:** `lib/bankCoverage.ts` (extracted from GET /plaid/items) — Settings `lastDataOn` is now the newest bank row's date, `lastSyncedAt` added (spec), `automationWords.bankLine` prints both. `lib/accountSnapshot.ts` — GET /plaid/items `PlaidAccount.snapshot` (the snapshot account reads `bank_snapshot_*`, others their `account_snapshots` entry; no mask fallback; no Plaid call). CI-style codegen clean.
- **Bundle:** dashboard `shared.tsx` takes `shortDate` from `lib/dates` (the barrel's copy kept `TxnTable` in the entry chunk); "Why this number?" body is a lazy chunk (trigger, popover and query stay eager; −2,481 B).

## Figures that move (fixture, before → after)
| Scenario · surface | Before | After |
|---|---|---|
| platinum-pending · Platinum chip | Owed $3,842.98 | Owed $1,227.27 |
| platinum-pending · Platinum row | Owed $1,227.27 · Paid, not posted $2,615.71 | + Card's current balance $3,842.98 |
| platinum-pending · Platinum Summary | Current balance $3,842.98 | Owed $1,227.27 (after $2,615.71 paid, not posted) · Card's current balance $3,842.98 as of Oct 9 · Paid, not posted $2,615.71 (1 payment since Oct 9) |
| any · Blue with no debt row (row) | Owed $684.12 | Not on the payoff plan · Card's current balance $684.12 |
| any · Blue with no debt row (chip) | Owed — | Card's current balance $684.12 · Not on the payoff plan |
| archived · Platinum row / chip | Owed $2,340.55 / Owed $0.00 | Paid off · not on the payoff plan · Card's current balance $2,340.55 (both) |
| archived · Platinum Summary | Current balance — · Minimum — | Paid off · not on the payoff plan · $2,340.55 as of Oct 9 · Minimum $85.00 |
| offplan/zero/dupmask/nomask · Platinum Summary | Current balance — · Statement balance $2,340.55 · Min — · Due — · "0% of the statement" | Not on the payoff plan · Card's current balance $2,340.55 · Statement — · Min $85.00 · Due 22nd · "5% of the card's current balance" |
| stale · checking chip | Balance $4,812.37 | Balance $4,788.37 · Snapshot $4,812.37 · Oct 6 · +1 entry |
| stale · checking Summary | Balance today $4,812.37 | Balance today $4,788.37 · Bank snapshot $4,812.37 (Oct 6 · +1 entry) |
| dupmask · Capital One 360 ••5526 and Chase twin ••5526 | Cash held $4,812.37 (each) | Balance is not tracked for this account. |
| nomask · PayPal Balance (no mask) | Cash held $4,812.37 | Balance is not tracked for this account. |
| savings row / chip | not tracked yet / Balance — | Snapshot $6,240.18 · as of Oct 9 · not rolled forward (zero: $0.00) |
| Amex rows · freshness | data through Oct 9 (sync day) | synced 2 h ago · balance read 2 h ago · data through Oct 8 (newest row) |
| Settings · bank line | data through <sync day> | data through <newest row> · last synced <day> |

Unchanged: every Owed on the plan, the debt tile ("$19,727.27 left across HELOC and American Express ••1005"; archived/off-plan cards were never in it), % paid, Cash held, the register's running "bal" for active and Plaid-sourced cards.

## Tests
- New: `lib/cardBalance.test.ts`, `lib/accountFreshness.test.ts`, `pages/accountsParity.test.tsx` on `pages/__fixture__/accountsScenario.ts` (summary row, dashboard row, chips, every Summary, Debts, Avalanche; live, duplicate mask, zero, archived, missing mask, off-plan, missing, stale, savings, checking, amount left, stamps; mutation-checked), API `plaidItemsSnapshot.integration.test.ts`.
- Updated: `dashboard.test.tsx`, `Accounts.test.tsx` (split zero test; same-mask and no-mask checking), `bankBalanceWhy.test.tsx` (awaits the lazy body), `categorizationVerified`, `automationWords`, `AutomationTab`.

## Gates
On the branch after the WP7b merge (710196ab; this note is the only later change):
- `pnpm run build` (root typecheck + every package): clean. CI-style codegen re-run: `git status` clean.
- web vitest: UTC 1,967 passed / 3 skipped; America/Chicago 1,968 passed / 2 skipped (210 files).
- API suite on `h2budget_test_fin_2`: 241 files (+1 skipped: the untracked fixture harness), 2,623 passed, 2 todo.
- entry graph: **620,249 B** of 622,000 (integration 618.4 KB; +1.8 KB for the card model, stamps and spine view on the landing, after the −2,481 B lazy "Why" body).
- `pnpm audit --prod`: 1 high, the already-ignored one.
- Shots (`l2-shots/wp3-{before,after}/<scenario>/`, /home, /next/accounts, /next/accounts/{platinum}, /next/accounts/{chk} at 1280 and 390; scenarios normal+platinum-pending, offplan, archived, zero, stale, dupmask, nomask): 56 + 56, 0 console errors, 0 failed `/api` calls. After set taken on df1ecd12 + WP1, before the WP7b merge (WP7b changes links, not figures).

## Unverified
- Live Platinum: active-with-pending or archived — `GET /api/debts` decides which row it shows; both are built and tested.
- "Statement balance" stays "—" until WP2 sends `Debt.statement`.
- `dupmask` fixture: the first Chase-ledger read runs the existing one-time duplicate-account collapse, which folds the re-linked twin's ATM row into checking ($4,812.37 → $4,752.37 on later pages; consistent within each page). Pre-existing.
- The plan's `householdScenario` extension (sinceNet/sinceCount, Platinum liability, feed payment + refund) was not in this lane's brief.
- E2E (Clerk keys) not run.
