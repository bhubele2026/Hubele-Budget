# PR-I: bank truth for rows someone worked on (owner decisions 14 and 5)

Branch `feat/bank-removed-review-carry`, from `main` `9aad763`. Plan section D, PR-I.
No schema change. All figures below come from synthetic test fixtures.

## Owner decisions implemented

- **Decision 14: reviewed does not freeze bank status.**
  - When the bank replaces a row, the review work on it (reviewed, category, flags) carries to the replacement.
  - The bank still decides whether money moved. A removed row someone worked on stays visible and counts nowhere.
- **Decision 5: no automatic $0 for stale pending.**
  - A pending row more than 14 days old is labelled "Pending unusually long".
  - It is never counted as $0 and never subtracted twice.
- **No DDL.** The marker is a `forecast_resolutions` row:
  - `status 'bank_removed'`;
  - `recurring_item_id` and `occurrence_date` NULL;
  - `matched_txn_id` = the removed row.

## Model rule (section D) as built

**1. Review work carries** (`lib/reviewCarry.ts`, `carryReviewToReplacements`).
- A pending→posted re-key already keeps the work on the same row; nothing changed there.
- A posted row that a sync **inserts**, and that replaced a pending row, takes that pending row's work:
  - the pairing is `findSupersededPendingForRange`, the same one cash, Spending and Budget read;
  - it takes `reviewed`, plus the filing `effectiveFiling` already gave it at read time (PR-D): category (a hand filing beats the rules' category), allowance flags and slice, reimbursable, debt tag, a person-set transfer flag;
  - `isTransferUserOverridden` is carried only alongside a carried category or transfer flag whose pending-side flag a person set. This is dedupe's rule.
- Runs on both sync paths:
  - the cursor sync, over rows whose upsert inserted them (`xmax = 0`);
  - the gap backfill, over rows it inserted.
- **"Only while the posted row still has default values"** is enforced as "only onto a row the same sync inserted":
  - such a row has had no human choice on it;
  - a later sync never carries again. The test un-reviews and re-files the posted row, and a re-sync keeps that.

**2. Bank removal of a worked-on row** (`lib/bankRemoved.ts`).
- The cursor sync still deletes a removed row no one touched.
- A kept row (category, allowance flag, reviewed, transfer or date override) gets exactly one marker.
- `classifyCashRows` (core) gives a marked row reason `removed_by_bank` and adds 0, checked first. Pairing:
  - a removed **pending** row still pairs, so the posted row that replaced it counts only what the snapshot did not hold;
  - a removed **posted** row replaces nothing, so the pending row the bank still reports keeps counting;
  - `supersedeCandidatesQuery` (Spending, Budget, Amex payoff) pairs the same way.
- Spending, Amex owed and Budget skip the row through one SQL predicate, `notBankRemovedSql()`.
- Plaid listing the id again deletes the marker. That covers cursor `added`/`modified`, rows re-keyed or re-minted onto a listed id, and the gap backfill's `/transactions/get`.
- A request can neither write a marker (POST refuses `bank_removed`: 400) nor delete one (DELETE by id and every delete by `matched_txn_id` skip it).

**3. Pending more than 14 days.** The label already existed (`isStalePending`, `STALE_PENDING_DAYS`). This PR:
- verifies it is never $0 and counted once, within the pairing window, across cash, register, Spending and Budget;
- renames the label to "Pending unusually long".

## What "Removed by bank" does

| Figure | Reader | Removed row |
|---|---|---|
| Cash today and the curve | `buildForecastLedger` → `classifyCashRows` | adds 0 (`removed_by_bank`) |
| Chase register and totals | `loadRegister`, `readLedgerPage` | `countsInBalance: false`, `balanceAmount 0.00`, row listed |
| "Why this number?", Sync reconciliation | `classifyLedgerRowsThroughToday` | adds 0 |
| Spending | `buildSpendingFacts` | counts nowhere, including the excluded buckets |
| Habits | `buildBehaviorFacts` | no visit, splurge or streak day |
| Budget page | `GET /budget/months/:monthStart` rows | no actual; its replaced posted row keeps the inherited filing |
| Reports → Budget | `buildBudgetFacts` (actuals, burndown) | no actual |
| Amex owed (1) | `computeWeeklyPayoff` | not owed |
| Amex owed (2) | `refreshAmexAnchor` | not in the sum |
| Amex owed (3) | `GET /amex/anchor`, computed | not in the sum |
| Amex owed (4) | web `makeAmexBalanceAtEndOf` | moves no month |
| Amex owed (5) | web `pages/amex.tsx` | no running "bal $X", out of `monthTotals`; chip "Removed by bank" |
| Row lists that pages total in the browser | `GET /transactions` | left out; `includeBankRemoved=true` lists it with `bankRemoved: true` |
| Forecast Review queue and badge | `GET /forecast` bundle, `computeReviewCount` | left out of both, so they still agree |
| Review labels | Chase ledger rows and Review inbox (`ledgerRowLabels`), Amex page rows | "Removed by bank" |

**Default exclusion on GET /transactions.**
- Budget and Spending drills, Allowances, Bills, Command Center and Cash flow total raw rows in the browser. Leaving the row out server-side keeps each of them tied to its server figure with no page change.
- The Amex page's month list asks for removed rows and shows them. Its 12-month trend query does not.

**Forecast Review (`/review`) leaves the row out.** This is a call for the reviewer.
- The row is not cash and pays no bill, so there is no answer to give.
- It shows, labelled, on the Chase and Amex tabs of the Review destination.
- Showing it in the forecast queue would mean a new bank-line state in `forecastMatch.ts`. R1 rebuilds that page.

## Acceptance tests: fails before, passes after

Fails-before ran the final tests against the original sources of `9aad763`, with the new files present but unused.

| Test | Before (`9aad763`) | After |
|---|---|---|
| ⭐ A reviewed pending row re-posted under a new id comes back reviewed, with its category and flags (cursor sync) | Posted row `reviewed:false`, the rule's category, weekly flag false, bucket null, reimbursable false, override false | `reviewed:true`, the hand category, weekly + "dining", reimbursable, override true; the pending row stays with 1 marker |
| Same, through the gap backfill | `reviewed:false`, category null, monthly flag false | `reviewed:true`, category, monthly flag |
| ⭐ Removed −$40 worked-on row | Cash moved 0 (expected +4000 cents) | Cash +40.00, Spending −40.00, Budget line −40.00; the row stays with 1 marker; ledger `removed_by_bank`, `0.00`; `GET /transactions?includeBankRemoved=true` flags it |
| ⭐ Plaid re-adds the id | No marker written on removal (0, expected 1) | Marker 1 after removal (cash +40, Spending −40); after the `modified` re-listing the marker is 0, all three figures equal the pre-removal ones, and the ledger says `counted` |
| Gap backfill lists the id again | Marker stays (1) | Marker gone (0) |
| ⭐ 20-day pending row labelled, not $0 | **Passes before (already on main).** Web label read "Pending 14+ days" | API: `stalePending`, `counted`, `-25.00`; cash 975.00; Spending 25; Budget 25. Its posting 3 days later: cash 975.00 (not 950.00), Spending 25, pending `superseded 0.00`. Web: "Pending unusually long" |

**Guards that pass before and after:**
- A posted-row choice survives a later sync.
- The vanished-pending sweep keeps a marked worked-on pending row and its marker.

## Every reader of `forecast_resolutions`

| Reader | How it treats the marker | Test (fails before?) |
|---|---|---|
| `lib/forecastLedger.ts` (CLOSING_STATUSES, matched/partial keys, confirmed rows, `claimedTxnIds`, remap) | Filtered at the read (`isResolutionRow()`). Before, the marker "claimed" its pending row, so the posted row that replaced it could not pay its bill. | Removed row is no cash and no match: before `850.00`, after `1000.00`. Posted replacement pays its bill tier 2 off-curve: before `undefined` |
| `routes/forecast.ts` GET /forecast | Resolutions filtered; the removed row is left out of `transactions` | Before, the marker was in the bundle |
| `routes/forecast.ts` POST /forecast/resolutions | `bank_removed` refused; the neighbour delete by `matchedTxnId` skips markers | Before: `200` to a forged marker, and the marker was deleted by a match on its row |
| `routes/forecast.ts` DELETE /forecast/resolutions/:id | Skips markers | Before: deleted |
| `lib/reviewCount.ts` | Resolutions filtered; the removed row is left out of the count, as in the bundle | Count 1 (live row only). Guard: the marker already hid the row before, for the wrong reason |
| `lib/billsSummary.ts` (`archiveExpiredOneTime`, actuals) | Unreachable: status filter plus `recurring_item_id IN (...)` | Guard: no actual, nothing archived |
| `lib/oneTimeBillMove.ts` (`clearPendingReviews`, `moveOneTimeResolutions`) | Unreachable: scoped by `recurring_item_id` | Guard: marker survives PATCH /recurring-items |
| `lib/dedupeTransactions.ts`, per account and cross account | A marker earns no survivor points and never repoints. A removed row never survives a live twin. A removed loser's marker is deleted with it. `mergeStatePatch` now carries `reviewed`. | Before: the removed row survived and the live twin was deleted. Before: `reviewed:false` on the survivor |
| `lib/dedupePlaidAccounts.ts` | Calls `dedupeTransactionsForAccount` (above) | Same tests |
| `lib/plaidSync.ts` vanished-pending sweep | Unchanged. It deletes resolutions only for rows nobody worked on, so a marked worked-on row and its marker stay. | Guard |
| `lib/plaidSync.ts` auto-match | Filtered at the read. Unreachable today (`AUTO_MATCH_ENABLED = false`, pinned by `plaidSyncAutoMatchDisabled`). | None possible while the switch is off |
| web `lib/forecastMatch.ts` `buildLineRegister` / `buildBucket` | Skips the marker (defence in depth; the bundle has none) | Before: the row carried `resolutionId` and a marker after a match hid the match. `buildBucket`: guard |
| web `lib/forecastRowState.ts` | Skips the marker | Before: the marker was taken as the row's decision |
| `routes/transactions.ts` PATCH, bulk-update, bulk-set-forecast-flag | Deletes by `matched_txn_id` skip markers; a real match on the same row is still deleted | Before: marker deleted (all three) |

## Spending and Amex owed, before → after (spend/owed test)

| Figure | Before | After |
|---|---|---|
| Amex weekly payoff for the card | 90.00, 2 charges | 50.00, 1 |
| `GET /amex/anchor` computed | −150.00 | −80.00 |
| `refreshAmexAnchor` (imported-rows household) | 90.00, 2 rows | 50.00, 1 |
| Spending facts | 90, 2 | 50, 1 |
| Budget month line | 90.00 | 50.00 |
| Reports → Budget flex line | 90 | 50 |
| `GET /transactions` plain list | 2 rows | 1 row; asked, 2 rows, one flagged |
| A live pending row beside its removed posted look-alike | Posted row counted, pending `replacedPending 30` | Pending row counts 30 once, `replacedPending 0`; payoff 30.00, 1 |
| Web `makeAmexBalanceAtEndOf` | October 172 | 125, equal to the same rows without the removed ones |
| Web Amex page | No chip; live row's "bal" shifted by the removed charge | Chip in both layouts; live row "bal $100.00"; removed row has no "bal" |
| Core `classifyCashRows` (3 unit tests) | Removed rows `counted` | `removed_by_bank`; pairing as above |

## Gates

**Typecheck:** passes.

**Web** (`vitest run`, 144 files, both time zones):

| Time zone | Passed | Skipped |
|---|---|---|
| UTC | 1,242 | 3 |
| America/Chicago | 1,243 | 2 |

None of the skipped tests is in PR-I's files.

**API** (full suite, `caffeinate -i`, own DB): 148 files, 1,509 passed, 7 todo.

**Build:** passes. `check-entry-graph` reports 575.7 KB of 580 KB, unchanged from main.

**Codegen:** the spec changed three things:
- the `includeBankRemoved` query parameter;
- `Transaction.bankRemoved`;
- the `balanceReason` description.

Generated output is committed, and a second codegen run is byte-identical.

**Golden and household-scenario files:** unchanged, nothing re-recorded.

**Changed assertions** (none weaker):
- `chaseLedger.test.ts` and `chaseReviewInbox.test.tsx`: "Pending 14+ days" becomes "Pending unusually long". Same row, same single label, owner's wording.
- `transactionsLedger.integration.test.ts`: two `toCashRow(row)` calls become `toCashRow(row, new Set())`. `toCashRow` now requires the removed ids so no caller can forget them. No assertion changed.

## Notes for the reviewer

- **Cost.** `notBankRemovedSql()` is a `NOT EXISTS` on `forecast_resolutions`, a small table with no index on `matched_txn_id`. No DDL was approved.
- **Failure handling.**
  - Marking and un-marking are not wrapped: if either throws, the sync fails before it saves its cursor and Plaid resends the delta.
  - The carry is non-fatal, because the rows are already stored and PR-D's read-time filing still applies.
- **Inserted rows.** `xmax = 0` detects them on the cursor path. The backfill uses its existing "not on file before" check.

## Deferred and open (as of round 2)

Round 1's items 3 (a match on a removed row), 4 (debt readers) and 5 (re-mint split across two syncs) are fixed in round 2, below.

1. **Look-alike suggestion → R1.** "A posted look-alike 8–30 days later becomes a Review suggestion" does not exist on main.
   - It needs a read-time pairing beyond `SUPERSEDE_MAX_DAYS`, a ledger field, spec, codegen and a Review surface. R1 rebuilds that surface, so it is pinned there.
   - **Until then**, a stale pending row whose posting lands 8–30 days later counts beside it. Decision 5 forbids zeroing it automatically; the label is the only signal. Within 7 days pairing already counts the charge once (tested).
2. **Vanished-pending sweep does not mark.** A worked-on pending row that `/transactions/get` stops listing is kept, unmarked, and still counts (labelled after 14 days). Marking it would be a new rule, so it is left open.
3. **Pre-existing fault found, not changed.** `refreshAmexAnchor`'s debt lookup (`plaid_account_id::text = ANY(($2))`) fails with Postgres 22P02 whenever an Amex row carries a `plaid_account_id`. The sync calls it inside a catch, so the auto-anchor never refreshes for Plaid Amex rows.
   - Fixing it would start writing debt balances, so it needs its own change.
   - The test here uses workbook-style rows.
4. **Transparency panel.** Spending's `excluded` panel has no "removed by bank" bucket; the row is simply absent.
5. **Pending deposits: pre-existing, owned by PR-J** (both already on main, both read high).
   - **C:** a worked-on pending deposit that vanishes stays +$100.
   - **E:** a stale pending deposit whose posting lands 10 days later counts twice.
6. **Review work split across two syncs (review R6).** If the posted row arrives in one sync while Plaid still lists the pending row, and the pending id is removed only in the next, nothing carries. The posted row was not inserted by the sync that marked the pending row, and after HIGH-1 the carry needs both.
   - Budget and Spending still read the pending row's filing onto it (PR-D `effectiveFiling`); only `reviewed` and the stored filing are missed.
   - Carrying at removal time would write onto a row the household may already have touched, which this PR never does.
7. **Carry failures are not retried.** The carry is non-fatal and runs once, for rows the same sync inserted. A later sync never retries, because those rows are then updates, not inserts. PR-D's read-time filing still covers Budget and Spending.
8. **`includeBankRemoved=false` reads as true.** Like the route's other boolean filters (`uncategorized`, `excludeTransfers`, `reimbursable`), the generated schema is `zod.coerce.boolean()`, so any non-empty value is true. The web only ever sends `true` (`pages/amex.tsx`). Left as is.
9. **Merge hazard with PR-E.** The held PR-E (`b00748d`) rewrites `refreshAmexAnchor`. Its merge must re-apply PR-I's `notBankRemovedSql()` in that sum. `bankRemovedSpendOwed` ("refreshAmexAnchor") fails if it is lost.

## Round 2: review of `0e23d1f` (2 HIGH, 2 MEDIUM, 3 LOW, 3 NIT)

Base: main `59cbbda`. Round 2 merged main three times:
- **PR-H `f96afb1`:** clean; both removed-charge skips in `amexAnchor.ts` intact.
- **PR-B2 `bce4bf7`:** `forecastLedger.ts` keeps its hold-back and PR-I's filters side by side.
- **Follow-ups batch 2 `59cbbda`:** `forecast.tsx` keeps both sides.

Fails-before: the round-2 tests were run with every non-test source file round 2 changed put back to `f3e59bf0^` (round 1 on the same main). Kept as they were: the new `bankRemovedPayments.ts`, main's `forecast.tsx`, spec and generated code.

- **API:** 8 of 23 tests in the two touched files fail.
- **Web:** 4 of 30 tests fail.
- **After:** every test passes.

### HIGH-1: the carry gave a different charge another charge's review, permanently

**Change.** `carryReviewToReplacements` now needs the bank's word that the replaced pending row is gone. `lib/reviewCarry.ts` takes a `pendingGone` test:
- **Cursor sync:** the pending row carries a `bank_removed` marker (marking runs just before the carry).
- **Gap backfill:** it is marked, or it is absent from a complete (`fetchedComplete`) `/transactions/get` listing of its window.

| Test | Before | After |
|---|---|---|
| ⭐ R1: a second purchase at the same shop ($5.75), posted while the first ($5.00) is still pending, then the first posts through `pending_transaction_id` | Second charge `reviewed:true`, Dining, weekly + "dining", override true | Unreviewed, no category, no flags; the first charge keeps its work |
| Gap backfill with the pending row still listed | Posted row reviewed, filed, monthly | Nothing carried |
| M4b: a later backfill leaves a choice on an existing posted row alone | Passes (guard) | Passes; kills mutation M4b, which survived round 1 |

Round 1's carry acceptance tests still pass: the cursor case marks the pending row; the backfill case lists only the posting.

### HIGH-2: a match on a removed row kept the bill closed while cash added the payment back

This read high. **Owner rule:** the forecast reads low, never high.

**Change.** `lib/bankRemovedPayments.ts`:
- `loadRemovedPaymentIds` returns the bank-removed rows, except a pending row a live posted row replaced (whole-ledger `findSupersededPending`).
- `answersRemovedPayment(r)` is true for a `matched`, `partial`, `needs_review` or `needs_review_partial` answer on one of those rows.

The same filter runs in three readers:
- **The ledger:** the bill returns to the curve, and the answer claims no row.
- **The GET /forecast bundle:** the answer is left out, and the bill's key is listed in the new optional `paymentRemovedByBank` field (spec and codegen).
- **`computeReviewCount`:** keeps the three readers one rule. The removed row is already out of the count, so it cannot move.

On the web, `buildLineRegister` flags the open plan and `PlanDropRow` shows "Its payment was removed by the bank".

| Test (clock 5/14, $1,000 snapshot, City Water $150 due the 12th) | Before | After |
|---|---|---|
| ⭐ R2: a matched, filed payment row the bank removed | Bill off the curve (0 occurrences). The review measured cash 1,000 and ending **550** | Cash 1,000.00; bill on the curve (1); ending **400**, equal to the truth, lowest point equal too. Control: the same match on a live row reads 850.00, bill paid, 400 |
| GET /forecast bundle | The removed row's match is in `resolutions` | Left out; `paymentRemovedByBank: ["<water>|2026-05-12"]`; review count 0 |
| Exception: a removed PENDING row a live posted row replaced | Money already right (850.00, bill paid). Failed only on the new field (`paymentRemovedByBank` undefined) | 850.00, bill paid, no key: the posted row carries the payment |
| Web register (open plan flagged, a matched plan never) and plan row label | Flag and label absent | Present |

### MEDIUM-1: a re-mint split across two syncs read high

**Change.** Per-account dedupe keeps the Plaid id issued last when copies carry different ids.
- The newest `created_at` among the rows the bank still has wins; never a bank-removed row's id.
- The survivor keeps its own `created_at`, which the snapshot and pairing rules read.
- The pending→posted re-key runs before dedupe and is unaffected. A re-listed id still clears its marker: the acceptance re-add tests pass.
- The cross-account dedupe is unchanged.

| Test | Before | After |
|---|---|---|
| ⭐ R3: worked −$25 row on id OLD; sync N adds NEW; sync N+1 removes OLD | Survivor kept `OLD-RM`, so removing OLD would mark the worked row and add its $25 back (round 1's open item 5) | One row on `NEW-RM`, `created_at` unchanged, work kept; after the removal no marker, cash unchanged |
| A live survivor beside a newer, bank-removed twin | Passes (guard) | Keeps its own id, takes the twin's review |

### MEDIUM-2: removed payments still counted toward "% paid"

**Change.** `notBankRemovedSql()` is added to four readers:
- `loadPendingPayments`, the debt netting behind "% paid" (`/debts`, and `/spine` and `/dashboard` through `withPendingPayments`);
- the three `/dashboard` aggregates (debt paid, month income and spend, top categories);
- both avalanche actual queries.

| Test | Before | After |
|---|---|---|
| ⭐ R4: a $200 tagged payment, then marked removed | Nets `{ total: 200, count: 1 }` | Nets nothing |
| GET /dashboard: live −$20 plus removed −$30 this month | Monthly spend 50 | 20; the top category line is 20 |

The avalanche predicates have no test (see mutation R2-15).

### LOW

- **Amex totals.** The day-group header total and `buildBalanceWindow` (weekly and today points) skip removed charges.

  | Test | Before | After |
  |---|---|---|
  | Removed charge's day total | $40.00 | $0.00 |
  | Balance window points | 1,060 | 1,020 |

- **M19.** Round 1's `monthTotals` skip is reverted rather than tested: nothing reads `monthTotals` (grep), so no test can observe it.
- **M21.** The Chase "Removed by bank" label now has a direct test (key, words, title).
- **Carry failures** are not retried: open item 7.

### NIT

- **`markBankRemoved`** is one `INSERT … SELECT … WHERE NOT EXISTS` per chunk. Test: repeated ids and calls leave one marker, on the household owner (guard; kills R2-16).
- **`includeBankRemoved=false`:** open item 8.
- **PR-E merge hazard:** open item 9.

### Mutations (`mutate-pri.zsh`, from the review's script; restores from backups)

**The review's 21 (plus variants M4b, M5b, M5c, M7b):**
- M1–M18, M20 and M21 are killed, variants included. M4b and M21 were survivors in round 1.
- M19 no longer applies (the edit is reverted).

**Round 2's 18:** 16 are killed and 2 survive:
- **R2-14** removes the review-count answer filter. It is equivalent: the removed row is already out of the count.
- **R2-15** removes the avalanche actuals skip. No API test calls the avalanche routes.

### Gates (merged tree, main `59cbbda`)

| Gate | Result |
|---|---|
| `pnpm run typecheck` | passes |
| Web, UTC | 146 files, 1,261 passed, 3 skipped |
| Web, America/Chicago | 146 files, 1,262 passed, 2 skipped |
| Full API suite (`h2budget_test_pri`, `caffeinate -i`) | 155 files, 1,648 passed, 7 todo |
| `pnpm run build` + `check-entry-graph` (final tree) | passes; 575.7 KB of 580 (173.4 KB gzipped), no recharts on open |
| Codegen | regenerated for `paymentRemovedByBank`; a second run is identical |
| Golden and household-scenario files | unchanged |
