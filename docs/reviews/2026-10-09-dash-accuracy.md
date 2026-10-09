# Dashboard accuracy fixes (Phase 1, builder A)

Branch `restore/dash-accuracy`, from `origin/main` 6d159935. Not merged, not deployed.

Five defects were seen live on `/home`. Three are fixed in code. One is reported only (mixed spending scopes, plan item 4). One waits on a read-only query the owner runs (payroll in Dining).

What builder B can call, all pure and tested:

| Helper | File | What it answers |
|---|---|---|
| `resolveTxnAccount(txn, entries)` | `src/lib/accountIdentity.ts` | Which account a transaction belongs to: identity + `known` |
| `lowPointView(forecast, { buffer, stale })` | `src/lib/lowPoint.ts` | Low point: `kind`, `value`, `date`, `words`, `tone`, `stale` |
| `isInflowFiledAsExpense(txn, categoriesById)` + `categoriesByIdOf` | `src/lib/categoryDirection.ts` | The "Income filed under an expense category" review flag |
| `occurrenceAmountOn(item, dateISO)` | `api-server/src/lib/billsSummary.ts` | One payment of a recurring item on a given date |

---

## 1. Weekly Spend showed $2,250 as the next bill; the Briefing said $450

### Cause
- `pickNextBill` quoted the row's month total: `api-server/src/lib/billsSummary.ts:400` (`amount: r.monthlyAmount`).
- `monthlyAmount` adds up every occurrence in the month: `billsSummary.ts:185-191` (`monthlyAmountAbs` sums `expandItem` over the month).
- So a $450 weekly bill with 5 Saturdays in October came out as $2,250.
- The recap made the same mistake: `api-server/src/recap/facts.ts:273` (`amount: Math.abs(numOrNull(b.monthlyAmount))`).
- The Briefing's action card was already right: it reads the stored single amount (`h2budget/src/lib/attention.ts:47`, `r.item.amount`).

### Fix
- New `occurrenceAmountOn(item, dateISO)` in `billsSummary.ts`. It is the same `expandItem` expansion the month total adds up, read for that one date.
- `pickNextBill` (the spine's `nextBill`) and the recap's `billsNext3Days` now use it.
- Bills rows keep their month total and still read "$450 weekly · ~$2,250/mo" (`h2budget/src/lib/billsRowAmount.ts`). The Bills monthly totals are unchanged.
- No spec change: `SpineNextBill.amount` is still a string. Its description never mentioned the month.

### Figures that change (sample)
- Dashboard "Next bill" (`UpcomingPanel.tsx:48`): Weekly Spend · Sat Oct 10 **$2,250.00 → $450.00**.
  - ⚠️ Superseded by the refinement note's Header section (`2026-10-09-dashboard-refinement.md`): the dashboard's "Next bill" box is gone, and the header quotes the cash-signal event (a hook reads "card payoff $477.57 (plan $450)").
- Bills overview headline (`pages/bills-overview.tsx:43,88`): same change.
- Command center "Next bill" tile (`pages/command-center.tsx:386,437`): same change.
- Morning recap: "Due soon: … Weekly Spend **$2,250 → $450** Sat".
- Monthly bills are unaffected: one occurrence equals the month.
- Debt minimums are unaffected: they already used their own amount.
- `billsDueCount` is unchanged.

### Tests
- `api-server/src/__tests__/billsNextBillAmount.test.ts` (pure): weekly next = 450 while the row's month total stays 2,250. Monthly and debt-minimum amounts are unchanged. Covers the fallback.
- `spineParity.integration.test.ts`, new case: with a $450 weekly bill due today, the spine's `nextBill` is `{ amount: "450.00" }`. It equals `pickNextBill(/bills/summary)`. The row's `monthlyAmount` is 450 × the number of that weekday in the month.
- `recapFacts.integration.test.ts`, new case: `billsNext3Days` carries 450. The Bills row is still "2250.00". The template text reads "Due soon: Electric $90 tomorrow, Weekly Spend $450 Fri and more." and never "2,250".
- Both integration cases fail on `origin/main`'s code. I checked by stashing the fix and re-running them.

### Remaining divergence (reported, not changed)
- Weekly Spend is an everyday **date hook**. The forecast ignores its stored $450 and uses the **card payoff** for that period instead: charges plus what is left of the allowance (`api-server/src/lib/forecastLedger.ts:283-292`, `:408-420`, `:1078-1100`).
- An unpaid payoff that is already due moves to the next business day on the curve.
- So the next bill ($450, stored, on its scheduled date) and the forecast event for the same Saturday can differ in amount, and after the due date also in date.
- Proposed fix, for the owner's OK: for a hook item, `pickNextBill` reads the ledger's payoff for that occurrence and labels it "card payoff". The spine parity test would then compare it to the cash-signal event.
- Builder B's Upcoming list labels hook items "card payoff" in the meantime (plan, Phase 2 item 3).

### Live data that would confirm it
- On a day when Weekly Spend is next: `GET /api/spine` → `nextBill.amount` = `"450.00"`.
- `GET /api/bills/summary` → that row's `monthlyAmount` = `"2250.00"`.
- The dashboard, Bills overview and recap preview all say $450.
  - ⚠️ Superseded for the dashboard by the refinement note's Header section (`2026-10-09-dashboard-refinement.md`): it quotes the hook-aware cash-signal event ("Weekly Spend · card payoff $477.57 (plan $450)"); the Bills overview and the recap still say $450.

---

## 2. Recent activity showed "Account" on every row

### Cause
- Transactions carry Plaid's **external** `account_id`: `api-server/src/lib/plaidSync.ts:1570,1744` write `plaidAccountId: t.account_id`.
- `ActivityPanel` built its lookup on the **internal** `plaid_accounts.id`: `h2budget/src/pages/next/dashboard/ActivityPanel.tsx:24,29` (`[a.id, identityOf(...)]`). It then asked that map with the transaction's external id (`:33`).
- Nothing matched, so every row fell back to `identityOf({ name: t.account })` (`:34`).
- `t.account` is usually null, which gives the generic label "Account".
- The test hid it. Its fixture put the internal id on the transaction (`dashboard.test.tsx:300`, `plaidAccountId: "c1"`), while `acct()` gives the account `accountId: "p-c1"` (`:66`). Real data never has that shape.

### Fix
- `resolveTxnAccount(txn, entries)` in `src/lib/accountIdentity.ts`.
- `entries` is the existing `buildEntries` mapping (`pages/next/accounts/entries.ts`), keyed by the external `plaidAccountId`. An array or a Map both work.
- A match returns that account's identity with `known: true`.
- Fallbacks by `source`, all with `known: false`:
  - `amex` → "Amex (imported)", with the Amex accent;
  - `manual` → "Manual entry";
  - `plaid:<slug>` with an unknown id → "<institution> (no longer linked)". The name comes from a linked item with the same slug, else from a known name or the slug title-cased;
  - anything else → "Unknown account".
- The free-text `account` field is never trusted as an identity.
- `entries.ts` now also carries `institutionName` and `institutionSlug`. Both are optional, so existing literals still compile.
- Wired into `ActivityPanel` (a 3-line change). Its row link goes to the account page only when the account is known.

### Same wrong-id lookup elsewhere (grep of web and API)
- No other place keys a transaction's `plaidAccountId` against the internal row id. Checked:
  - `transactions.tsx:330-360` and `forecast.tsx:729-745` both map row id → `accountId` first;
  - `amex.tsx:746-783` and `:1854-1870` key by `accountId`;
  - `LearnedRulesPanel.tsx:441-444` keys by both;
  - `Accounts.tsx` `CombinedActivity` keys by the external id;
  - API: every `transactionsTable.plaidAccountId` comparison uses `plaidAccountsTable.accountId` or an external id (`plaidSync.ts:2392,2947`, `routes/plaid.ts:1156-1178`, `routes/amex.ts:179-206`, `bankBalanceExplain.ts:154`).
- Related honesty fix: `Accounts.tsx` `CombinedActivity` labelled **every** unmatched row "Manual entry", including Amex imports and unlinked banks. It now uses `resolveTxnAccount`. Test in `Accounts.test.tsx`.
- `AccountsRow` matches debts by either id and the Amex payoff card by the internal id. That is correct, because the payoff card's `plaidAccountId` is the row id (`Accounts.tsx:58-64`).

### Figures that change (sample)
- Dashboard Recent activity, Account column:
  - "Account" → "Chase Total Checking ••5526";
  - "Account" → "American Express Platinum ••1005";
  - a manual row → "Manual entry";
  - a workbook row → "Amex (imported)";
  - a row from an unlinked card → "Chase (no longer linked)".
- Accounts → combined view: unmatched rows "Manual entry" → the honest label.
- No amount changes.

### Tests
- `accountIdentity.test.ts`:
  - external-id match from an array and from a Map;
  - **the internal id never matches**;
  - each fallback;
  - slug naming;
  - free text is ignored.
- `dashboard.test.tsx`:
  - fixture corrected to `p-c1` with a comment on why;
  - a new case with an Amex import, an unlinked bank, an unknown source and the internal id on a row, asserting no row says "Account".
- `Accounts.test.tsx`: the combined view names Amex import, manual and unlinked rows.

### Live data that would confirm it
- `/home` Recent activity: every row names its card or bank with ••last4.
- Pick two rows and open them: the account page matches.
- Any row reading "(no longer linked)" is a real unlinked account. Its `plaidAccountId` is absent from `GET /api/plaid/items` `accounts[].accountId`.

---

## 3. The projected low point was blank

### Cause
- `h2budget/src/pages/next/dashboard/CashPanel.tsx:19` treated `status === "not_yet"` the same as `no_data`, then printed "—" (`:20,45`).
- `not_yet` is the server's verdict for **low point under the buffer** (`api-server/src/lib/cashSignal.ts:430-433`: `lowest < cashBuffer`). It is the day the figure matters most.

### Fix
- `lowPointView(forecast, { buffer, stale })` in `src/lib/lowPoint.ts`.
- It reads the server's verdict and computes no new money figure:
  - `no_data` → `none`: no value, no date, "No bank balance yet, so no forecast";
  - `not_yet` → `below`: value, date, "below your $500 buffer";
  - `tight` → "just above your $500 buffer";
  - `ready` → `ok`: "above your $500 buffer".
- A negative value carries the bad tone.
- A stale bank keeps the figure and adds ", from an out-of-date bank balance". It is never shown as $0.
- `CashPanel` now uses it in place of the `noForecast` gate. The under-buffer gap reads "short by $150.00".

### Figures that change (sample)
- Low point, when below the buffer: **"—" → "$350.00 · Oct 20 · below your $500 buffer · short by $150.00 · stays positive, next 90 days"**.
  - ⚠️ Superseded on the dashboard by the refinement note's Header section (`2026-10-09-dashboard-refinement.md`): the summary's low point reads "… · short by $X · below zero in N days" and no longer says "stays positive".
- Tight and ready gain their words. The runway line now shows for `not_yet` too.
- Spine values are unchanged.

### Tests
- `lowPoint.test.ts`: `not_yet`, negative tone, `tight`, `ready`, `no_data`, stale bank, and buffer sourcing (whole dollars vs cents, and missing).
- `dashboard.test.tsx`:
  - the default fixture is now a consistent `not_yet` (350 under 500 had been labelled `tight`, which the server never sends);
  - `not_yet` shows value, date and words;
  - separate cases for `tight` / `ready` and a stale bank;
  - `no_data` still shows "—".

### Live data that would confirm it
- When `GET /api/spine` returns `forecast.status = "not_yet"`, `/home` shows `forecast.lowPoint` and `lowPointDate` with "below your $X buffer".

---

## 4. Mixed spending scopes (reported only; nothing changed)

These are the same panel's figures counted over different populations. Each item has a proposed fix for the owner's OK.

### 4a. "Allowances used" vs "This week vs limit"
- Evidence:
  - the allowance sums are added up in the browser (`SpendingPanel.tsx:59-61`, `bucketSpend.ts:54-69`);
  - they run over the newest ≤100 rows of a window spanning week ∪ month (`SpendingPanel.tsx:13,44`);
  - only rows with an explicit bucket flag count, and refunds are not netted;
  - the weekly cap comes from `settings.weeklyAllowanceAmount` + override (`SpendingPanel.tsx:67`).
- The week meter beside it reads `/money/position`. That figure classifies every movement in the week (`moneyPosition.ts:184-197`), nets refunds (`allowanceRowOf`), and takes its cap from allowance plans (`moneyPosition.ts:200-203`).
- Effect: on one panel, "This week vs limit $80 of $250" can sit beside "Weekly $120 of $200". A busy month can also drop rows past 100. The cap is disclosed, but the sums still move.
- Proposed fix: show only the position's week figure on the dashboard. Builder B already moves the browser allowance sums to `/allowances` (plan, Phase 2 item 5). Longer term, `/allowances` reads a server aggregate.

### 4b. "This month vs budget" counts card payments
- Evidence:
  - the seed rules file checking-side card payments under **Misc / Buffer**, an expense category (`api-server/src/lib/mappingSeed.ts:19-24`: "AMERICAN EXPRESS ACH", "AMEX EPAYMENT", "CAPITAL ONE CRCARDPMT", …);
  - the transfer heuristic that would have flagged them is off (`lib/api-zod/src/transferHeuristic.ts:31-33`, #666);
  - Budget category actuals skip **transfers only** (`api-server/src/lib/budgetActuals.ts:102`);
  - `summary.expenses.actual` adds up every expense line (`routes/budget.ts:2095-2112`).
- The spine's "Household spent" on the same panel (`SpendingPanel.tsx:85`) excludes card payments by pattern (`classifyOutflow` / `matchesCardPaymentPattern`).
- Effect, in sample terms: a $1,200 Amex payment from checking that nobody has marked as a transfer adds $1,200 to "This month vs budget". The card's purchases are counted too, so the same money counts twice. "Household spent" leaves the payment out.
- Proposed fix, choose one:
  - (i) point the card-payment seed rules at a non-spend category such as "Transfer" (a data change, needs his OK);
  - (ii) have the Budget expense actuals skip rows `classifyOutflow` calls a card payment (a money-logic change, needs his OK).

### 4c. "Biggest charges" shows Amex-workbook refunds as charges
- Evidence:
  - `isSplurge` treats any negative amount as a charge (`h2budget/src/lib/discretionarySpend.ts:126-140`, `a >= 0 → false`);
  - but on `source = "amex"` (the workbook import) a negative amount is a refund and a positive one is the charge (`lib/avalanche-core/src/spendingRule.ts:382-387`, `:676-681`);
  - the bar takes `Math.abs(amount)` (`SpendingPanel.tsx:53-54`).
- Effect: a $60 workbook refund appears as a $60 "charge", and workbook charges never appear.
- Proposed fix: decide the charge with the shared `spendAmount(t) > 0` instead of the sign.

### 4d. (found while fixing 2) Amex-workbook rows show the wrong sign in activity lists
- Evidence: `displayAmount` assumes negative = money out on every account (`h2budget/src/lib/amountDisplay.ts:12-16`). That is not true for `source = "amex"` (same lines in `spendingRule.ts` as 4c).
- Effect: a $45 workbook charge reads "+$45.00" in Recent activity and the Accounts combined view. The rows are now labelled "Amex (imported)", which makes the wrong sign easier to see.
- Proposed fix: have `displayAmount` take the row's `source` and flip `amex` rows, with a test. That is a display rule only; no total changes.

### Live data that would confirm 4a–4d
- 4a: compare `GET /api/money/position` `spentWeekDiscretionary` / `weekCap` with the dashboard's "Allowances used · Weekly".
- 4b: list this month's Misc / Buffer rows. Any "AMERICAN EXPRESS ACH PMT" there is the gap between `GET /api/budget/<month>` `summary.expenses.actual` and the spine's `spentMonth`.
- 4c, 4d: any `source = 'amex'` rows in the current month.

---

## 5. A payroll credit filed under Dining & Coffee

### Deliverable
- `docs/reviews/payroll-dining-query.sql`.
- Strictly read-only: `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;` with a 30 s statement timeout. Click-by-click steps for the owner are at the top.
- It lists:
  - money-in rows (amount > 0) in any category named like `%Dining%` over the last 6 months, with date, amount, description, source, whether the money is in (`source <> 'amex'`), the lock and provisional flags, and Plaid's own category;
  - each row's `category_decisions` history: source, previous → new category names, confidence, band, explanation, rule id + pattern, memory id + signature, model, resolution, created_at;
  - the `mapping_rules` pointing at Dining: pattern, match type, priority, created_at;
  - the `merchant_memory` rows pointing at Dining: signature, scope, count, source, learned-from transaction, disabled, created.
- It touches only `transactions`, `budget_categories`, `category_decisions`, `mapping_rules` and `merchant_memory`. No emails.
- Checked locally against a scratch test database with a seeded payroll-in-Dining row: all four sections return the expected joined row. The seed data was removed afterwards.

### Leading hypothesis (to confirm from his output)
- Before 3df2aa68, changing a row's category **re-pointed every "specific" (2+ word) mapping rule whose pattern matched that row** to the new category. It also inserted a new 2-word rule from the description. See the pre-3df2aa68 `routes/transactions.ts:163-190` (pattern derivation, `isPatternSpecific`) and `:459-490`, `:617` (`update(mappingRulesTable).set({ categoryId })`).
- A paycheck-shaped rule (for example "ACH DEPOSIT" or "<employer> PAYROLL") could have been snapped onto Dining by one Dining filing. Every paycheck since then would follow it.
- 3df2aa68 removed that auto-rule. Rules are now user-authored only, so the rule itself would still be there.
- What would confirm it:
  - section 2 shows `decided_by = rule` with a 2-word `rule_pattern`;
  - section 3 lists that rule with a `created_at` before Oct 7, 2026.
- No history rewrite is proposed.

### Fixes proposed as separate changes, each for the owner's OK
- Re-point or delete the offending rule from the Mapping rules screen. That is the owner's own action and needs no code.
- **Categorizer direction guard** (code): in the categorizer engine, a rule, memory or model decision that files an **inflow** into an **expense** category is held for review (band `queue`, never `auto`), unless the shared `classifyRefund` calls it a refund. The mirror applies to an outflow into an income category. It would be built from the same rules as the flag below.
- Dashboard side (built, not yet surfaced): `isInflowFiledAsExpense(txn, categoriesById)` in `src/lib/categoryDirection.ts`, the deterministic "Income filed under an expense category" flag. It flags an inflow by `incomeAmount` (an Amex-workbook positive amount is a charge, so never), that `isRealIncome` would count if it were filed under income (not a transfer, not a debt row or debt category, not an excluded category), in an existing expense category, and not a refund by `classifyRefund`. Builder B surfaces it in Needs attention.
  - Open choice: a credit the household marked `reimbursable` is flagged too, because the shared refund rule does not treat it as a refund. Say if those should be left out.

---

## Gates (all green on the final commit)
- Root `pnpm run typecheck`: pass.
- Web suite: TZ=UTC 1816 passed / 3 skipped; TZ=America/Chicago 1817 passed / 2 skipped (204 files).
- API suite on `h2budget_test_dashacc`: 237 files, 2572 passed, 2 todo.
- `pnpm run build` + `check-entry-graph`: landing JS **622.0 KB**, cap 622.0 KB, main 620.4 KB.
  - These helpers add +1.6 KB to the landing path:
    - `resolveTxnAccount` ~0.9 KB. It lives in `accountIdentity.ts`, which is on the entry path, so the lazy Recent activity's use of it still lands there.
    - `lowPointView` ~0.5 KB.
    - CashPanel ~0.2 KB.
  - The cap is unchanged, but **headroom is now ~0**. Builder B's move of Upcoming and Spending behind lazy skeletons has to free bytes before the new header can go in.
- `pnpm audit --prod`: exit 0. The one high is the already-ignored `braces` advisory (`pnpm-workspace.yaml` `auditConfig`).
- E2E needs Clerk keys and was not run.

## Status
- Implemented and tested: 1, 2, 3, plus the 5 flag helper.
- Reported only: 4a–4d, and the hook divergence in 1.
- Waiting on the owner's query output: 5.
- Deployed: no. Enabled: n/a (no flags).
