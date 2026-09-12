# PR-D — the Budget page counts a pending purchase once

- **Base:** `main` = `df2adda`.
- **Branch:** `fix/budget-pending-once`.
- **Owner decision 6:** "Budget should count pending purchases consistently with Spending: once. Show posted spending,
  pending spending, combined spending so far. Pending purchases consume available budget. When they post, replace the
  pending version and adjust for the final amount. Example: a $40 pending restaurant charge posts at $48 → spending
  becomes $48, not $88. Budget and Spending must use the same inclusion rules."

## The problem

`GET /budget/months/:m` summed rows in SQL. A pending row and the separate posted row that replaced it both counted:
- in each category's `actualAmount` and its `sourceBreakdown`;
- in the allowance card's sums.

PR7b fixed Spending and pinned the Budget page's gap as a KNOWN RESIDUAL (review M2): June "Eating out" read 134.40 on
the Budget page and 69.40 on Spending.

## What changed

**Server — `routes/budget.ts`, month read.**
- **One pairing per request.** It reads the month's pending row ids first. Only if there is one does it call
  `loadSupersededPendingIds(householdId)`, the set Spending, the spine, Habits and the Amex payoff already use.
- **Pairing runs over the whole ledger.** A month's answer does not depend on which month is on screen. No second
  pairing rule was written.
- **Replaced rows count nowhere.** The month's replaced pending ids go into `NOT IN` on both aggregates: category
  actuals and allowance. The list is bounded by the month's pending rows; it is empty (`true`) when there are none.
- **Both aggregates group by `pending` too.** Per category, posted and still-pending sums are kept in whole cents.
  `actualAmount` = posted + pending.
- **`sourceBreakdown` merges both halves per source** before its spend-else-inflow pick, so it is the same pick over the
  same rows as before.
- **The allowance keeps the split.** `lib/budgetAllowance.ts buildAllowanceRollup` reads the new `pending` column per
  aggregate row (absent = posted) and carries the split per bucket and in total, in cents.

**API (additive; `openapi.yaml` + codegen, generated `src` and `dist` committed).**
- `BudgetLineWithActual`: `postedAmount`, `pendingAmount`, `combinedAmount` (= `actualAmount`).
- `BudgetAllowanceLine` and `BudgetAllowanceRollup`: `posted`, `pending`, `combined` (= `actual`).
- `BudgetMonthDetail.replacedPendingIds`: the month's replaced pending rows, so the actuals drill can leave them out and
  still tie to its row.

**Web (Budget page, lazy route).**
- **Row:** "incl. $40.00 pending" in the row's strip below the figures, only when pending > 0. The Spent figure keeps
  the row baseline.
- **Actuals popover:**
  - "Posted $X · Pending $Y" under the head when pending > 0;
  - the list drops `replacedPendingIds`;
  - a still-pending row reads "· pending".
- **Allowance card:** "incl. $X pending" under "spent" in the head, and under a bucket's Spent column.
- **Foot copy:** "Spend is what has cleared" was already wrong, since pending rows always counted. It now says a pending
  purchase counts once, at its final amount when it posts.
- **Style:** mono numerals, neutral ink, no new component, no new colour.

## Figures that move (before = `df2adda`, after = this branch)

Live, only where a month holds a pending row that a posted row replaced (PR4c pairing: same account, posted within 7
days, |pending| ≤ |posted| ≤ 1.30 × |pending| + $1, created later).

- **Down, by the replaced pending amount:**
  - category `actualAmount`;
  - `groups[].actualTotal`;
  - `summary.income/expenses/net/percentSpent.actual`;
  - `planBySource.*.actual` and `planBySource.actualTotal` (the "Spent so far" tile, "in so far" on Income);
  - `sourceBreakdown` count and amount;
  - allowance `actual` per bucket, its slices and the total (the plan strip's allowance figure).
- **⚠️ A month's figure can fall after the month ends.** A pending charge dated on the 30th that posts on the 1st now
  counts in the month it posted only. Spending already does this.
- **Income:** a replaced pending deposit no longer counts twice in an income line.

**Tests, measured:**

| Case | Before | After |
|---|---|---|
| Owner's example, $40 pending then $48 posted (July) — category actual | 88.00 | **48.00** (posted 48 / pending 0) |
| The same, before it posts | 40.00 | **40.00** (posted 0 / pending 40) |
| Pending $20 + posted $40, too large to pair — still two charges | 60.00 | **60.00** (posted 40 / pending 20) |
| Pair across 9/30 → 10/01: September / October | 40.00 / 48.00 | **0.00 / 48.00** |
| Pending + posted $500 payroll deposit — income line | 1000.00 | **500.00** |
| Allowance: weekly $40 pending → $48 posted, plus $15 monthly pending — weekly / total | 88.00 / 103.00 | **48.00 / 63.00** (total posted 48 / pending 15) |
| Plan-pin month: $160 pending replaced by $175, plus $30 pending — Utilities actual | 365.00 (measured on base) | **205.00** |
| June "Eating out" (PR7b residual test): Budget / Spending | 134.40 / 69.40 | **69.40 / 69.40** |

**Not measured:** production. It needs a read-only production query Brad approves.

## Must not change

- **The plan.**
  - `plannedAmount` on every line, and `planSource`.
  - `planBySource.{income,bills,debts,unbacked}.planned` and `lineCount`.
  - `planBySource.plannedTotal` and `net`.
  - The allowance caps.
  - Pinned by `budgetPendingOnce.integration.test.ts` "MUST NOT CHANGE — the plan": the same before and after pending
    and posted rows land, and `plannedTotal` = bills + debts. `budgetPlanBySource.integration.test.ts` passes unchanged.
- **Rows without a replaced pair.** Same figures: the only change on them is cents accumulation instead of float
  accumulation of two-decimal SQL sums, which cannot differ at the cent.
- **Untouched:** Spending, the spine, cash, the forecast, `supersededPending.ts` and `pairPendingWithPosted`. Nothing is
  written or re-tagged; both rows stay in the ledger (asserted).

## Budget's SQL vs Spending's rule (`classifyOutflow`) — differences NOT changed here

Only the pending pair was decided in this PR. Everything below differs today and is a question for the owner.

**Category actuals:**
1. **Tagged rows count.** Budget counts a row tagged to a debt (`debtId`, rule 2) and a row flagged
   `isExternalCardPayment` (rule 3) in its category. Spending excludes both.
2. **Debt categories count.** Budget counts rows in a debt-linked category (rule 4); the auto_debts lines show payments
   as their actual. Spending calls those debt payments.
3. **Excluded category names differ.** Budget hides only `exclude_from_budget` categories (Uncategorized, Transfer,
   Ignore). Spending also excludes by NAME "Reimbursement", "Transfers in", "Transfers out" and "Uncategorized —
   transfer" (rule 5). Those show a Budget actual.
4. **Reimbursable rows count** in their category on Budget (rule 7).
5. **No pattern rules.** Budget counts Plaid PFC card payments (rule 8), card-payment description patterns (rule 9) and
   bank-noise patterns (9b). Spending excludes all three.
6. **Income differs.** A Budget income line sums inflows including manual-Amex credits (negative `amex` amounts).
   Spending's `realIncome` counts no Amex row.

**Allowance card:** excludes rules 1, 2, 3 and 7 only (same as the client's `isCountableSpend`). Rules 4, 5, 6, 8, 9
and 9b are not applied.

## Verification

- **New tests fail on `df2adda`:**
  - `budgetPendingOnce.integration.test.ts` **6 of 6** fail (the plan test's planned figures passed; its actuals read
    365.00);
  - `budgetPendingOnce.test.tsx` (web) **4 of 5** fail (the "nothing pending" case passes, as it should);
  - the flipped PR7b test **1 of 10** fails (`expected '134.40' to be '69.40'`).
- **After:** all pass.
- **Gates** (worktree root):
  - `pnpm run typecheck` green;
  - web `TZ=UTC` 136 files, 1117 passed / 3 skipped; `TZ=America/Chicago` 136 files, 1118 passed / 2 skipped;
  - full API suite (`caffeinate -i`, own test DB): 139 files, 1308 passed / 7 todo;
  - `pnpm run build` + `check-entry-graph`: 574.4 KB of 580 (unchanged; the Budget page is lazy);
  - codegen re-run clean.
- **Not done:** a visual check in a browser against real data (no production access in this PR).

## Residuals

1. **The Allowances page and the Banking strip still count both halves.** They sum raw `/transactions` rows in the
   browser (`bucketSpend.ts`). Where a replaced pair is filed in a bucket, they read higher than the Budget allowance
   card by the replaced pending amount. They need the same set: a server aggregate, or the ids on the rows.
2. **Reports → Budget still counts both halves.** `lib/budgetFacts.ts` (`GET /reports/budget-facts`) duplicates the
   Budget SQL without pairing, so it now disagrees with the Budget page wherever a pair exists.
3. **The "Delete this envelope?" prompt's count omits a replaced pending row.** Its count comes from the drill list;
   that row is also un-filed on delete, but it counts in no total.
4. **The actuals drill is still capped at 200 month rows** (pre-existing). A month over the cap lists fewer rows than
   the figure.
5. **The pairing query costs more on busy households.** It now runs on every month read that holds a pending row,
   adjacent-month prefetches included. PR7b's proposed index on (household_id, plaid_account_id, occurred_on) still
   needs Brad's go (DDL).

## Owner decisions needed

- **The six rule differences above:** should the Budget page adopt Spending's full rule? That would move debt, card
  payment, reimbursable and pattern-matched rows out of category actuals.
- **Allowances page, Banking strip and Reports → Budget:** adopt pairing next (residuals 1–2)?
