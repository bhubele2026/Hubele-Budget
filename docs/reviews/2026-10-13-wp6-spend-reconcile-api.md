# WP6 (server half) — why the Budget's "this month" and household spending differ (lane 1)

Branch `fin/wp6-spend-reconcile-api`, from `origin/fin/integration` (18dfe9c6). Not merged. Not deployed. The change is additive and read-only: it moves no figure.

## What it does
`GET /budget/months/:m` now returns `spendingReconciliation` (spec `SpendingReconciliation`, optional and nullable). It splits the month's two figures into named dollar terms, computed from the same rows by `lib/spendingReconcile.ts reconcileMonthSpend(rows, supersede, filingCtx, spendCtx, splitParts, {today, expenseLineIds})`.

| Figure | What it counts |
|---|---|
| **A**, `budgetActual` | `summary.expenses.actual`: every row filed to an expense line, over the whole month, with transfers skipped |
| **B**, `householdSpendToDate` | The spine's `spentMonth` (`buildSpendingFacts`): rule-10 purchases through today, any category, with refunds netted per account |

The identity, to the cent, with each row in exactly one term:

**A − B = futureDated + cardPayments + debtPayments + excludedNames + reimbursable + bankNoise + splitsOutsideLines − uncategorized − parkedUncategorized + refundsNetted + unexplained**

- **`splitsOutsideLines`** is signed and normally ≤ 0: it is the part of a split purchase filed outside the expense lines.
- **`unexplained`** is the Budget page's own A (`aggregateBudgetMonth`) minus the A this walk attributes row by row. It must be 0. If it isn't, the response says so and the route logs a warning.

Route details:
- **Select:** the route also selects `occurredOn`, `plaidAccountId` and `pfcDetailed` beside the filing. There is no new request.
- **Clock:** `today` comes from the spine's clock (`fmtISO(todayDate())`).
- **`through`:** today for the current month, the month's last day for a past month, and null for a future month.
- **Before tracking:** the field is null for months before `TRACKING_START` (2026-05).

## On the fixture (`normal`, pinned clock Oct 9)

| Figure | Amount |
|---|---|
| Budget actual | $1,522.37 |
| Household spending to date | $783.82 (equal to `spine.spentMonth`) |
| Difference | $738.55 |
| — card payments | +$412.80 |
| — debt payments | +$400.00 |
| — uncategorized | −$74.25 |
| Unexplained | $0.00 |

Brad's October ($5,812.40 vs $3,588.37) has the same shape: mostly seed-filed card payments in Misc / Buffer, debt payments and refunds.

## Tests
- **`spendingReconcile.test` (pure):**
  - one row per term, A and B worked out by hand ($2,237.00 / $212.00, difference $2,025.00);
  - a refund never takes an account below zero;
  - a past month and a future month.
- **`spendingReconcileParity.integration` (randomized ledger):** about 300 rows over the current month, covering every category kind, the Amex and bank sign conventions, pending pairs, splits, rows after today, plus one fixed row per term. The response's `budgetActual` equals `summary.expenses.actual`, `householdSpendToDate` equals `buildSpendingFacts(monthStart, today)`, the identity closes, and `unexplained` is 0.00.
- **`spineParity`:** new row, `householdSpendToDate == spine.spentMonth`, with `budgetActual == summary` and `unexplained` 0.00.

## Gates
- Root typecheck is clean.
- The API suite ran once: 2,719 passed, 1 failed. The failure was `forecastLedger.golden` "default window from today": two plans dragged onto the same day (Rent, Phone) came out in the other order. WP6 touches no forecast code. That file passes alone on this branch and on integration f2ace849. It looks like a same-day ordering flake.
- My two new test files had type errors, which vitest doesn't check. I fixed them and re-ran those files only: they pass.
- CI-style codegen; `git status` is clean after a re-run.
- No web change, so no web gates.

## For lane 2
- The SpendingPanel bridge line can read `terms.cardPayments`, `terms.debtPayments` and `terms.refundsNetted`.
- The "Why these differ" popover can list every term.
