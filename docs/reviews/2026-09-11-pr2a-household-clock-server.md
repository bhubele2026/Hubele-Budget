# PR2a — One household clock, server side

Codex work-order points **1** (every screen agrees on cash today, including the snapshot day) and **8**
(one household week boundary and timezone everywhere). Plan: `~/.claude/plans/h2-budget-work-serene-pebble.md`.

The browser half, **PR2b**, follows separately so each change stays reviewable.

## The problem

The household lives in Central time, and Render runs in UTC. Between **7pm and midnight Central** the
server's clock is already on tomorrow. Every server figure built from it drifted that evening:

- **Weekly spending:** "spent this week" rolled into next week at 7pm every Saturday.
- **Bank snapshot:** a snapshot taken after 7pm was dated tomorrow. The next day's charges were left
  out of the bank balance until the following sync.
- **Review badge:** moved to next month on the last evening of every month.
- **Bills:** the next bill, the due count, and archiving a one-time bill all ran a day early. A
  one-time bill was archived on the evening of its own due date.
- **Debt history:** balance changes were recorded on tomorrow's date.
- **Avalanche:** the managed budget line and month 1 of the payoff simulation jumped to next month on
  the last evening of a month.
- **Reports:** Budget pace and Habits "today" were off by a day.
- **Guards:** the week-close guard, the move-bill date window, the bank-balance explanation, and the
  post-sync drift check used a different day from the roll-forward.

## What changed

- **Shared calendar:** `lib/avalanche-core/src/householdTime.ts`, committed first as its own change.
  - `householdDateOf(instant)` and `householdToday()` use Intl with `timeZone: "America/Chicago"`. No
    dependency; the formatter is built lazily.
  - `addDaysISO`, `dayOfWeekISO`, `weekBounds` (Sun–Sat) and `monthBounds` are pure date-string
    arithmetic.
- **Server wrapper:** `artifacts/api-server/src/lib/householdClock.ts`. It offers the same date in two
  shapes:
  - `householdTodayISO()`, a date string.
  - `householdTodayDate()`, a server-local-midnight Date. The existing local-field arithmetic in
    `cashSignal` and friends stays correct on any server timezone.
  - Also `householdDayOf(instant)` and `householdMonthStartDate()`.
- **The one trap, documented in the module:** a local-midnight Date must never go back through the
  instant functions. Every call site was audited, and each passes a real instant or no argument.
- **Call sites.** Each now gets its date from the household calendar; the arithmetic itself is unchanged.
  - **Forecast and bank balance:**
    - `cashSignal.ts`: today, and the snapshot day.
    - `forecast.ts`: bundle `today`, register window, move-bill window.
    - `forecastInclusion.ts`: `forecastTodayISO`.
    - `bankBalanceExplain.ts`: snapshot day and today.
    - `plaidSync.ts`: the post-sync drift check's days.
  - **Review badge and spine:**
    - `reviewCount.ts`: today and month.
    - `billsSummary.ts`: `todayDate`, which feeds the spine, next bill, due count and one-time archiving.
  - **Weekly Amex payoff:** `amexAnchor.ts`, "last completed week".
  - **Reports and guards:**
    - `budgetFacts.ts` and `behaviorFacts.ts`: today.
    - `weeklySettlements.ts`: the future-week guard.
  - **Debts and Avalanche:**
    - `debts.ts`: the balance-history date.
    - `avalanche.ts`: current month.
    - `avalancheSim.ts`: month 1 of both simulations.

## Figures that should move

Only between **7pm and midnight Central** (6pm to midnight in winter), and only on the live server.
From midnight to 7pm Central the UTC date and the Central date are the same, and a Central laptop
already matched.

| Where | Evening behaviour now |
|---|---|
| Bank today, the forecast's day-0 figure, Home and Forecast | After an evening snapshot, the next day's charges count straight away |
| Spent this week (spine, Home) | Stays on the current Sunday–Saturday week on Saturday evening |
| Review badge (nav, landing bell) | Counts the current month on its last evening |
| Next bill, bills due (Home) | Tonight's bill is still today's |
| One-time bills | Archived after midnight Central, not at 7pm on their due date |
| Debt balance history | Recorded on the Central date |
| Avalanche slider headroom, payoff months | Current month until midnight on its last evening |
| Reports → Budget pace, Habits | Central today |

No stored data is rewritten. The changes only affect what gets computed or written from now on.

## Must not change

- Every daytime figure.
- The bank-today anchor (`available ?? current`), rolled forward exactly as before.
- One Review flow, no Plaid calls, auto-match off.
- Web code (PR2b).

## Tests

- **`householdTime.test.ts`** (core): 14 tests, each case run with the process in UTC and in Chicago.
  - Saturday 8:30pm Central, and midnight Sunday.
  - The last evening of a month, and an evening snapshot.
  - Both daylight-saving changes, and leap February.
- **`householdClock.test.ts`** (server wrapper): the local-midnight Date, the snapshot day and the month
  start, under both timezones.
- **`householdClock.integration.test.ts`**: the process runs in UTC, as Render does, with the clock
  pinned inside the evening window. Each comment records the old code's figure.

  | Moment (Central) | Checks | Old UTC code |
  |---|---|---|
  | Sat 8:30pm | Bank balance **$920.00** — $1,000 snapshot at 9:30pm Thursday, then Friday −$50 and Saturday −$30 | $930.00 |
  | Sat 8:30pm | Spent this week **$100** (Sep 6–12) | $40 |
  | Sat 8:30pm | Review bundle `today` **2026-09-12** | 2026-09-13 |
  | Wed 9/30 9pm | Review badge **5** (September's rows) | 0 |

- **Tests that built "today" from the machine clock** now use the household calendar. Otherwise they
  would disagree with the server whenever CI runs in UTC after 7pm Central.
  - `spineParity`: TODAY.
  - `billsDebtMin`: month.

## Verification

- **API typecheck:** passes.
- **Workspace typecheck:** passes, web app included.
- **Targeted API run:** 9 files, 113 pass plus 8 pending (the household scenario's contract columns).
  Covers the calendar and clock tests, the evening test, spine parity, bills, the household scenario,
  past rows, the badge, and cash signal.
- **Full API suite:** **112 files, 792 pass plus 8 pending**, on an isolated database with the Mac held
  awake. That is 3 files and 24 tests more than PR1: 14 calendar, 6 clock, and 4 evening tests.
- **Web tests and build:** no web code changed, so CI runs them. The landing bundle was already
  checked with the shared calendar in place: 571.2 KB of 580.

## Independent review before commit, and what was done

A separate reviewer read the diff before commit. It found **no instance of the local-midnight trap** in
server code, and no pair of server figures that can now disagree. Every `debtMinSchedule` caller,
`/bills/summary`, the simulator, the snapshot day and debt history were all checked.

1. **MEDIUM — fixed.** Two more `billsDebtMin` tests built the month from the machine clock:
   - "sums multiple matched txns" and the Avalanche-extra row.
   - `/bills/summary` now reads the Chicago month, so on UTC CI both would fail on the evening of every
     1st. For example, 2026-10-01T01:30Z would give an actual of $0.00 instead of $140.00, and a
     next-occurrence date ending in -30 instead of -31.
   - Both now use `monthBounds(householdTodayISO())`.
2. **LOW — fixed.** `spineParity` stored a local-midnight Date as the bank snapshot instant.
   - On UTC CI that is 7pm the previous evening in Chicago, so the snapshot day depended on the machine.
   - It now stores noon Central on the 1st.
3. **LOW — fixed.** Restoring `TZ` wrote the literal string `"undefined"`. The three new test files now
   delete the variable when it was unset.
   - The reviewer also confirmed Vitest 4 runs each file in its own process here, so `TZ` could not leak
     into another file.
   - The `singleFork` line in `vitest.config.ts` and the matching `CLAUDE.md` note are therefore stale.
     They are not changed in this PR.
4. **LOW — deferred.** `debtMinSchedule.ts` "paid off this month" compares an instant with a
   local-midnight month start. On the last evening of a month, a debt zeroed after 7pm Central can show a
   $0.00 "stops at payoff" row in the next month too. Display only; listed below.

**Re-verified after the fixes:**
- API typecheck passes.
- Spine parity, clock and calendar tests: 4 files, 35 pass.
- Full API suite: 112 files, 792 pass plus 8 pending, on the isolated database with the Mac held awake.

## Deviation from the plan

The plan put the helper in `lib/api-zod`. It lives in `lib/avalanche-core` instead: the web app never
imports `api-zod`, and PR2b needs the same calendar in the browser. It also adds nothing to the landing
bundle — still 571.2 KB of 580.

## Left for PR2b (web)

- **UTC dates in the browser:**
  - The "Today" badge on Chase and Amex.
  - The Add Transaction default date.
  - The debt-payment dialog default date.
  - The Budget "on pace" strip.
  - Post-link month links.
- **The web's own snapshot-day calculations:**
  - Forecast register.
  - Reconcile.
  - Chase and Amex ending balances.
  - Account balance.

## Deliberately not in PR2

These are noted so they don't get lost:
- **Pending debt payments** net against an end-of-day cutoff in UTC (`debtPending.ts`, 6:59pm Central).
- **Several pages memoise "today"** and never roll over past midnight (Allowances, Forecast, Chase,
  Reports). Amex is the only page with a midnight refresh.
- **Workbook import** seeds its month from the server clock.
- **Gap-backfill end date** stays UTC. It is always on or after Central, so the fetch is a safe superset.
- **Unused defaults** in `spendingFacts`, `reports`, `dashboard`: every caller passes its own window.
- **Plaid** expiration emails and the first-sync import ceiling use UTC.
