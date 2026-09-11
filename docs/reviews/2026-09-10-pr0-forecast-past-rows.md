# PR0 — Finish `fix/forecast-reliability-review`: posted rows are cash in Review too

Codex work-order points covered: **1** (every screen agrees on cash today), **5** (moved/matched bills stay
dependable), **10** (Chase/Review can be finished), **12** (no silent failures). This PR makes Codex's
`c6bbf28` mergeable. It does not start the later packages. Plan:
`~/.claude/plans/h2-budget-work-serene-pebble.md`.

## What changed

- **One rule for "is this row in the forecast?"** — `inForecast(row, today)`: a row dated on or before
  today has already moved money, so it is in the forecast whatever its flag says. The flag only gates
  future rows.
  - Lives in `lib/avalanche-core/src/forecastInclusion.ts`. The SQL twin is `inForecastWhere` in
    `artifacts/api-server/src/lib/forecastInclusion.ts`.
  - Used by the cash curve (`cashSignal.ts`), the `/forecast` bundle's transaction list and resolution
    filter (`routes/forecast.ts`), the review badge (`reviewCount.ts`, which also feeds the spine), and
    the web inbox filter (`forecastMatch.ts`).
  - **Before**, `c6bbf28` put these rows on the curve, but the bundle, badge and inbox still required the
    flag. A posted row with the flag off moved the balance while staying invisible to Review, so it could
    never be matched to the bill it paid.
- **Turning the flag off no longer un-pays a bill.**
  - `PATCH /transactions/:id` and `POST /transactions/bulk-update` delete a row's resolution only when
    the row is future-dated.
  - On the Forecast page, the inbox "X" on a row that has already happened records "Not a planned
    payment" (`ignored_unforecasted`) instead of flipping the flag.
  - **Before**, the flag flip deleted the match, so the bill started dragging again while its payment
    stayed on the curve — the same money counted twice.
- **One checking account everywhere.**
  - The bundle and the badge resolve the bank account with `resolveSnapshotAccount` (pointer, then
    snapshot mask, then sole checking/depository), exactly as the balance roll-forward does.
  - The bundle returns `checkingAccountExternalId` (OpenAPI + regenerated client), which the page prefers.
  - **Before**, a missing or dangling pointer emptied Review and zeroed the badge while the curve kept
    moving.
- **Returning rows are easy to clear.** When the inbox holds posted rows with the flag off, a note says
  so and offers "Mark N unplanned". The three copies of the bulk "unplanned" loop are now one
  `markTxnsUnplanned`.

## Figures that should move

| Where | What changes |
|---|---|
| **Review badge** (nav, landing bell, spine `reviewCount`) | Can rise. Newly counted: posted checking rows this month whose flag was off — rows taken out of the forecast earlier, gap-backfill rows after a reconnect, user-tagged transfers, manual rows (including payments logged from the Debts page). |
| **Review inbox** | The same rows appear, each matchable. "Mark N unplanned" clears them in one click. |
| **Forecast curve and "Bank today"** | **No change versus `c6bbf28`.** Versus live `main` (`d117af4`): the curve's opening balance now includes posted rows whose flag was off. This was `c6bbf28`'s fix; it makes the first curve point equal "Bank today". |
| **Bills matched to a row that later had its flag turned off** | Stay paid. Before, they restarted and were subtracted again. |

"Before" live figures were **not captured**: the signed-in browser was held by another session for the
whole window. Every movement above is pinned by a test instead.

## Must not change

- "Bank today" is still derived the same way. `bankToday` code is untouched, and the $850 acceptance
  test holds through review, flag-off and tagging.
- Send to Forecast = in Review = on the curve (one flow, no second gate).
- Future rows: the flag still decides whether they are projected, and turning it off still drops their
  resolution.
- No Plaid calls; server auto-match stays off.
- The spine never carries a debt balance.
- Landing JS stays within budget.

## Independent review before merge, and what was done

A separate reviewer read the diff before anything was committed. Each finding and what happened to it:

1. **HIGH — both bulk routes still deleted matches on posted rows.**
   - Affected: `POST /transactions/bulk-update` and `POST /transactions/bulk-set-forecast-flag`. The second is the Chase page's bulk "Remove from Forecast".
   - Only single-row PATCH had the new guard, so a bulk Remove on a matched posted row still restarted its bill.
   - **Fixed:** both routes now drop resolutions only for future rows. New tests check that a matched $95 payment keeps its match through each route (ending balance $810, not $715), and that future rows still lose theirs.
2. **MEDIUM — the Chase page still decided "in Review" by the flag.**
   - **Fixed:** the chip, Send button, row dimming, `data-sent`, the ×, and bulk Remove all follow `inForecast`, using the server's date.
   - On a posted row still awaiting review, the × records "Not a planned payment".
   - A posted row that is already matched or marked not planned has no ×; its match is managed in Review.
   - Bulk Remove writes that resolution for posted rows and flips the flag only on future rows. Undo reverses both.
3. **MEDIUM — Review-page reconcile and month-close numbers shift.**
   - **Intended, now pinned by a test.** A posted transfer whose flag is off now counts in "Starting balance vs bank snapshot".
   - `forecastPastRowsReconcile.test.ts`: $1,000 − $200 groceries − $300 transfer, bank $500. The old flag-only register reported a **$300 gap**; the register now reports **$0**.
   - Month close never hid unresolved rows. Posted flag-off rows from last month now show when viewing last month, as flagged unresolved rows always did.
4. **MEDIUM — transfers flood Review, and the one-click button would mark them "not planned".**
   - **Fixed:** "Mark N unplanned" now skips transfers and card payments. They stay listed to be matched, since they are the rows most likely to pay a planned bill or debt minimum.
   - The two-sentence note is now a label with a Help chip.
5. **LOW — the browser's date and the server's date could disagree.**
   - **Fixed:** the bundle carries `today`, the server's date that the badge used.
   - The Forecast and Chase pages use it, and the Forecast register recomputes when it changes.
6. **LOW — test strength.**
   - **Fixed:** past-row tests added for both bulk routes.
   - The e2e `transactions-bucket-badge` spec now skips from the 26th of the month. Its "sendable" row is only in the future until then.
   - **Kept on purpose:** the e2e `forecast-inbox-pager` spec still accepts either × label. Its rows are seeded on the 14th and 16th, so whether they have already happened depends on the day it runs.

## A test that failed or passed depending on file order (fixed, unrelated to the forecast)

`plaidTransactionsLimit.integration.test.ts` ("self-heals: a successful refresh clears the stamps") timed out
in the second full API run and hung when run alone.

- **Why:** the test walks `syncPlaidItem`'s poll-after-refresh budget, about 22s of real waits in
  production. It only ever passed when a sibling file that sets `PLAID_REFRESH_POLL_DELAYS_MS=5,5` had
  already run in the shared Vitest fork. After the first run cached test timings, Vitest reordered the
  files and the dependency broke.
- **Proof:** alone with that value set, all 3 of its tests pass in under a second.
- **Fix:** the file now sets the value itself, as its siblings do. No production code changed; this is
  its own commit.

## How it was verified

- **Typecheck:** whole workspace passes, e2e included.
- **Web:** 780/780 tests pass. `chaseOnlyForecast.test.ts` pins that a posted Chase row with the flag
  off reaches the inbox, a future one does not, and Amex never does.
- **API:** full suite on an isolated database (`h2budget_test_pr0`).
  - First run: 754 pass, 1 fail. The spine test had hard-coded the old count of "two flagged rows".
  - That expectation is now derived from the fixture's dates under the new rule, so it holds on any day
    of the month. The parity assertion itself (spine = badge) was already passing and is unchanged.
  - Re-run of every file this PR touches: 67/67.
- **New `forecastPastRows.integration.test.ts`** (real routes, real Postgres):
  - A posted flag-off row is on the curve, in the bundle and in the badge; a future flag-off row is not.
  - **Codex acceptance:** $1,000 − $200 + $50 = **$850** for `bankToday`, the first curve point and the
    ending balance. It stays $850 after marking reviewed, turning the flag off, and tagging unplanned in
    bulk.
  - $95 phone bill matched to its payment, then flag off: the match survives. Bank today $905, ending
    **$810**; deleting the match would give $715.
  - A future row's resolution is still dropped on flag-off.
  - A missing pointer finds the account by mask for the bundle and the badge (bank today $960).
- **Updated tests, stricter rather than weaker:**
  - `badgeCounts`: now also counts a posted flag-off row and a future flagged row, still excludes a
    future flag-off row, and adds a missing-pointer case.
  - `transactionsBulkUpdate`: the "drops resolutions on flag-off" case now uses future-dated rows, which
    is the rule.
  - e2e `forecast-inbox-pager`: accepts the button's new name for past rows.
- **Build and bundle guard:** landing **571.2 KB of 580 KB**; no recharts on open.

## Final gate, after the review fixes (2026-09-11)

Everything below ran on the code as committed.

- **Typecheck:** whole workspace passes, e2e included.
- **Web tests:** **787 of 787** pass across 108 files. New since the first gate:
  - `chaseForecastInclusion.test.tsx`
    - A posted row with its flag off is In Review, with a "Not a planned payment" ×, no Send, and
      `data-sent` true. Clicking the × writes the resolution and never touches the flag.
    - A future row with its flag off shows Send.
    - A matched posted row has no ×.
    - A future row that was sent keeps "Remove from forecast".
    - Bulk Remove flips the flag only on the future row and writes the resolution for the posted one.
  - `forecastPastRowsReconcile.test.ts`: the $300 transfer gap closes.
- **API tests:** **758 of 758** pass across 108 files, on an isolated database, with the Mac held awake
  by `caffeinate`. This includes the past-row tests for both bulk routes.
- **Build and bundle guard:** landing **571.2 KB of 580 KB** (unchanged); no recharts on open.

**Why earlier local runs looked like hangs.** Three runs had Plaid sync tests stall for 875s, 634s and
913s. In each case the Mac was entering macOS "Maintenance Sleep" (`pmset -g log`, 900–1,049s per
cycle), which freezes any test waiting on a real timer.
- One run reported "timed out in 120000ms" after 634s of wall time — the process was suspended, not stuck.
- Kept awake, every affected file passes in under 2s.
- No code hang was involved. Separately, the order dependency in `plaidTransactionsLimit` was real, and
  is fixed in its own commit.

One more intermittent failure, the Reports hub routing test, was CPU contention with a build running in
parallel. It passes alone and in the final run.

## Deviation from the plan

The shared predicate lives in `lib/avalanche-core`, not `lib/api-zod`. The web app never imports
`@workspace/api-zod`, whose index re-exports every generated zod schema. `avalanche-core` is already a
pure dependency of both apps.

## Known and deliberately left for later packages

- **Double count, unmatched dragged bill (PR5).** An unmatched past-due bill still drags onto the next
  business day while its real payment is on the curve.
- **Double count, Weekly Spend (PR8).** The Weekly Spend lump and the real Amex payment are never matched
  to each other.
- **"Today" timezone (PR2).** "Today" is the server's local date; on Render that is UTC, so after 7pm
  Central the date rolls early.
- **Snapshot-day and pending edge cases (PR4).**
