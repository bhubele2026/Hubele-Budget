# Household clock leftovers (PR2 + PR3 follow-up)

Branch `fix/household-clock-leftovers`, on `main` `d73f3bf`. Finishes five
leftovers a survey found after PR2 (one household clock, America/Chicago) and
PR3 (never show missing as $0). Each applies a rule those PRs already set. No
DDL, no new dependency, no spec change, no codegen.

## What changed

1. **`/reports/spending-facts` default range** (`lib/spendingFacts.ts`). With no
   `from`/`to`, the 30-day window now ends on `householdTodayISO()` and starts
   `addDaysISO(today, -30)`. It used to use the UTC date.
2. **`/weekly-settlements` takes only a Sunday** (`routes/weeklySettlements.ts`).
   GET (when `weekStart` is given), PUT and DELETE answer 400
   `weekStart must be a Sunday` unless `weekBounds(weekStart).start === weekStart`.
   That check is pure calendar arithmetic, so it gives the same answer on any
   server timezone. It also refuses a date that does not exist (`2026-02-29`).
   - **Callers checked first:** nothing in `artifacts/h2budget/src`, `e2e` or
     `scripts` calls the route. Only the generated client functions exist.
3. **`/dashboard` month** (`routes/dashboard.ts`). The window is now
   `monthBounds(householdTodayISO())` (`start` … `endExclusive`), no longer the
   server clock's local month.
4. **Reports hub cash-buffer tile** (`pages/reports/reportsShared.tsx`).
   - **Before:** `Number(lowPoint ?? 0) || 0` and the same for `cashBuffer`.
   - **Now:** both go through PR3's `moneyFace`, so a missing figure reads "—"
     and never "$0.00".
   - **Scope:** the buffer is included because it sits in the same sentence
     with the same fallback.
5. **Browser weeks on the household calendar.**
   - `lib/householdDay.ts` now re-exports `weekBounds` and `addDaysISO` from
     `@workspace/avalanche-core/householdTime`.
   - `lib/weeklyStreak.ts`: `todayISO`, `isoDaysAgo` and `currentWeekBounds`
     (Banking) read the household's today and week. The dead
     `weeklyBudgetStreak` is deleted; it had no references and no tests.
   - `lib/timeRange.ts`: `weekSunday` and `currentWeekRange` (the Wk toggle on
     Bills, Transactions, Amex and Reports) use the household week. Labels are
     formatted in UTC from the ISO date, so the browser's timezone cannot shift
     them.
   - `pages/allowances.tsx`: the private `sundayOf` returns the household
     week's Sunday as a local-midnight Date. The page's local-field arithmetic
     is unchanged. All five callers pass "now".

## Figures that move (and only when)

**Server.** Render runs in UTC, so these move only between 7pm and midnight
Central:

| Endpoint | When | Before → after |
|---|---|---|
| `GET /reports/spending-facts` with no `from`/`to` | every evening | Window was tomorrow−30 … tomorrow (UTC). It is now today−30 … today (Central), so tomorrow's future-dated rows drop out and the oldest day comes back. **No screen calls it without a range**: Reports, Spending and the Chase insight strip all pass `from`/`to`. Only a direct API call sees this. |
| `GET /dashboard` `monthlyIncome`, `monthlySpend`, `netCashflow`, `transactionCount`, `paidThisMonth`, top categories | the last evening of a month | These were already next month's (often near $0). They now stay on the month that is still running. The only web consumer, the Reports hub, reads `totalDebt` and `activeDebtCount`, which do not move. |
| `GET/PUT/DELETE /weekly-settlements` with a non-Sunday `weekStart` | always | 200/204 → 400. No consumer. |

**Web.**
- **Browser in Central time:** nothing moves. The browser's local calendar
  already was the household's.
- **Browser elsewhere:** the week changes only in the hours when its local date
  differs from Chicago's. For a UTC browser that is 7pm to midnight Central, so
  on Saturday evening the week no longer jumps to next Sunday early.
- **Surfaces affected:**
  - Banking: this week's weekly bucket and the 90-day fetch bound.
  - Allowances: "This week", the streak chips and the 8-week variance bars.
  - The Wk ranges on Bills, Transactions, Amex and Reports. The Transactions
    page consumes `rangeForMode` and was not edited.

**Reports hub cash-buffer tile.** A missing low point or buffer reads "—"
instead of "$0.00". When they are present the text is identical.

## Must not change (held)

- **What each figure sums.** Only windows moved.
  - `/dashboard` `monthlySpend` still sums every amount < 0. That is a
    financial rule, and PR15 deletes these fields.
  - Allowances still counts exactly the rows it counted before.
- **The spine and its parity.** The spine passes explicit ranges to
  `buildSpendingFacts`, so the new default never reaches it. `spineParity`
  passes in the full API suite.
- **Landing bundle:** 572,526 → 572,554 bytes (+28 B). Cap 580 KB,
  `check-entry-graph` passes, and no landing chunk carries the household
  calendar.
- **No DDL, no dependency, no spec or codegen change.** `openapi.yaml` listed no
  error responses for this path before, and still lists none.

## Residuals (known, not fixed here)

- **Allowances does not apply `isCountableSpend`.** Banking's `bucketSpend` drops
  transfers, card payments, reimbursables and debt payments; Allowances counts
  them if they are flagged. This is a known inconsistency, left alone on
  purpose, and PR15's weekly spending model replaces both.
- **Months are still browser-local in the web.** That covers `timeRange`
  `currentMonthRange`/`currentYearRange` (Banking's month, the Mo/Yr toggles)
  and Allowances' `firstOfMonth`/`lastOfMonth`. The same class of bug, but
  outside this brief, which covers weeks. They only differ for a browser outside
  Central on a month's last evening.
- **`GET /reports/budget-facts` default `monthStart`** (`routes/reports.ts:111`)
  still takes the UTC month. PR2 listed it; it is outside this brief. It only
  differs on a month's last evening when no `monthStart` is passed.
- **Existing non-Sunday settlements.** A settlement row with a non-Sunday key,
  if one was ever written by a direct call, can no longer be read by key or
  reopened through the API. The unfiltered GET still lists it. No data was
  touched.
- **`cashSignal.ts` `weekStartFor`/`weekEndFor`** still build weeks on local
  Date fields. They are fed `householdTodayDate()`, and the file is outside
  this brief.

## Tests

**New: `api-server/src/__tests__/householdClockLeftovers.integration.test.ts`**
- Runs with process TZ=UTC, the clock pinned, through the real routes.
- **Spending facts, Saturday 9/12 8:30pm CDT** (`2026-09-13T01:30Z`): the range
  is `2026-08-13 … 2026-09-12` and realSpend is $37. Old: `08-14 … 09-13`, $70.
- **Dashboard, 9/30 9pm CDT** (`2026-10-01T02:00Z`): `monthlySpend` is $80 over
  3 rows. Old: $25 over 1 row.
- **Weekly settlements:**
  - PUT: a Wednesday → 400, `2026-02-29` → 400, a Sunday → 200.
  - GET: a Wednesday → 400, a closed Sunday is found.
  - DELETE: a Wednesday → 400, a Sunday reopens.

**New: `h2budget/src/lib/householdWeeks.test.ts`**
- The `weekBounds` re-export.
- Saturday evening: `todayISO`/`currentWeekBounds` → 09-12 and 09-06…09-12,
  and `isoDaysAgo(90)` → 06-14.
- `currentWeekRange` → "Sep 6 – 12", and a month-crossing week → "Sep 27 – Oct 3".
- `weekSunday` is a local-midnight Date.
- A midday control.
- `weeklyBudgetStreak` is gone.

**Added to existing tests**
- `allowancesKitRestyle.test.tsx`: on Saturday evening the weekly card counts
  Saturday's $61.25, not Sunday's $88.40.
- `reportsHubKitRestyle.test.tsx`: a missing low point and buffer read
  "Lowest — · buffer —", with no "$0.00". The file never pinned the old
  fallback.

**Adjusted: `commandCenter.test.tsx`**
- `todayISOForWeek()` now uses `householdToday()`, so the fixture sits in the
  week the page shows on any test timezone.

## Verification

**Fails-before.** The new tests, run against `origin/main` code in a detached
worktree:

| Run | Result | Why |
|---|---|---|
| API | 5/5 fail | |
| Web, TZ=UTC | 9/9 fail | |
| Web, TZ=America/Chicago | 3 fail: re-export, dead-code removal, "—" tile | The week tests match main there, because browser-local = household. |

**Gates on this branch**

| Gate | Result |
|---|---|
| `pnpm run typecheck` | green |
| API suite (`CI=true`, isolated DB `h2budget_test_clock2`) | 133 files, 1209 passed + 7 todo |
| `spineParity` + `householdClock` integration, run alone | 2 files, 16 tests passed |
| Web suite, TZ=UTC | 127 files, 1020 tests passed |
| Web suite, TZ=America/Chicago | 127 files, 1020 tests passed |
| `pnpm run build && node scripts/check-entry-graph.mjs` | 572.6 KB of 580 KB, pass |
| Codegen | not needed: spec untouched |

## Work-order points

This finishes Codex [1, 8] (PR2 clock call sites `spendingFacts.ts`,
`dashboard.ts`, `weeklySettlements.ts`, `timeRange.ts`, `weeklyStreak.ts`,
`allowances.tsx`) and [12] (PR3 $0 sweep: `reportsShared.tsx`).
