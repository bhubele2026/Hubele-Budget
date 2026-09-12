# PR-D — the Budget page counts a pending purchase once

- **Base:** `main` = `df2adda`.
- **Branch:** `fix/budget-pending-once`.
- **Round 1:** `c35b3701`.
- **Round 2:** answers the PR-D review (REQUEST CHANGES: H1, M2, M3, L4, L5, NIT6). See **Review round 2**.
- **Merge:** `origin/main` at `1a0c1f71` (PR-A, deploy-safe category passes) merged in with no rebase.
  - The conflicts were imports only in `routes/budget.ts`: main's `gte` and `logger` imports were kept beside PR-D's.
  - Every gate below ran on the merged tree.
- **Owner decision 6:** "Budget should count pending purchases consistently with Spending: once. Show posted spending,
  pending spending, combined spending so far. Pending purchases consume available budget. When they post, replace the
  pending version and adjust for the final amount. Example: a $40 pending restaurant charge posts at $48 → spending
  becomes $48, not $88. Budget and Spending must use the same inclusion rules."
- **Owner decision 14 (applied in round 2):** reviewed and filing metadata carries to the posted replacement.

## The problem

`GET /budget/months/:m` summed rows in SQL. A pending row and the separate posted row that replaced it both counted:
- in each category's `actualAmount` and its `sourceBreakdown`;
- in the allowance card's sums.

PR7b fixed Spending and pinned the Budget page's gap as a KNOWN RESIDUAL (review M2): June "Eating out" read 134.40 on
the Budget page and 69.40 on Spending.

## What changed

**Pairing — `lib/supersededPending.ts`.**
- **Pairs, not just ids.** Every loader returns `replacedIds` and `replacedBy`: posted row id → the pending row it
  replaced, with that row's filing.
- **`findSupersededPendingForRange(household, from, to, reader?)`.** For every row dated in the range, it gives exactly
  the whole-ledger answer, reading only a window before the range.
  - **Skip:** no pending row dated in [from − 7, to] means no query and no pairing.
  - **Otherwise, one candidate read** for posted rows dated [from − 32, to + 8].
  - **Per Plaid account, a cut:** the latest day ≤ from − 7 that no pair `canSupersede` accepts crosses (pending before
    the cut, posted on or after it). Candidates from that cut onward are paired.
  - **Fallback:** the lookback doubles while some account has no clean day (up to 1024 days), then it answers from the
    whole ledger.
  - **Why it is exact:** accepted pairs span 0–7 days within one account, so an uncrossed day splits that account's
    pairing into independent halves. Posted rows after to + 7 cannot take a pending row in the range, and they pick
    after every posted row in it.
- **`findSupersededPending` (whole ledger)** is unchanged in answer. Habits and the Amex payoff still use it.
- **Readers take an optional transaction.**

**Filing — `lib/pendingFiling.ts effectiveFiling` (new, pure).** A posted row that replaced a pending row counts with
the pending row's filing wherever it lacks its own, following dedupe's `mergeStatePatch` (fill blanks, never
overwrite):
- **`categoryId`:** only when the posted row has none or sits in the system Uncategorized, and the pending row's is a
  real category;
- **the three allowance flags plus `weeklyBucket`:** only when the posted row has none of the three flags (its own
  bucket kept if set);
- **`reimbursable`:** true when either is;
- **`debtId`:** filled when the posted row has none.

Read time only: nothing is written (PR-I writes it at sync).

**Budget month — `routes/budget.ts` + `lib/budgetActuals.ts` (new, pure).**
- **One snapshot.** The pending-in-reach check, the pairing and the month's rows are read in one REPEATABLE READ,
  read-only transaction.
- **One pass over the month's rows** builds both the category actuals and the allowance's aggregate rows:
  - replaced pending rows skipped;
  - `effectiveFiling` applied;
  - the same spend/inflow arithmetic as the two SQL SUMs it replaces, in whole cents;
  - category actuals skip transfers only; the allowance applies `isCountableSpend` and unplanned > monthly > weekly.
- **The SQL could not stay.** A posted row's category now depends on another row's filing.
- **Per line:** `actualAmount` = posted + pending, and `sourceBreakdown` merges both halves per source. The allowance
  split flows through `buildAllowanceRollup`.

**Spending — `lib/spendingFacts.ts`.**
- Reads `findSupersededPendingForRange` for its own range (the spine reads one range covering both windows).
- Every row is classified on its effective filing, from the same helper. Budget and Spending file a bare posted row
  alike.

**API (additive; spec + codegen, generated `src` and `dist` committed).**
- `BudgetLineWithActual`: `postedAmount`, `pendingAmount`, `combinedAmount` (= `actualAmount`).
- `BudgetAllowanceLine` and `BudgetAllowanceRollup`: `posted`, `pending`, `combined` (= `actual`).
- `BudgetMonthDetail.replacedPendingIds`: pending rows in the month a posted row replaced.
- `BudgetMonthDetail.inheritedCategories`: posted rows counted under a category they do not store.

**Web (Budget page, lazy route).**
- **Row:** "incl. $40.00 pending" in the strip below the figures, when pending > 0.
- **Popover:**
  - "Posted $X · Pending $Y" when pending > 0;
  - a pending row reads "· pending";
  - drops `replacedPendingIds`;
  - lists a bare posted row under its `inheritedCategories` category;
  - uses both only when the response's `monthStart` is the month on screen (L5).
- **Allowance card:** "incl. $X pending" in the head and under a bucket.
- **Foot copy:** a pending purchase counts once, at its final amount when it posts.

## Figures that move (before = `df2adda`)

Live, only where a pending row was replaced by a posted row (PR4c pairing: same account, posted within 7 days,
|pending| ≤ |posted| ≤ 1.30 × |pending| + $1, created later).

- **The replaced pending half leaves every total:**
  - category `actualAmount`;
  - `groups[].actualTotal`;
  - `summary.*.actual`;
  - `planBySource.*.actual` and `actualTotal` ("Spent so far", Income "in so far");
  - `sourceBreakdown`;
  - allowance per bucket, slices and total (the plan strip's allowance figure).
- **⚠️ A bare posted row now counts where its pending row was filed.**
  - On `df2adda` its amount counted in the posted row's own (empty) place, plus the pending half in the filed place.
  - Round 1 (`c35b3701`) dropped the charge from the filed envelope entirely (review H1).
  - Now: Eating out 48, weekly 48; on Spending, Eating out 48 and Uncategorized 0.
- **⚠️ When the two halves are filed differently, the posted row's own filing wins, and the WHOLE charge moves (review
  M2).** An envelope can lose a charge entirely while another gains it:
  - pending in Dining, posted in Groceries → Dining 40 → 0, Groceries +48;
  - pending unplanned, posted weekly → unplanned −40, weekly +48.
- **⚠️ Spending's totals move too** where the pending half was filed into something Spending excludes. Categories move
  from Uncategorized to the inherited one otherwise. The posted row inherits:
  - `reimbursable` (pinned: household spend 48 → 0, `excluded.reimbursable` +48);
  - a `debtId`;
  - an excluded, income or debt-linked category.
- **⚠️ A month's figure can fall after the month ends.** A pending charge on the 30th that posts on the 1st counts in the
  month it posted only. Spending already does this.
- **Income:** a replaced pending deposit no longer counts twice.

**Tests, measured (after = this head):**

| Case | `df2adda` | After |
|---|---|---|
| $40 pending then $48 posted, both filed (July) — category actual | 88.00 | **48.00** (posted 48 / pending 0) |
| The same, before it posts | 40.00 | **40.00** (posted 0 / pending 40) |
| Pending $20 + posted $40, too large to pair | 60.00 | **60.00** (posted 40 / pending 20) |
| Pair across 9/30 → 10/01, posted bare: September / October | 40.00 / 0.00 | **0.00 / 48.00** |
| Pending + posted $500 payroll deposit — income line | 1000.00 | **500.00** |
| Allowance, both halves filed weekly, plus $15 monthly pending — weekly / total | 88.00 / 103.00 | **48.00 / 63.00** |
| **H1:** $40 pending Eating out + weekly/dining, $48 posted bare — Eating out / weekly / Spending cat / Uncategorized | 40 / 40 / 0 / 48 | **48 / 48 / 48 / 0** |
| **M2:** pending Dining, posted Groceries — Dining / Groceries | 40 / 48 | **0 / 48** |
| **M2:** pending unplanned, posted weekly — unplanned / weekly | 40 / 48 | **0 / 48** |
| Pending monthly, posted bare — monthly | 20 | **22** |
| Pending reimbursable + weekly, posted bare — weekly / Spending household spend | 0 / 48 | **0 / 0** |
| Plan-pin month: $160 pending replaced by $175, plus $30 pending — Utilities | 365.00 | **205.00** |
| June "Eating out" (PR7b residual test): Budget / Spending | 134.40 / 69.40 | **69.40 / 69.40** |

The `df2adda` column is main's rule applied to each fixture. It was measured only where a base run reached the figure
(365.00, 134.40).

**Not measured:** production. It needs a read-only production query Brad approves.

## Must not change

- **The plan.**
  - `plannedAmount` and `planSource` on every line.
  - `planBySource.{income,bills,debts,unbacked}.planned` and `lineCount`.
  - `plannedTotal` and `net`.
  - The allowance caps.
  - Pinned before and after rows land ("MUST NOT CHANGE — the plan"). `budgetPlanBySource.integration.test.ts` passes
    unchanged.
- **Rows with no pair.** Same figures: the spend/inflow arithmetic, filters and bucket precedence are the SQL's, summed
  in whole cents.
- **Untouched:** cash, the forecast, `pairPendingWithPosted`, and the whole-ledger answer of `findSupersededPending`
  (its tests pass unchanged). Nothing is written; both rows stay in the ledger (asserted).

## Budget's category actuals vs Spending's rule (`classifyOutflow`) — NOT changed here

Only the pending pair and its filing were decided. Everything below differs and is a question for the owner.

**Category actuals:**
1. **Tagged rows count.** Budget counts a `debtId`-tagged row (rule 2) and an `isExternalCardPayment` row (rule 3) in
   its category.
2. **Debt categories count.** Budget counts rows in a debt-linked category (rule 4); auto_debts lines show payments as
   their actual.
3. **Excluded category names differ.** Budget hides only `exclude_from_budget` categories (Uncategorized, Transfer,
   Ignore). "Reimbursement", "Transfers in", "Transfers out" and "Uncategorized — transfer" show an actual (rule 5).
4. **Reimbursable rows count** in their category (rule 7).
5. **No pattern rules.** PFC card payments (rule 8), card-payment patterns (rule 9) and bank-noise patterns (9b) count.
6. **Income differs.** Budget income lines include manual-Amex credits; Spending's `realIncome` counts no Amex row.

**Allowance card:** excludes rules 1, 2, 3 and 7 only.

## Verification

**Fails-before, round 1** (new tests on `df2adda`):
- **`budgetPendingOnce.integration.test.ts` (round-1 version):** 6 of 6 failed, but only 5 on a figure. ⚠️ (review L4)
  The "too large to pair" case reads 60.00 on `df2adda` too; it failed only on the missing `postedAmount` /
  `pendingAmount` fields.
- **`budgetPendingOnce.test.tsx` (web):** 4 of 5 failed.
- **The flipped PR7b test:** failed (`expected '134.40' to be '69.40'`).

**Fails-before, round 2** (on `c35b3701`):
- **`budgetPendingOnce.integration.test.ts`:** 5 of 13 fail.
  - **On a figure:** month boundary with a bare posted row (October 0.00); H1 (Eating out 0.00); flags inherited only
    when the posted row has none (monthly 0.00); reimbursable pending (household spend 48, not 0).
  - **Only on the missing `inheritedCategories` field:** the M2 category case. Its figures (0 / 48) are the same on
    `c35b3701`.
  - **Pass on `c35b3701` by design (pins, not fixes):**
    - M2 flags (unplanned 0 / weekly 48);
    - "no pairing for a month with no pending row in reach";
    - "one pairing run for a month read";
    - the five round-1 cases.
- **`supersededPendingWindow.integration.test.ts`:** 4 of 4 fail (`findSupersededPendingForRange` did not exist).
- **`pendingFiling.test.ts`:** fails to load (module did not exist).
- **`budgetPendingOnce.test.tsx` (web):** the new H1 drill case fails; 5 pass.

**After:** all pass.

**Gates (worktree root, merged tree `a9b89a1e` = round 2 + `origin/main` 1a0c1f71):**
- `pnpm run typecheck` green.
- Budget-related API files (15, including PR-A's deploy-safe and May 2026 tests): 105 passed.
- Web: `TZ=UTC` 136 files, 1118 passed / 3 skipped; `TZ=America/Chicago` 136 files, 1119 passed / 2 skipped.
- Full API suite (`caffeinate -i`, own test DB): 142 files, 1338 passed / 7 todo.
- `pnpm run build` + `check-entry-graph`: 574.4 KB of 580 (unchanged; the Budget page is lazy).
- Codegen re-run: byte-identical.

**Not done:** a browser check against real data (no production access).

## Performance (review M3)

**Fixture:** one household on the test Postgres; 20,000 rows over 24 months, 4 cards, 60 merchants. It holds 400
pending→posted pairs and 100 lone pending rows. The whole ledger holds 3,773 loose candidate pairs over 3,894 rows.
June is measured with a median of 7 or 9 runs. "Stale" means straight after the bulk insert; "analyzed" means after
`ANALYZE transactions`.

| Read | Stale stats | Analyzed |
|---|---|---|
| `c35b3701` month read: whole-ledger pairing | 1,072.8 ms | 214.1 ms |
| First windowed attempt (start moved back whenever a LOOSE candidate crossed it): 23 reads for June | 3,966.0 ms | 250.4 ms |
| **This head:** windowed, per-account cut on ACCEPTED pairs, 1 read, 285 candidates / 287 rows | **122.8 ms** | **7.2 ms** |
| **This head:** month with no pending row in reach (skip) | — | **0.2 ms** |
| **This head:** whole `GET /budget/months/2026-06-01` | — | **14.5 ms** |

- **The first attempt was rejected.** Loose candidates (no description test) cross almost every day, so its start
  walked back 8 days at a time. Judging crossings on pairs `canSupersede` accepts, per account, found a clean cut in the
  first read.
- **The whole route on `c35b3701` was not timed directly.** Its pairing step alone was 214 ms analyzed.
- **Where pairing now runs.** Landing → Budget reads pairing in the Budget month (current month and prefetched
  neighbours), the spine (one read for both windows) and `/reports/spending-facts`. Each is now one windowed read, or
  none.
- **Chose windowing over a per-household cache.** The windowed read is exact, so no cache and no invalidation.

## Review round 2 — one line per finding

- **H1 (bare posted row lost the charge):** fixed at read time — `effectiveFiling` in Budget category actuals, the
  allowance and `buildSpendingFacts`; H1, own-category, flags-only-when-none and reimbursable tests.
- **M2 (halves filed differently):** the posted row's own filing wins; both cases tested; stated under "Figures that
  move".
- **M3 (perf):** exact windowed pairing (per-account clean cut) + skip when no pending row is in reach; randomized
  equivalence over 44 ranges; 214 → 7.2 ms analyzed, 1,073 → 123 ms stale.
- **L4 (overstated fails-before):** corrected above.
- **L5 (drill from two caches):** the drill uses `replacedPendingIds` / `inheritedCategories` only from the response for
  the month on screen. A sync landing between the month read and the transactions read can still show a stale list;
  disclosed below.
- **NIT6 (not one snapshot):** pending check, pairing and month rows run in one REPEATABLE READ read-only transaction.
  The plan side (categories, lines, bills) is read outside it, as before.

## Residuals

1. **The Allowances page and the Banking strip still sum raw rows** in the browser (`bucketSpend.ts`): no pairing and no
   inheritance. Where a pair is in a bucket they can differ from the Budget card.
2. **Reports → Budget does neither.** `lib/budgetFacts.ts` (`GET /reports/budget-facts`) duplicates the old Budget SQL,
   with no pairing and no inheritance.
3. **Habits (`buildBehaviorFacts`) and the Amex weekly payoff pair but do not inherit filing.** They use
   `loadSupersededPendingIds`, so a bare posted row keeps its stored category there.
4. **⚠️ Spending's Uncategorized popover list vs its banner.** The popover lists stored-null rows
   (`/transactions?uncategorized=true`). The banner (`uncategorized.total`) no longer counts a bare posted row that
   inherited a category, so the list can show a row the banner does not count. PR-I (writing the filing at sync) closes
   it. The Budget page's inline "N matches" suggestions still offer such a row too.
5. **Drill vs a sync between reads (L5).** The month response and the transaction list are separate cached queries.
6. **The "Delete this envelope?" prompt's count omits a replaced pending row.**
7. **The actuals drill is capped at 200 month rows** (pre-existing).
8. **Proposed DDL still waits.** The (household_id, plaid_account_id, occurred_on) index would speed the candidate
   join; it needs Brad's go.

## Owner decisions needed

- **The six rule differences above:** adopt Spending's full rule on Budget category actuals?
- **Residuals 1–3:** should the Allowances page, the Banking strip, Reports → Budget, Habits and the Amex payoff adopt
  pairing and inheritance next?
