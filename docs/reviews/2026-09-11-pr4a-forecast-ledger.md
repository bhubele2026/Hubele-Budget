# PR4a — The forecast ledger, extracted, with one set of actual rows

Codex work-order point **1** (cash today, one rule). This is the first part of plan PR4, on top of the PR3 close-out
(live, `d975f93`). Plan: `~/.claude/plans/h2-budget-work-serene-pebble.md`.

The plan asked for the refactor first, in its own PR, with **no number changes**:
- extract `buildForecastLedger()`;
- then, in PR4b, change the rule for which rows count as "already in the snapshot".

This PR is that refactor.

## The problem

- **`computeCashSignal` (849 lines) built the forecast and summed it in one function.** PR4b-PR4d each need to
  change what goes into the ledger, and PR8/PR9 need to read it. None of that can be done safely while the build
  and the arithmetic are interleaved.
- **Two roll-forwards over two queries.** "Bank today" rolled the snapshot through one query. The curve's actual
  rows came from a second query with different filters. They agreed only because, for rows dated through today,
  the two filters happened to select the same rows. A rule change applied to one and not the other would split
  the bank tile from the chart's first point.

## What changed

- **New `lib/forecastLedger.ts` `buildForecastLedger(householdId, ownerUserId, opts)`.**
  - It returns the anchor facts: window, today, snapshot day, start balance and `bankToday`.
  - It also returns every item the curve is made of, sorted by date:
    - `{kind: "actual", date, amount, matched, txnId}`;
    - `{kind: "plan", eventKind, date, originalDate, amount, itemId, label, assumption?}`, where `assumption` is
      `"dragged_past_due"` for a past-due plan moved to the next business day.
  - The build logic moved **verbatim**: expansion, debt minimums, avalanche extra, snapshot account resolution,
    `isBankRow`, resolutions, the #666/#688 snapshot drop and the #681/#751/#803 drag.
  - A line diff against the old `computeCashSignal` body shows only the changes listed here, plus three comments
    reworded where they named the removed variables.
- **One set of actual rows.**
  - **The query.** One query now selects household rows that pass the same inclusion filter as the old curve query
    (`inForecast` with a snapshot, `forecastFlag` without one), dated after the anchor day and up to the **later of
    the window's end and today**. `isBankRow` and the plaid-id check are applied once.
    - `bankToday` = anchor + those rows dated through today (with a snapshot).
    - The curve's actual items = those rows dated through the window's end.
  - **Why the numbers cannot move.**
    - `inForecast` keeps every row dated on or before today, so the old roll's rows were always a subset of the
      old curve's.
    - The upper bound matters: when a window ends before today, `bankToday` still rolls through today. A golden case
      pins exactly this.
- **`computeCashSignal` only walks the ledger.** It builds the starting balance, the daily series, lowest and
  status, and derives the chart's events from the plan items with a negative amount. Its output is unchanged.

## Figures that should move

**None.** This is a refactor. Every figure `computeCashSignal` returns is byte-for-byte what it returned before, and
so is everything built on it: `/forecast/cash-signal`, the spine, Forecast, Banking, Reports and "Why this number?".

## Must not change

- **The full `computeCashSignal` output** for every fixture in `forecastLedger.golden.integration.test.ts`. That
  output was recorded on the unchanged code in this PR's first two commits, before the refactor commit.
- **Every existing API test.** None was edited.
- **No server behaviour change, no schema change, no web change.**

## Tests

- **New `__tests__/forecastLedger.golden.integration.test.ts`** (5), recorded before the refactor. It pins the full
  JSON output, with UUIDs normalised, for:
  - **a full household:**
    - a snapshot on a pointer;
    - rows: anchor-day, posted, pending, other account, manual, `amex`-sourced manual, future flagged, future
      unflagged;
    - plans: matched (with a matched Chase row), rescheduled, skipped, missed, dragged past-due;
    - debt minimum and avalanche extra;
    - a paused item.

    It runs in three windows: the default, a `fromDate` after the anchor, and a window that ends before today.
  - the no-snapshot fallback;
  - a snapshot with no account pointer.
- **Hand checks on the recording.**
  - Full household `bankToday` 2785.00 = 3000 − 20 − 200 + 50 − 30 − 15. The other-account and amex rows are
    excluded, and the anchor-day row is excluded.
  - The past-due Phone bill is dragged from 05-12 to 05-15.
  - The window ending before today still has `bankToday` 2785.00.
  - The no-pointer case: 1475.00 = 1200 − 25 + 300, with the unresolved Plaid row excluded.
- **Order of commits.** The recording is two commits, and the refactor is a third. With the refactor applied, the
  golden file passes untouched.

## Verification

- **Golden:** 5 of 5 pass on the refactored code, compared under `CI=true`. The snapshot file is unchanged since its
  recording commits.
- **Full API suite (local Postgres test database):** **116 files, 835 pass, 8 todo**. That is the previous 830
  plus the five golden cases. No existing test was edited.
- **Workspace typecheck and build:** pass.
- **Web suite:** not re-run. No web code changed.
- **Landing bundle guard:** **572.5 KB of 580**, unchanged.
- **Diff review:** a line diff of the moved body against the old `computeCashSignal` (lines 299-767 at `d975f93`)
  shows only these changes:
  - the unified actual-rows query and loop;
  - the typed plan items replacing `items` and `expenseEvents`;
  - three comments reworded where they named removed variables.

## Found along the way (not changed here)

- **`transactions.plaid_transaction_id` is unique** (`transactions_plaid_txn_uq`). A golden fixture with a
  duplicated id failed to insert. The plaid-id de-duplication in the ledger is therefore defensive only, and
  merging the two roll-forwards' checks cannot change a number.
- **`lowestProjected` starts from a balance that leaves out day 0's own rows.** It starts from `startingBalance`,
  which rolls only the items dated before the window. So it can be lower than every daily point, with
  `lowestDate: null`. The golden's no-pointer case shows it: lowest 1175.00 while `bankToday` and `daily[0]` are
  1475.00.
  - The golden pins today's behaviour, so this PR does not change it.
  - PR9 (the low point) owns it and will list it as a figure that moves.
- **Carried from the PR3 close-out review:** that note's "about 100 bytes" overstates the helper's cost. It is tens
  of bytes, and the guard's +0.1 KB step is mostly rounding (572,458 bytes). PR3's landing growth is therefore
  ~1.1-1.2 KB.

## Left for later PRs

- **PR4b** — `isInSnapshot`, one rule for "already in the snapshot", applied once in the ledger's actual rows.
- **PR4c** — pending superseded by its posted row.
- **PR4d** — Plaid sync fixes:
  - re-mint;
  - `occurredOnUserOverridden`;
  - backfill order around the balance read.
- **Possible PR4e** — the web roll-forward (`accountBalance.ts`) joins the rule; it needs `createdAt` in the API.
