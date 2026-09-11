# Household months (PR2 follow-up) + one more missing-data $0 (PR3)

Branch `fix/household-months`, on `main` `11a6f757` (after
`fix/household-clock-leftovers`). Review follow-up L1–L3. No DDL, no new
dependency, no spec change, no codegen, no CI change.

## Merged with PR6 (`main` `500473e`)

- **How:** `origin/main` was merged in with a merge commit.
- **Conflicts:** none.
- **Overlap:** `pages/reports/CashFlowPage.tsx` is the only file both branches
  touch, and the two changes stay separate:
  - PR6 skips past one-time items in the recurring monthly burn;
  - this branch changes the forecast card.
- **Not touched here:** this branch never edits `routes/dashboard.ts`.
- **Lockfile and generated files:** unchanged, so no codegen.

**Gates after the merge**

| Gate | Result |
|---|---|
| `pnpm run typecheck` | green |
| Web suite, TZ=UTC | 130 files, 1046 tests passed |
| Web suite, TZ=America/Chicago | 130 files, 1046 tests passed |
| Web suite, TZ=America/Los_Angeles | 130 files, 1046 tests passed |
| Build + `check-entry-graph` | 572,627 bytes, 572.6 KB of 580 KB, pass |

The API suite result further down (133 files, 1211 + 7 todo) is from before the
merge.

## L1 — week and month on one calendar

The last PR put the browser's WEEK on the household calendar (America/Chicago)
but left the MONTH on the browser's own. A browser outside Central could pair
the two wrongly. Take a UTC browser at 9pm Central on Wed 9/30:

| What | Value there |
|---|---|
| Week | the household's 9/27–10/3 |
| 90-day fetch | ends 09-30 |
| Spine month | September |
| "This month" | already October, with no October days fetched |

**Changed**

- **`lib/householdDay.ts`:** new `localDateOf(iso)`, which gives a browser-local
  midnight Date for a household day, for pages that do period arithmetic on
  local Date fields.
- **`lib/timeRange.ts`:**
  - `currentMonthRange` is `monthBounds(householdToday(ref))`.
  - `currentYearRange` is the household today's year.
  - Labels are formatted in UTC from the ISO day, so the browser's timezone
    cannot shift them.
  - Consumers: the Mo/Yr toggles on Bills, Transactions, Amex and Reports, and
    Banking's month label.
- **`pages/command-center.tsx` (Banking):** these now read one
  `monthStartISO = monthBounds(householdToday(now)).start`:
  - the month card (`monthView`, including paging back and forth by month);
  - the unplanned tile (`unplannedView`);
  - the month's biggest one-off charges (`chargeRows`, which had its own
    local `ym`);
  - `monthRange`.

  The memo dependencies gain `monthStartISO`, so a page left open across a
  month boundary recomputes.
- **`pages/allowances.tsx`:** the current month (the initial `monthStart` and
  `currentMonthStart`) comes from `householdFirstOfMonth(now)`, the month twin
  of PR2's `sundayOf`. `firstOfMonth` and `lastOfMonth` stay for Dates already
  on the page's local calendar (a selected month).
- **`GET /reports/budget-facts` default `monthStart`** (`routes/reports.ts`) is
  `monthBounds(householdTodayISO()).start`, no longer the UTC month. The dead
  `isoDate` helper went with it.

**What is summed is unchanged everywhere.** Only which month is "current"
moved.

## L2 — Cash flow forecast card never draws from a missing $0

- **Where:** `pages/reports/CashFlowPage.tsx`.
- **Before:** `Number(forecast.settings?.startingBalance ?? 0) || 0`.
- **Now:** a missing, blank or non-numeric starting balance draws no
  projection. The card stays and shows the kit's empty state (`ChartCard`
  `empty` → `emptyNote`) reading "No starting balance set on Forecast".
  - A real `"0"` is a balance and still draws.
  - An empty event list still hides the card, as before.
- The card gained `testId="cashflow-forecast-card"`.
- `reportsBalances.ts:178-179` was checked in review and is safe.

## Figures that move (and only when)

**Server:** `GET /reports/budget-facts` with no `monthStart` moves only on a
month's last evening, 7pm to midnight Central (Render runs in UTC). It was
already next month; it now stays on the running month.

**Web:** nothing moves for a browser in Central time. For a browser elsewhere,
the month and year change only in the hours when its local date is in a
different month or year than Chicago's:

| Browser | When it moves | Before → after |
|---|---|---|
| UTC (ahead) | a month's last evening, 7pm–midnight Central | "this month" jumped to next month early → stays on the household's month |
| Pacific (behind) | the first two hours of a month, Central | still showed last month → the household's month |

Surfaces affected:
- Banking: month card, unplanned tile, biggest charges, month label.
- Allowances: monthly and unplanned cards, "This month".
- The Mo/Yr ranges on Bills, Transactions, Amex and Reports.

**Cash flow forecast card:** only when the starting balance is missing. It was
a curve from $0; now it is the empty state.

## Must not change (held)

- **What any figure sums.** Windows only, and the one card's missing-data face.
- **The spine and its parity.** `spineParity` passes in the full API suite.
- **Landing bundle:** 572,554 → 572,627 bytes (+73 B). Cap 580 KB,
  `check-entry-graph` passes.
- **No DDL, no dependency, no spec or codegen change.** `ci.yml` is untouched.

## Residuals (known, not fixed here)

- **Variance bars read unfetched weeks (backlog; found by reading, not
  reproduced).** Allowances' 8-week variance bars (`weeklyVarianceSeries`,
  rendered at `varianceRows`) walk back 8 completed weeks. The page only
  fetches the selected week plus the selected month (`fetchFrom`/`fetchTo`,
  ~826-835). A week outside that window sums $0 spend and shows the whole
  allowance as "left". The streak chips are protected by their `any` check;
  the bars are not. PR15 moves Allowances to `/spending/week`.
- **Allowances still does not apply `isCountableSpend`** (from the previous
  note). PR15 replaces it.
- **CI enforces UTC only.** It runs the web tests with no `TZ`
  (`ci.yml:66-67`, `pnpm --filter ./artifacts/h2budget run test` on
  ubuntu-latest), so it proves UTC only. The Chicago and Los Angeles runs below
  were local. CI was not changed.
- **Two e2e specs (nit, left alone).** `transactions-chase-account-stale.spec.ts:54-56`
  and `transactions-chase-account-picker.spec.ts:53-54` seed "today" as the UTC
  date. PR14 is rewriting both specs.
- **`cashSignal.ts` `weekStartFor`/`weekEndFor`** still build weeks on local Date
  fields, fed `householdTodayDate()`. The file is outside this brief.

## Tests

**New: `h2budget/src/lib/householdMonths.test.ts`**
- **Month and year:**
  - 9/30 9pm Central → September 2026. Under UTC it was October.
  - A Pacific browser at 10:30pm on 9/30 → the household's October. Under
    Pacific it was September.
  - New Year's Eve 8pm Central → 2026 and December.
- **Behind Chicago:** `2026-09-13T05:30Z` is Saturday 10:30pm Pacific. Today is
  09-13, the week is 09-13…09-19 ("Sep 13 – 19"), and `weekSunday` is 9/13 at
  local midnight.
- **DST:** each instant checks today, the week bounds, the Wk range,
  `weekSunday` at local midnight, and the month start.

  | Instant (UTC) | Central time |
  |---|---|
  | 3/8 05:30 | Sat 3/7 11:30pm CST |
  | 3/8 08:30 | Sun 3/8 3:30am CDT |
  | 3/15 04:30 | Sat 3/14 11:30pm CDT |
  | 11/1 04:30 | Sat 10/31 11:30pm CDT |
  | 11/1 06:30 | Sun 11/1 1:30am CDT |
  | 11/1 07:30 | Sun 11/1 1:30am CST, the repeated hour |
  | 11/8 05:30 | Sat 11/7 11:30pm CST |
- `localDateOf`.

**New: `h2budget/src/pages/reports/cashFlowForecastMissing.test.tsx`**
- A missing starting balance shows the empty state.
- A blank starting balance is treated as missing.
- A real `"0"` still draws.

**Added: `commandCenter.test.tsx` (Banking)**
- UTC browser at 9/30 9pm Central: the month card is September ($90, not $55)
  and unplanned has $175.
- Pacific browser at 10/1 12:30am Central: October ($55) and no September
  unplanned.

**Added: `allowancesKitRestyle.test.tsx`**
- **Month cards, the same two edges:**
  - UTC at 9/30 9pm Central: monthly is $42.15 (September) and unplanned
    $23.45.
  - Pacific at 10/1 12:30am Central: monthly is $17.35 (October).
- **Streaks and variance bars on household weeks:**
  - UTC, Sat 9/12 8:30pm Central: the streak is 2, and the bars run Jul 12 …
    Aug 30.
  - Pacific, Sun 9/13 12:30am Central: the streak is 3, and the bars run
    Jul 19 … Sep 6.

**Added: `householdClockLeftovers.integration.test.ts`**
- `/reports/budget-facts` with no `monthStart` at 9/30 9pm Central →
  `2026-09-01`.
- A control: an explicit `monthStart=2026-08-15` → `2026-08-01`.

## Verification

**Fails-before.** The new and changed tests were copied into a detached
`origin/main` worktree and run there:

| Run | Fails | Which |
|---|---|---|
| API | 1 of 7 | budget-facts default |
| Web, TZ=UTC | 8 | month; New Year's Eve; the 10/31 DST month check; `localDateOf`; CashFlow missing ×2; Banking UTC month; Allowances UTC month |
| Web, TZ=America/Chicago | 3 | `localDateOf`; CashFlow missing ×2. The calendar tests match main in Central. |
| Web, TZ=America/Los_Angeles | 7 | Pacific month; the 11/1 1:30am DST month check; `localDateOf`; CashFlow missing ×2; Banking Pacific month; Allowances Pacific month |

**Guards** (pass before and after):
- the Pacific week, and the week half of each DST case;
- the Allowances streak and variance-bar week windows (PR2 already put weeks on
  the household calendar);
- CashFlow's real 0;
- the explicit `monthStart` control.

**Gates on this branch**

| Gate | Result |
|---|---|
| `pnpm run typecheck` | green |
| API suite (`CI=true`, isolated DB `h2budget_test_months`) | 133 files, 1211 passed + 7 todo |
| Web suite, TZ=UTC | 129 files, 1041 tests passed |
| Web suite, TZ=America/Chicago | 129 files, 1041 tests passed |
| Web suite, TZ=America/Los_Angeles | 129 files, 1041 tests passed |
| `pnpm run build && node scripts/check-entry-graph.mjs` | 572.6 KB of 580 KB, pass |
| Codegen | not needed: spec untouched |

## Review of the merged head (`75e0b4d`): APPROVE, with two corrections

- **The CashFlow empty state is defensive only.** `forecast_settings.starting_balance` is `NOT NULL DEFAULT '0'`,
  the route always creates a settings row, and the spec marks `startingBalance` required, so "No starting balance set
  on Forecast" never shows on real data. A balance nobody set is `"0"`, and the card still draws from $0. Nothing
  moves on real data from this change.
- **Older issue, not changed here (pending Brad's decision):** the CashFlow forecast card starts its curve from
  `settings.startingBalance` and ignores the `bankSnapshot` in the same response, while the Forecast page starts from
  the snapshot when there is one (`forecast.tsx:690-693`). For a household with a linked bank the card's curve does
  not start at the bank balance. Starting it where Forecast starts changes a money figure on screen.
- **Fixed in review:** Banking's biggest one-off charges memo now also depends on `monthStartISO`, as this note already
  said, so the list follows the household month without waiting for the next day's fetch.
- **Note on tests:** the Allowances streak and variance tests mock `useListTransactions` to return every row, so they
  do not cover the unfetched-weeks backlog bug listed under Residuals.
- **Reviewer's gates on the merged tree:** typecheck green; API 136 files, 1270 pass, 7 todo; web 130 files, 1046
  pass (UTC and Los Angeles); build and guard 572.6 KB.
