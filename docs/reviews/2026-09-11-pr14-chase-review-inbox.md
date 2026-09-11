# PR14 — Chase review inbox

Plan PR14 [Codex points 10, 11]: the web half of the Chase ledger. It moves the Chase page onto PR13's server ledger
(`d306e7c`) and gives it a review inbox. Branch `feat/chase-review-inbox`, cut from `main` at `d306e7c`.

The independent review of `6b4fac0` came back **REQUEST CHANGES**. `origin/main` (`d73f3bf`) is merged and every
finding is fixed on top; see **Review fixes**. Where an earlier section below no longer holds, it is corrected in
place and marked *(review)*.

## The problem

- **The Chase page still pulled 1,000 rows and did the money in the browser.**
  - `pages/transactions.tsx` asked `GET /transactions` for two years back to a year ahead, `limit: 1000`.
  - It then scoped, deduplicated, totalled and running-balanced whatever arrived (`scopeChaseTransactions`,
    `makeChaseBalanceAtEndOf*`, `computeRunningBalances`).
  - Past 1,000 rows the oldest dropped off silently. A note at `transactions.tsx:2544` (plan: `:2370`) said so, but
    every total and balance on the page was still drawn from the partial set.
- **Its figures used a day rule the bank balance no longer uses** (PR13 note, "The problem").
- **"Chase has no way to clear"** (Brad, 2026-09-10). The page had a per-row "Mark reviewed" and a client-side hide,
  but no count of what is left, no way to review a whole range, and the hide setting lived in one browser.

## What changed

### Data: the server's ledger, through generated hooks

- **Orval.** `lib/api-spec/orval.config.ts` gives `getTransactionsLedger` an infinite-query hook
  (`useGetTransactionsLedgerInfinite`, `useInfiniteQueryParam: "cursor"`). `version: 5` is set on that operation only:
  the client package names react-query as `catalog:`, which orval cannot read a version from, so it emitted v4 infinite
  types with an untyped `pageParam` that failed typecheck. *(review M4)* The Chase-only operations (ledger, balances,
  review by filter, UI preferences) are now tagged `chase-ledger` and generated into their own module,
  `@workspace/api-client-react/ledger`; the main module excludes them. No other operation's output changed.
- **Three ledger lists** (`pages/transactions/useChaseLedger.ts`, 50 rows a page, `staleTime` 2 min, `gcTime` 30 min):

  | List | Filter | Used for |
  |---|---|---|
  | Register | the range, `to` = min(range end, household today) | rows, "Showing X of Y", "To review", money in/out, start and end balance, select all matching |
  | Pending | `pending=true`, no `from`, no `to` *(review LOW-1)* | the pinned Pending group (#728: every pending row whatever the range; one dated after today is labelled and left out of the group's total) |
  | After today | tomorrow .. range end, only when the range reaches past today | rows labelled "After today"; never totalled, no balance |

  All three share the account, category and hide-reviewed filters. The overlap (a pending row inside the range) is
  merged by id. They are three different questions, not one question asked twice.
- **Why the register stops at today.** PR13's residual: a `totals` range that reaches past today can count a charge
  twice among rows dated after today, and no balance exists after today. So totals and balances cover the range
  through today, and after-today rows are listed apart (`splitAtToday` in `pages/transactions/chaseLedger.ts`).
- **Balances.** One `GET /transactions/balances` per range carries both the sparkline's days (≤ 40, through today) and
  the trend chart's week-ending Saturdays before today (≤ 27); ≤ 120 by construction and capped in code. Today's point
  on the chart is `balanceToday` (the spine's `bank.balance`), then the balances response's anchor. With neither there
  is no seed at all; the old `: 0` fallback is gone, and *(review LOW-5)* so is the cash signal's `bankToday` fallback,
  which without a snapshot belongs to no day.
- **Running balances** are each row's `runningBalance`. A row the server gives none (after today, no snapshot time)
  shows none.
- **Invalidation.** `lib/mutationInvalidation.ts` (`invalidateAfterWrite`, run by `App.tsx`'s `mutationCache` after
  every write) now also marks every ledger and ledger-balance query stale. The infinite key starts `"infinite"`, so
  the page's existing `getListTransactionsQueryKey()` invalidations never reached it. *(review M3)* The review writes
  and the UI-preference save opt out of that rule and invalidate exactly what they move, once (Review fixes).
- **Removed from the page:** the 1,000-row pull, client scoping and dedupe, local totals, local running balances, the
  cap note, the two month-jump effects (they searched the full client list for the newest month with rows), and the
  search/date/source/member filter state, which nothing rendered.

### The inbox

- **Controls** (`pages/transactions/ChaseReviewInbox.tsx`): "To review: 37" with a `Help` chip that says it is not the
  forecast Review count; "Select this page"; "Clear reviewed from list" / "Show reviewed"; the bank freshness line
  (`FreshnessLine`, from the spine).
- **Pager** under the list: "Showing 50 of 260 · 37 to review" and "Load more".
- **Selection.**
  1. "Select this page" selects every loaded register row.
  2. A banner then offers "Select all 260 matching", or says "Over 1,000 match. Narrow the range to select all."
  3. "All 260 matching selected" captures the register's filter and that count. Mark reviewed / Mark unreviewed then
     send `POST /transactions/bulk-review-matching {filter, reviewed, expectedCount: 260}`. Forecast bulk actions are
     hidden in this mode (they need ids).
  4. Any change of filter, a row toggle, or Clear selection drops back to ids.
- **Outcomes.**

  | Answer | What the page does |
  |---|---|
  | 200 | Clears the selection, refetches, toasts "`updated` marked reviewed" (the server's count, not the request's) with Undo (the returned `updatedIds`, by id). |
  | 409 | Nothing was written. Drops "all matching", refetches, toasts "The count changed. Nothing was marked." with "N match now. Select again to review them." |
  | 400 `too_many_rows` | Toasts "Over 1,000 match. Nothing was marked." |
  | Other failure | Keeps the selection for a one-click retry; toasts "Couldn't mark reviewed". |

- **By id** (a row, a selection): `POST /transactions/bulk-update`, 200 ids a request, as before. Failed ids, including
  every id in a request that failed or never ran, stay selected; the toast keeps its wording ("2 marked reviewed,
  1 failed") and its Undo.
- **Row labels** (chips, words not colour; `title` says why): "After today", "Pending 14+ days" (`stalePending`),
  "Already in balance" (`heldAhead`), "Not counted" (`countsInBalance: false`, with the reason).
- **Empty states:** "Review complete. Reviewed transactions are hidden." and "No transactions in this range."
  A day whose rows continue on the next page shows its day total as "—".

### The hide-reviewed setting

- **Stored** as `user_ui_preferences.chaseHideReviewed` through the existing `GET/PUT /me/ui-preferences`. The table's
  `preferences` column is jsonb: **no DDL**.
- **Spec change, one optional property.** `UiPreferences` gained `chaseHideReviewed: boolean`. Without it the PUT
  route's generated zod body strips the key and the setting could never be saved.
- **First paint** reads localStorage (`h2-chase-hide-reviewed`, the key the page already used), inside try/catch. The
  server's value takes over when it arrives unless the user has already clicked (`useChaseHideReviewed.ts`).

## ⚠️ Decisions and deviations

- **The list follows the range.** It used to show the navigator's month even in Week mode, while the stats showed the
  week. Now week, month (the navigator's) and year each drive both. A `?month=` deep-link (Budget page) opens Month
  mode on that month. `ChaseInsightStrip` receives the same range, so in Month mode it shows the navigator's month.
- **The pinned Pending group is a separate request** (see the table). Dropping it would bring back #728's "missing
  expenses" symptom.
- **The ledger's `account` is sent only when the user picked an account.** Otherwise the server resolves the
  snapshot's account, so the first request neither waits for the forecast bundle nor repeats once it lands.
  *(review H1)* The original claim here was wrong: a non-twin account got 400 `account_not_ledger`, the page's error
  gate replaced the whole page (picker included), and the choice persisted, so the user was locked out on every visit.
  The server now serves any Chase account of the household (without balances when it is not the snapshot's), and the
  page never dead-ends (Review fixes).
- **`version: 5` on one orval operation** (above).
- **`invalidateAfterWrite` covers the ledger.** A shared file, but it is the central rule CLAUDE.md §3 names for this.
- **Server changes.** Before the review: only the one `UiPreferences` property. *(review)* Two more, both in
  `lib/bankLedger.ts` / `routes/transactionsLedger.ts` and money-neutral: H1 (other Chase accounts, no balances) and
  PR7's uncategorized rule on the ledger's `uncategorized` filter. `routes/transactions.ts`, `lib/cashSignal.ts`,
  `lib/forecastLedger.ts` and `routes/spine.ts` are identical to `d73f3bf`.
- **PR5b.** The forecast-resolution lookups are untouched. No hunk falls in `d306e7c`'s lines 871–1677 or 1727–2141,
  which hold `resolutionByTxnId` (1191), `renderForecastChip` (1302, its state and "×" choice at 1309/1328) and
  `bulkSetForecast` (1927, `notPlannedTargets` at 1941). `filtered` keeps its name, so `bulkSendToReview` and
  `bulkSetForecast` read the rows on screen with no edit.

## Figures that should move

On Brad's Chase page, after deploy:

| Figure | Before | After |
|---|---|---|
| The list | the navigator's month (any mode), up to 1,000 rows for the household | the range (Week by default), 50 at a time, "Showing 50 of N · M to review", Load more |
| Money in / out / net | every loaded row in the range, rows after today included, summed on `amount` after client dedupe | the register through today, summed on `balanceAmount`: a replaced pending row, a repeated Plaid id and a mask-twin row add 0; rows after today add nothing |
| Start / end / checking balance | client roll-forward from the snapshot over the loaded rows; end = end of range, future rows included | the server's register: `balanceStart`, `balanceEnd` (end of range or today, whichever is first) |
| Running balance per row | client chain within the month; future rows given a number | the server's `runningBalance`; none after today |
| Trend chart, actual line | client closure per Saturday | `/transactions/balances` per Saturday; today = the spine's bank balance |
| Rows listed | Chase-source and manual rows the client scope kept | the server's scope (PR13): the snapshot account, its mask twins, manual non-Amex rows |
| Labels | none | After today, Pending 14+ days, Already in balance, Not counted |
| "Showing the 1,000 most recent…" note | shown at 1,000 rows | gone |
| Freshness line | not on this page | "Last auto-updated …" / stale reasons, from the spine |
| "To review: N" | "N reviewed" | unreviewed Chase rows in the range through today |

PR13's "When PR14 moves the page" figures now apply to the page: totals and running balances cover every row on
those amounts, and today's Chase balance is the spine's.

## Must not change

- **Reviewing moves no money.** `reviewed` is the only field either review path writes.
  `chaseReviewMovesNoMoney.integration.test.ts` reviews 20 rows by id and then the other 40 by filter, and asserts after
  each that the whole `/spine` body (less `asOf`), the whole `/forecast/cash-signal` body, `/reports/spending-facts`
  for the month and the week, the forecast review count, and the ledger's totals and every running balance are
  identical.
- **Cash today, spending, forecast, spine:** no code on their paths changed.
- **`GET /transactions`** is untouched for its other callers.
- **Send-to-Forecast single flow:** `renderSendForecastAction` and `handleToggleForecast` are unchanged.
- **Routes:** none added or renamed; `routePrefetch.ts` untouched. *(review M3)* `App.tsx` changes one line: its
  `mutationCache` calls `onWriteSuccess`, which honours a mutation's `meta` opt-out.
- **Landing bundle:** *(review M4)* 574.3 KB of 580 KB, against 572.5 KB on `main` `d73f3bf` and 576.1 KB before the
  fix (Review fixes). No chart was added; the page's charts stay lazy; the entry-graph guard passes.
- **No new dependency, no DDL, no production access.**

## Residuals

- **e2e specs are not run here** (they need Clerk and a running app). *(review M2)* The earlier residual, seven specs
  left knowingly failing, was not acceptable and is withdrawn: all seven are rewritten (Review fixes). They are
  correct by reading and typecheck; none has run.
- **Request cost on open:** three ledger requests (register, pending, after today when the range reaches past today)
  plus one balances request. Each runs the register load PR13 measured at ~450 ms on 5,000 rows with 500 pending. A
  second Chase account's requests skip the cash signal and the register's balances. *(review M3)* A review refetches
  each loaded list once and nothing else; any other write (a category, an amount, a date) still refetches every
  loaded page of the three lists, in order, to keep the user's place in a long list (Review fixes, M3).
- **`?tx=` deep-links** scroll only to a row that is loaded (in the range and on a loaded page).
- **The month-jump effects are gone.** An empty week or month now shows "No transactions in this range." instead of
  jumping to the newest month with rows.
- **"Select all matching" stops at 1,000** (server rule). The banner says so and offers nothing.
- **Dead helpers.** `lib/chaseEndingBalance.ts` and `lib/runningBalance.ts`'s `computeRunningBalances` /
  `sortNewestFirst` now have no caller but their own tests. Left for PR15's clean-up.
- **PR13's open residuals are unchanged:** the logged debt payment beside its ACH, and a leftover pending row its
  posted row cannot replace (now labelled "Pending 14+ days" on screen), both Brad's decisions; past days on the
  register versus the bank balance.

## Review fixes

The independent review of `6b4fac0` ran the branch against a 131-row real-Postgres household and verified the money:
totals, start + net = end = `balanceToday` = spine, no running-balance breaks across pages, after-today rows never
totalled, no Amex or other-account rows, and select-all plus Undo moving no money. It asked for the changes below.
They are commits on top of the branch (no rebase), after a merge of `origin/main`.

### Merge of `origin/main` (`d73f3bf`: PR5a, settings fix, PR7b, PR5b) — H2

- **Merge commit `2db29d8`.** The generated `.d.ts.map` conflicts took `main`'s side, then codegen and typecheck ran.
- **Correction.** My earlier report said only the two maps conflicted. That was true of text, but the merged tree did
  not typecheck: PR5b added four tests to `chaseForecastInclusion.test.tsx` that used the `state.rows` this branch
  removed. They now run on the fake ledger server with every assertion kept (partial reads "Partly paid" with no "×"
  on a posted and a future row; "Not this" never hides a match, in either order; bulk Remove skips a partial).
- **PR5b's page behaviour survives:** `rowDecisionsByTxn` (matched wins over not_match), "Partly paid" with no "×",
  and bulk Remove skipping partials all auto-merged into the ledger page and are asserted by those tests.

### H1 — a second Chase checking account locked the user out

| Before | After |
|---|---|
| A non-twin Chase account got 400 `account_not_ledger`. The page's first-load gate turned any ledger error into a full-page "could not load", hiding the header and picker; the choice persisted in `?account=` and localStorage, so every visit and every Retry hit the same 400. | **Server:** any Chase depository account of the household (the rows the picker can offer), with its mask twins, is served. For an account that is not the snapshot's: its own rows (no manual rows), totals and review counts; every balance, `balanceAmount` and running balance null; `balanceUnavailableReason: "not_snapshot_account"`; no cash signal, no balance computed. The snapshot account's answer is unchanged to the cent. **Web:** only a cold first load shows the skeleton; a failed load renders the page with the error and Retry in the list; a saved account the server refuses resets to the default (URL and saved choice cleared, a toast says so); the balance card reads "Balance unavailable". |

**Server design** (`lib/bankLedger.ts`, `routes/transactionsLedger.ts`; spec: `LedgerRow.balanceAmount` nullable,
`balanceUnavailableReason` required on the ledger and balances responses):

1. `LedgerAccounts.snapshotAccount`. `resolveLedgerAccounts` answers the snapshot account and its twins exactly as
   before. Any other household account whose institution name contains "chase" and whose account is checking,
   depository or savings is accepted with its own twins, and its external id is the classification's account. Anything
   else is still 400 `account_not_ledger` on all three endpoints; a non-uuid is still `invalid_account`.
2. `bankRowWhere(ids, includeManual)`: another account gets only its own Plaid rows, never manual or Amex rows, in the
   register load, the page and aggregate queries, and bulk review.
3. For another account `resolveLedgerScope` never calls `computeCashSignal`; the anchor is today with every balance
   null. `loadRegister` still runs `classifyCashRows`, so a twin row is `not_bank` and a replaced pending row counts 0,
   and the running balances are null. Every row's `balanceAmount` is null; totals, review counts and `matchingCount`
   are computed as before; balances for the account are all null without loading a register.
4. `balanceUnavailableReason`: `"not_snapshot_account"`, `"no_snapshot"`, or null.

**Tests, `ledgerOtherAccount.integration.test.ts` (10):**
- account B: its own and its twin's rows across three pages of three, every balance null, totals 1,000.00 in and
  305.22 out, review counts, filters and the reason, and no cash-signal call;
- B's balances all null; asking through B's twin gives the same answer;
- account A identical with no account, with `account=A` and with A's twin (spine 2,460.00, start 2,160.00);
- the Amex card, a PayPal account, a Chase card with B's mask and another household's Chase account are
  `account_not_ledger` on all three endpoints, and `abc` is `invalid_account`, with nothing written;
- bulk review for B: a stale count is 409, the right count (7) marks only B's rows, A untouched;
- no snapshot gives `no_snapshot`, and then a second Chase savings account gives `not_snapshot_account`.

`transactionsLedger.integration.test.ts` (22) needed no change. The page's picker also matches Plaid's `ins_56`
institution id, but `listCheckingAccounts` never sends that field, so the name rule offers the same accounts.

### M1 — day totals counted rows the ledger doesn't

- **Before:** a day's total summed `amount`, so a mask-twin or duplicate row (listed at `balanceAmount` 0) doubled into
  it, and days no longer reconciled with the card.
- **After:** day totals and the Pending group's total sum `countedAmount` (`balanceAmount`, or `amount` where
  `countsInBalance` on an account with no register), in whole cents; the Pending total also leaves out rows dated
  after today.

### M2 — seven e2e specs knowingly failing

- **Before:** five specs mocked `**/api/transactions**` with an array, which now also intercepts the ledger requests,
  and two account-picker specs expected the old behaviour. The note called them residuals; the review rejected that.
- **After:** all seven seed the database (no transaction mocks), open `?month=`, capture the ledger responses they
  need, and compare the page to them in cents. Data sits in past months, so no row is after today.

| Spec | What it seeds and asserts now |
|---|---|
| `transactions-chase-hides-amex` | **Linked checking.** Chase rows (a Plaid deposit, a "chase" import, a manual row) plus an `amex` row, a row on an Amex card account, a `plaid:amex` and a `plaid:capitalone` row with no account. Exactly the three Chase rows are listed; the other four are absent by id and description; the ledger totals and the card read In $200.00 / Out $40.00 / Net +$160.00, never Out $202.00; start = end − net. **No checking linked** (#448 fallback): the same row guard, the ledger totals and the day total. That page has no in/out card, so its card assertions become ledger-total assertions. |
| `transactions-chase-no-duplicates` | The same −$12.34 purchase on the snapshot account and on its mask twin, plus −$4.50. Each id renders once, the twin copy is `not_bank` with "Not counted", the day total is −$12.34, money out is $16.84 (not $29.18), start = end + $16.84. A same-`plaidTransactionId` duplicate cannot be seeded: `transactions_plaid_txn_uq` is unique. |
| `chase-relink-duplicate-no-double-balance` | A (snapshot, $1,000.00), B checking, C savings, and a twin of A with its own $1,000.00 per-account snapshot. **Phase 1:** A's ledger includes the twin's account id; the balance card shows $1,000.00 / $1,025.00, never $2,000.00; running balances match. B and C show their rows and money with "Balance unavailable", null balances and no chips. **Phase 2:** the twin is deleted and the page reloaded; the C pick persists, the twin is not offered, A's figures are identical. |
| `chase-relink-duplicate-with-transactions-no-double-balance` | A's two purchases re-imported onto the twin. **Phase 1:** 4 rows listed once each, copies "Not counted", day totals −$25.00 / −$10.00, money out $35.00 (not $70.00), balances $1,000.00 / $1,035.00, B and C without balances. **Phase 2:** copies and twin deleted; every figure is identical. The old #462 guard ("the twin's activity is added to A's balance") becomes "listed, not counted, never double", the server's twin rule. |
| `chase-month-bottom-renders` | A with 88 rows a month (its own plus manual rows) and B with 66, over 22 days, for A and B, in the opened month and the one before. The first 50 render and the oldest loaded day's total reads "—"; the first day of the month is absent until Load more; the button goes once all rows are in; that day group then has exactly its rows and total. A has running-balance chips; B has none and reads "Balance unavailable". The picker loop is kept; the removed "Manual entries" option is dropped from it. |
| `transactions-chase-account-picker` | A, B and a manual row. A lists its rows and the manual row with card figures, balances and chips. Picking B lists only B's rows (the manual row gone), B's money, "Balance unavailable", no chips, and a response with `not_snapshot_account` and nulls. The pick persists across a reload and from localStorage alone; back to A restores the same figures, with `?account=` holding A. |
| `transactions-chase-account-stale` | **Deleted B:** the reload's `account=B` request gets 400 `account_not_ledger`, the page falls back to A, and URL and storage are cleared. **Added:** an Ally savings account and a random uuid, each set in the URL and localStorage, with `/api/forecast` held until the reset is seen, so only the server's 400 can have cleared the pick; then A's cards. |

- **`transactions-chase-running-balance`** (rewritten in the first round) now asserts `balanceAmount` is non-null on the
  snapshot account before chaining on it: the field became nullable for another account.
- **`transactions-chase-account-picker-chase-only`** still holds under the new contract.
- **`transactions-chase-account-picker-hidden`** was already broken before PR14: it waited on `text-snapshot-meta`,
  which the page renders only on the manual-entries view since `9d7f9dcf`. Fixed in this round: it now waits for the one seeded row and the balance card (which renders only once the forecast bundle names the linked account), then makes the same two assertions that the picker is absent. The `••5526` text it also checked no longer renders for a linked account.
- **Assumptions not confirmable by reading** (the specs have not run):
  - mask twins are seeded with a different account name and `autoDedupeRanAt` stamped, because the forecast route's
    dedupe groups by institution + mask + name;
  - in/out amounts are read beside the card's exact "In" / "Out" / "Net" labels;
  - a twin is never asserted as a picker option, because `listCheckingAccounts` merges twins.
- **Typecheck:** `pnpm --filter h2budget run typecheck:e2e` exits 0.

### M3 — every write fired far more requests than needed

- **Before** (review's measurement, 3 pages loaded, one row reviewed): 8 ledger GETs + 2 balances GETs. The central
  after-write rule fired per mutation (per 200-id chunk), then the page's own awaited invalidation cancelled and
  restarted it, and the server still did the cancelled work. The UI-preference save refetched balances and marked the
  spine and reports stale.
- **After.**
  - `mutationInvalidation.ts`: `OWN_INVALIDATION` mutation `meta` opts a write out of the central rule
    (`onWriteSuccess`, called by `App.tsx`'s `mutationCache`).
  - The two review mutations and the UI-preference save carry it. The review writes refetch the Chase **lists** once,
    after the whole chunk loop (`invalidateBankLedgerLists`), and only mark the old transaction list stale. They never
    touch balances, the spine or reports, which a review does not move (`chaseReviewMovesNoMoney`).
  - The page's own invalidation calls are gone.
  - Measured by a test on the same shape: one review → register pages refetched once in order (cursor null, 50, 100),
    pending list once, after-today list once, **5 ledger GETs, 0 balances GETs, 1 write**; saving the hide setting
    → 0 balances GETs.
- **Kept, deliberately:** any other write still refetches every loaded page of the three lists. Resetting an infinite
  list to its first page would throw away the user's place in a long list (a row reviewed at #120 would scroll away).

### M4 — landing bundle

- **Fix:** the Chase-only operations carry a `chase-ledger` tag; orval's main react target excludes the tag and a
  second target generates it into `lib/api-client-react/src/ledger`, exported as `@workspace/api-client-react/ledger`.
  Hooks stay generated. The page, its hooks and tests import from the new module. The ledger module's
  `api.schemas.ts` is a full copy of the schema types: types only, no bytes at run time.

  | Tree (web build + guard, same machine) | Landing | `index` | `vendor-query` |
  |---|---|---|---|
  | `main` `d73f3bf` | 572.5 KB | 239.9 KB | 51.3 KB |
  | branch before the fix (`2db29d8`) | 576.1 KB | 242.3 KB | 52.5 KB |
  | branch after the fixes | **574.3 KB** | 240.5 KB | 52.5 KB |

- **What remains above `main`:** `useInfiniteQuery` in `vendor-query` (+1.2 KB, no cheap fix, as the review found) and
  +0.6 KB of entry code, mostly the M3 after-write helpers `App.tsx` imports. The review's 573.9 KB was measured before
  the merge of `main`.

### LOW and NIT

| Finding | Fix |
|---|---|
| LOW-1 pending rows dated after today appeared nowhere | The pending list has no `to`; after-today pending rows from any list join the pinned group, labelled "After today", out of its total. |
| LOW-2 stale figures under a new range label | While the register shows the previous filter's data (`isPlaceholderData`), money in/out, change, start, end, the sparkline and "To review" read "—" and the pager is hidden. |
| LOW-3 "No rows through today" in the error state | That text only when no day of the range is through today; "Couldn't load" on a failed load; "—" while loading. |
| LOW-4 Undo cleared the selection | Review writes merge into the selection (saved rows leave it, failed rows stay or join it). |
| LOW-5 chart seed from `cashProjection.bankToday` | Removed: no balance for today, no seed. |
| LOW-6 note | This section; the H1 claim is corrected in place, and the "only two maps conflict" claim is corrected above. |
| NIT mono counts | The select-all count and every count in the review toasts are mono spans (toast titles are now React nodes; `use-toast`'s type no longer intersects the HTML `title` string). |
| NIT "Showing X of Y" scope | A `Help` chip beside it: rows in this range through today; pending and after-today rows are listed apart and not in this count. |

### Consistency with PR7's uncategorized rule

- **Before:** the ledger's `uncategorized` filter matched only `category_id is null`. PR7's `classifyOutflow` and
  `GET /transactions?uncategorized` also count a row whose category no longer exists.
- **After:** in `filterWhere`, uncategorized is no category, or a category id with no `budget_categories` row in the
  household. The page, `matchingCount`, totals, review counts and bulk review by filter all read it. Nothing else in
  the ledger changed.
- **Tests (2, in `ledgerOtherAccount`).** One household, five rows: no category, a live category, a deleted category,
  a category id that never existed, and another household's category.
  - `uncategorized=true` lists exactly the four without a live category of their own household, never the live one:
    `matchingCount` 4, totals 40.00 in and 90.00 out, review 1 reviewed and 3 not; with `reviewed=false` 3. Without
    the filter all five are listed once (110.00 out).
  - Bulk review by `{ uncategorized: true, reviewed: false }`: expected count 2 is 409 `matching_count_changed`
    (`matchingCount` 3) and writes nothing; 3 marks exactly the no-category, deleted-category and foreign-category
    rows, and the live-category row stays unreviewed.

### Tests added in the review round

- **Web, `chaseReviewInbox.test.tsx`** (+11, the page's QueryClient now built like `App.tsx`: its `mutationCache` and
  `keepPreviousData`): H1 second account ("Balance unavailable", its rows and totals, no balances asked for or drawn);
  H1 refused saved account resets; H1 failed load keeps header, picker and controls and Retry recovers; M1 twin plus
  duplicate on one day; LOW-1 with a pending twin; M3 request counts; LOW-2; LOW-4 with Undo; LOW-5 and its control;
  NIT mono. The labels test now asserts the pending list sends no `to`.
- **Web, `chaseLedger.test.ts`** (+3): `countedAmount`, `sumCounted` in cents. **`mutationInvalidation.test.ts`** (+2):
  the `meta` opt-out and lists-only invalidation.
- **Web, migrated:** PR5b's four `chaseForecastInclusion` tests (merge). Review toasts are read as text
  (`__test-helpers__/toastText.ts`).

### Fails before (review round)

On `2db29d8` (the merge, before any fix), with the round's web test files and helpers copied in, and one shim so the
inbox file loads: an `onWriteSuccess` that always runs the after-write rule, which is exactly what the old
`mutationCache` did.

| File | On `2db29d8` |
|---|---|
| `chaseReviewInbox.test.tsx` | 11 of 27 fail: all 10 new review tests except the LOW-5 control, plus the labels test's new "pending list sends no `to`" assertion |
| `transactions/chaseLedger.test.ts` | the 3 new tests fail (`countedAmount is not a function`) |
| `lib/mutationInvalidation.test.ts` | does not load (no `OWN_INVALIDATION` export) |
| `chaseReviewed.test.tsx` | passes: only its toast assertion's reading changed |

**Server.** `ledgerOtherAccount.integration.test.ts` run against PR13's `lib/bankLedger.ts` and
`routes/transactionsLedger.ts` (restored from `2db29d8` in a temporary worktree at `b9e870f`, own database, since
dropped): **9 of 10 fail**. The one that passes is the refusal of the Amex card, PayPal, the Chase card with B's mask,
another household's account and `abc`, which PR13 already refused.

### Verification (review round)

On `efc3fef` with this note on top (branch head after the merge of `d73f3bf` and the fixes):

- **Typecheck:** `pnpm run typecheck` exit 0. `pnpm --filter h2budget run typecheck:e2e` exit 0.
- **Web suite** (`TZ=UTC CI=true pnpm --filter h2budget exec vitest run`): **128 files, 1,061 passed.**
- **Full API suite** (local test database `h2budget_test_pr14r_final`, since dropped): **134 files, 1,220 passed,
  7 todo.**
- **Build:** `pnpm run build` exit 0. **Entry-graph guard:** OK: no recharts on open, react-dom only in `vendor-react`.
  **Landing JS 574.3 KB of 580.0 KB** (173.1 KB gzipped); M4's table has the before and after.
- **Codegen:** re-run on the committed spec; no file changed.
- **Unchanged from `main` `d73f3bf`:**
  - API: `routes/transactions.ts`, `routes/spine.ts`, `lib/cashSignal.ts`, `lib/forecastLedger.ts`,
    `lib/ledgerCashRows.ts`;
  - web: `lib/routePrefetch.ts`;
  - packages: `lib/avalanche-core`, `lib/db`.
- **Not verified here:** any e2e run (Clerk and a running app), a browser pass at 1280 and 390 wide, Brad's live data,
  production (untouched).
- **Local only:** the darwin binaries for rollup, lightningcss and `@tailwindcss/oxide` were copied from the main
  checkout into the worktree's `node_modules`. Nothing about that is committed.

## Tests

### Web (vitest, jsdom)

**`pages/chaseReviewInbox.test.tsx`** (new, 16 tests)
- **Setup.** The ledger, balances, bulk-review and UI-preference hooks are the real generated hooks. Their answers come
  from `pages/__test-helpers__/fakeLedgerServer.ts`, a fetch-level fake that follows the PR13 contract (filters, newest
  first, cursor, `matchingCount`, totals on `balanceAmount` over every filter but `reviewed`, 409/400 on bulk review).
- **Clock:** pinned to Wednesday 2026-09-16, so the week is 09-13..09-19 and the register asks 09-13..09-16.

| Test | What it asserts |
|---|---|
| Paging | "Showing 50 of 120 · 120 to review"; the register asks `from` 09-13, `to` today, `limit` 50; Load more sends cursor 50, then 100: 100 then 120 unique rows, and the button goes. |
| After today | 09-17..09-19 asked apart; the row is labelled "After today"; money in/out shows $40.00, never $500.00 or $540.00. |
| Old list, freshness | `useListTransactions` never called; no GET `/api/transactions`; no cap note; "Last auto-updated" shown. |
| Select all matching | Select this page → "50 selected" → "Select all 120 matching" → "All 120 matching selected", forecast actions hidden → one POST `{ filter: { from: "2026-09-13", to: "2026-09-16" }, reviewed: true, expectedCount: 120 }`, no per-id write, toast "120 marked reviewed", "0 to review" after the refetch. |
| 409 | A row lands after "select all": toast "The count changed. Nothing was marked." / "121 match now. Select again to review them."; no row reviewed; the register is asked again; "Showing 50 of 121"; "all 120" gone. |
| Partial failure | 3 selected, one refused: "2 marked reviewed, 1 failed", "1 selected", only the refused row still selected. |
| A request fails part-way | 250 rows over five pages, the second 200-id request answers 500: "200 marked reviewed, 50 failed", "50 selected", 200 rows reviewed. |
| Review 20, clear, show | 20 reviewed by id (body is exactly those ids); Clear → all 20 gone, "Showing 40 of 40 · 40 to review", request `reviewed=false`, the money and balance cards unchanged to the character; Show reviewed → all 20 back, "40 to review". |
| Empty states | "Review complete. Reviewed transactions are hidden."; "No transactions in this range." |
| Setting persists | A click PUTs `{ chaseHideReviewed: true }` and sets the seed; with no seed, the server's `true` is adopted; with the seed, the very first register request already has `reviewed=false`. |
| Labels | A stale pending row from 08-20 appears (the pending list asks no `from`, `to` today) with "Pending 14+ days"; "Already in balance" (title explains), "Not counted"; running balances are the server's ("bal $900.00"), none where the server gives none. |
| No $0 | Null balances: the balance card reads "—" and the page contains no "$0.00"; a failed ledger: "Chase transactions could not load.", Retry, and no dollar figure at all. |

**`pages/transactions/chaseLedger.test.ts`** (new, 18 tests)
- `splitAtToday` for a past range, a range reaching past today, one ending today, one wholly after today, and a year end.
- The list's query and the bulk filter carry the same keys.
- Page flattening keeps order and lists a repeated row once.
- `moneyOrNull` never turns a missing value into 0.
- Balance dates stay at or under 120.
- Each row label.

**`lib/mutationInvalidation.test.ts`** (+1 test): a write marks the ledger's infinite key and the balances key stale.

**Migrated, 17 tests** (`chaseReviewed` 3, `chaseStats` 6, `chaseForecastInclusion` 5, `chaseBucketChip` 3). They run
on the fake server instead of a stubbed `useListTransactions`, and each asserts the old list is never called.
Replaced assertions, each equal or stricter:
- **`chaseStats`, the floating-point start** (0.30 − 0.10 − 0.20, a hair off $0). This cannot arise now that the
  server sends cents strings. It becomes: `balanceStart: null` gives "Change—", the balance card shows "—", and there is
  no "$0.00" and no dollar figure at all in that card. The test is renamed accordingly.
- **`chaseStats`, the $0 start** is now `balanceStart: "0.00"`, with the same assertions. The real-start test also
  requires the server's $1,000.00 and $960.00 in the balance card.
- **`chaseReviewed`, "clear writes nothing"** was "a mock was not called". It is now:
  - no POST to either review endpoint, and the server's rows are unchanged;
  - the list is asked again with `reviewed=false`;
  - `{ chaseHideReviewed: true }` is saved, and the seed is set.
- **`chaseReviewed`, "marks a row reviewed"**: exactly one POST, its body exactly `{ ids: ["todo"], patch: { reviewed:
  true } }`, no other write, and the server row is reviewed.
- **`chaseReviewed`, "partial failure"** keeps "1 marked reviewed, 1 failed" and "1 selected". It adds: the refused row
  is still selected, the saved one is not, and the server's rows match.
- **`chaseForecastInclusion`** opens `?month=2026-09-01` with the clock pinned, so the 27th arrives through the
  after-today request (asserted). Every forecast-chip assertion is unchanged.

### API (integration, real Postgres)

- **`chaseReviewMovesNoMoney.integration.test.ts`** (new, 5 tests)
  - **Fixture:** 60 Chase rows (one pending, two paychecks, one after the snapshot) and 6 Amex rows.
  - **Reviewing moves nothing:** 20 rows reviewed by id, then the other 40 by filter (`updated` 40). After each step
    these are identical, with no closeTo:
    - `/spine` (less `asOf`), `/forecast/cash-signal`, and `/reports/spending-facts` for the month and the week;
    - `/forecast/review-count`;
    - ledger totals, start, end, today, and every running balance.
  - **Stale counts:** 39 and 41 are 409 with nothing reviewed; un-review with a stale count is 409 with nothing changed.
  - **Not vacuous:** the bank balance is not null and not the snapshot, spending is non-zero, the daily series moves,
    and the review count is above 0.
- **`uiPreferencesPerUser.integration.test.ts`** (+1 test): `chaseHideReviewed` is saved and read back, and survives a
  `sidebarCollapsed` update and a flip to false. A second user in the household does not see it.

### e2e (not run here: needs Clerk and a running app)

- **`e2e/transactions-chase-running-balance.spec.ts`**, rewritten.
  - **Seed:** 120 rows through the database, with no transaction mocks. Twelve are credits; all are dated this month
    through today in Chicago. A $5,000.00 manual snapshot is taken after them.
  - **Checks:**
    - "Showing 50 of 120 · 120 to review", then Load more to 100 and 120, with the button gone at the end.
    - Each "bal" chip equals the ledger response's `runningBalance`, and the newest equals `balanceToday`.
    - The chain (next = previous − previous `balanceAmount`, in cents) holds across both page boundaries.
    - Everything repeats at 1280×800 and at 390×844.
  - **Typecheck:** `pnpm --filter h2budget run typecheck:e2e` exits 0.

## Fails before

**Web.** The branch's web test files were copied into a detached worktree of `d306e7c` (main's page, hooks and
generated client) and run there. 28 of 33 page tests fail, and the two other files fail to load.

| File | On `d306e7c` |
|---|---|
| `chaseReviewInbox.test.tsx` | 16 of 16 fail |
| `chaseReviewed.test.tsx` | 3 of 3 fail |
| `chaseForecastInclusion.test.tsx` | 5 of 5 fail |
| `chaseStats.test.tsx` | 3 of 6 fail (the three change and balance tests); the three "No checking account linked" tests pass: that behaviour did not change |
| `chaseBucketChip.test.tsx` | 1 of 3 fails ("says All reconciled…"); the other two pass: the chip did not change |
| `transactions/chaseLedger.test.ts` | does not load: `./chaseLedger` does not exist |
| `lib/mutationInvalidation.test.ts` | does not load: `getGetTransactionsLedgerInfiniteQueryKey is not a function` |

**API.**
- `chaseReviewMovesNoMoney` is a guard, not a fix. Review wrote only `reviewed` before this branch too, and it is
  expected to pass on `d306e7c`. It was not run there.
- The new `uiPreferencesPerUser` test would fail on `d306e7c` at its first assertion. That commit's generated
  `UpdateUiPreferencesBody` has only `sidebarCollapsed`, so the PUT strips `chaseHideReviewed`. This is read from the
  code; the test was not run there.

## Verification

On `9219d0a`, with this note on top:

- **Typecheck:** `pnpm run typecheck` exit 0; `pnpm --filter h2budget run typecheck:e2e` exit 0.
- **Web suite** (`TZ=UTC CI=true pnpm --filter h2budget exec vitest run`): **121 files, 968 passed.**
- **Full API suite** (local test database `h2budget_test_pr14`, since dropped): **127 files, 1,065 passed, 7 todo.**
- **Build:** `pnpm run build` exit 0. **Entry-graph guard:** OK: no recharts on open, react-dom only in `vendor-react`.
- **Landing JS: 576.1 KB of 580.0 KB** (173.3 KB gzipped). `d306e7c` built the same way: 572.5 KB (172.6 KB gzipped).

  | Chunk | `d306e7c` | Branch |
  |---|---|---|
  | `index` | 239,881 bytes | 242,289 bytes (+2,408) |
  | `vendor-query` | 51,341 bytes | 52,498 bytes (+1,157) |
  | `vendor-react`, `vendor-clerk` | unchanged | unchanged |

  **Why.** On `d306e7c` the entry chunk holds no ledger code (zero occurrences of `transactions/ledger`). The generated
  client is one module shared with the landing route, so every hook a lazy page uses stays in the entry chunk. The Chase
  page now uses the ledger, balances, bulk-review and UI-preference hooks, and `useInfiniteQuery` joins
  `vendor-query`. That leaves 3.9 KB of headroom; the cap is not raised.
- **Codegen:** re-run on the branch; `git diff --exit-code lib/api-zod lib/api-client-react lib/api-spec` is clean.
- **Protected paths identical to `d306e7c`:**
  - API: `routes/transactions.ts`, `routes/transactionsLedger.ts`, `routes/spine.ts`, `lib/bankLedger.ts`,
    `lib/cashSignal.ts`, `lib/forecastLedger.ts`, `lib/ledgerCashRows.ts`;
  - web: `lib/routePrefetch.ts`, `App.tsx`;
  - packages: `lib/avalanche-core`, `lib/db`.
- **Not verified here:**
  - the e2e specs;
  - a browser pass at 1280 and 390 wide;
  - Brad's live data;
  - production (untouched).
- **Local only:** the darwin binaries for rollup, lightningcss and `@tailwindcss/oxide` were copied into the worktree's
  `node_modules` from the main checkout, so the tests and build could run. Nothing about that is committed.
