# PR14 — Chase review inbox

Plan PR14 [Codex points 10, 11]: the web half of the Chase ledger. It moves the Chase page onto PR13's server ledger
(`d306e7c`) and gives it a review inbox. Branch `feat/chase-review-inbox`, cut from `main` at `d306e7c`.

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
  types with an untyped `pageParam` that failed typecheck. The generated diff touches only the ledger operation (its
  plain `useGetTransactionsLedger` picks up the v5 option types) and `UiPreferences`. No other operation changed.
- **Three ledger lists** (`pages/transactions/useChaseLedger.ts`, 50 rows a page, `staleTime` 2 min, `gcTime` 30 min):

  | List | Filter | Used for |
  |---|---|---|
  | Register | the range, `to` = min(range end, household today) | rows, "Showing X of Y", "To review", money in/out, start and end balance, select all matching |
  | Pending | `pending=true`, `to` = today, no `from` | the pinned Pending group (#728: every pending row whatever the range) |
  | After today | tomorrow .. range end, only when the range reaches past today | rows labelled "After today"; never totalled, no balance |

  All three share the account, category and hide-reviewed filters. The overlap (a pending row inside the range) is
  merged by id. They are three different questions, not one question asked twice.
- **Why the register stops at today.** PR13's residual: a `totals` range that reaches past today can count a charge
  twice among rows dated after today, and no balance exists after today. So totals and balances cover the range
  through today, and after-today rows are listed apart (`splitAtToday` in `pages/transactions/chaseLedger.ts`).
- **Balances.** One `GET /transactions/balances` per range carries both the sparkline's days (≤ 40, through today) and
  the trend chart's week-ending Saturdays before today (≤ 27); ≤ 120 by construction and capped in code. Today's point
  on the chart is `balanceToday` (the spine's `bank.balance`), then the balances response's anchor, then the cash
  signal's `bankToday`. With none of them there is no seed at all; the old `: 0` fallback is gone.
- **Running balances** are each row's `runningBalance`. A row the server gives none (after today, no snapshot time)
  shows none.
- **Invalidation.** `lib/mutationInvalidation.ts` (`invalidateAfterWrite`, run by `App.tsx`'s `mutationCache` after
  every write) now also marks every ledger and ledger-balance query stale. The infinite key starts `"infinite"`, so
  the page's existing `getListTransactionsQueryKey()` invalidations never reached it. The review writes also
  invalidate the ledger directly and await it.
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
  snapshot's account, so the first request neither waits for the forecast bundle nor repeats once it lands. A picked
  account that is neither the snapshot's nor its mask twin is a 400 from PR13's server; the page shows "No ledger for
  this account yet." and keeps the picker reachable (Residuals).
- **`version: 5` on one orval operation** (above).
- **`invalidateAfterWrite` covers the ledger.** A shared file, but it is the central rule CLAUDE.md §3 names for this.
- **No server behaviour changed except the one `UiPreferences` property.** `routes/transactions.ts`,
  `routes/transactionsLedger.ts`, `lib/bankLedger.ts`, `lib/cashSignal.ts`, `lib/forecastLedger.ts`, `routes/spine.ts`
  are identical to `d306e7c`.
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
- **Routes:** none added or renamed; `routePrefetch.ts` and `App.tsx` untouched (the lazy `/transactions` import is
  the same module).
- **Landing bundle:** 576.1 KB of 580 KB, up 3.6 KB from 572.5 KB on `d306e7c` (Verification says why). No chart
  was added; the page's charts stay lazy; the entry-graph guard passes.
- **No new dependency, no DDL, no production access.**

## Residuals

- **e2e specs not run here** (they need Clerk and a running app). `transactions-chase-running-balance.spec.ts` is
  rewritten (Tests). Five other specs mock `**/api/transactions**` with an array, which now also intercepts the ledger
  requests, so they will fail until they seed rows and read the server's scope instead:
  `chase-month-bottom-renders`, `chase-relink-duplicate-no-double-balance`,
  `chase-relink-duplicate-with-transactions-no-double-balance`, `transactions-chase-no-duplicates`,
  `transactions-chase-hides-amex`. What they guard (Amex hidden, no duplicate rows, relink twins counted once) is now
  the server's job, and PR13's ledger tests assert it.
- **A second, non-twin Chase checking account has no ledger.** PR13's server serves the snapshot's account and its mask
  twins only. `transactions-chase-account-picker` and `transactions-chase-account-stale` pick such an account and
  expect its rows; they will see "No ledger for this account yet." The picker is hidden for a household with one Chase
  checking account (`transactions-chase-account-picker-hidden`). Fix: a ledger for other checking accounts (PR13's
  "Left for PR14 and after").
- **Request cost on open:** three ledger requests (register, pending, after today when the range reaches past today)
  plus one balances request. Each runs the register load PR13 measured at ~450 ms on 5,000 rows with 500 pending. Every
  successful write, the UI-preference save included, refetches the loaded ledger pages in order.
- **`?tx=` deep-links** scroll only to a row that is loaded (in the range and on a loaded page).
- **The month-jump effects are gone.** An empty week or month now shows "No transactions in this range." instead of
  jumping to the newest month with rows.
- **"Select all matching" stops at 1,000** (server rule). The banner says so and offers nothing.
- **Dead helpers.** `lib/chaseEndingBalance.ts` and `lib/runningBalance.ts`'s `computeRunningBalances` /
  `sortNewestFirst` now have no caller but their own tests. Left for PR15's clean-up.
- **PR13's open residuals are unchanged:** the logged debt payment beside its ACH, and a leftover pending row its
  posted row cannot replace (now labelled "Pending 14+ days" on screen), both Brad's decisions; past days on the
  register versus the bank balance.

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
