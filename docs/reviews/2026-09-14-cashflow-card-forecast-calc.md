# Reports → Cash flow: the forecast-balance card shares the Forecast page's cash signal (owner decision 16)

- **Base:** `main` = `df5d8b0b`.
- **Branch:** `fix/cashflow-card-forecast-calc`.
- **Scope (round 1):** `artifacts/h2budget/src/pages/reports/CashFlowPage.tsx` and its test. No API, spec, DDL or
  dependency change; every other chart/total on the page is untouched.
- **Scope (round 2):** adds `CashSignal.account` to the spec and server, a key fix on the Forecast page, a ChartCard
  banner slot and the PlanDropRow caption. Still no DDL or dependency change. See [Round 2](#round-2).

| Commit | What it does |
|---|---|
| `482b6f81` | The forecast card reads `GET /forecast/cash-signal` instead of rolling `settings.startingBalance` forward itself; title/help name the bank-snapshot scope; loading/failed/refresh-failed states via `dataState`/`RefreshBanner`/`Skeleton`; tests. |
| docs commit | This note. |

## Owner decision 16

> The cash flow forecast card should share the Forecast page's starting balance: same account scope, same balance
> anchor, same treatment of pending activity, same daily calculation. Its title must state whether it shows one
> checking account or household cash. If the card and the Forecast page disagree for the same date and scope, treat
> that as a correctness defect.

## The problem

`CashFlowPage.tsx`'s "Forecast balance · next 90 days" card computed its own 90-day balance curve:
`settings.startingBalance` plus a client-side cumulative sum of `GET /forecast`'s raw `events[]`. That is a
**different number** from the one the Forecast page and the spine show for the same day, because it skips everything
`computeCashSignal` (the Forecast page's own source) accounts for:

- the **bank snapshot** (an actual balance read from Plaid or set manually) — the card used the settings row instead,
  which can be stale or simply unset even when a snapshot exists;
- **resolutions** (matched / partial / missed / skipped occurrences) and the **evidence-tier matches** (PR-B, owner
  decision 13) that take a bill off the curve before it's due;
- the **snapshot-anchored roll-forward rules** (past-due drag onto today+1, the "no starting balance ⇒ no
  projection" guard, etc.).

Its title and help text ("Projected checking balance from the forecast's starting balance and its scheduled events.")
never named which account or scope it meant, and a missing snapshot fell back to `settings.startingBalance`, which
CLAUDE.md's PR3 note already flagged as capable of reading a real `0` two different ways.

## What changed

### The card's series is now the cash signal's `daily[]`, verbatim

- `CashFlowPage` calls `useGetForecastCashSignal({ horizonDays: CASHFLOW_FORECAST_HORIZON_DAYS })` (90, no
  `fromDate`).
  - ⚠️ **Correction (round 2, M1):** round 1 said this matched the Forecast page's own 90-day tab. It didn't. That
    page opens on 30 days and always sent `fromDate`, so even its 90-day tab cached under a different key. The key
    this card uses is the one Forecast Overview and the nav/landing prefetch use. Round 2 makes the Forecast page use
    it too.
  - This is the **same endpoint, same function
  (`computeCashSignal`)** the Forecast page and the spine already read — same account scope
  (`checkingAccountExternalId` resolution), same balance anchor (the bank snapshot, rolled forward), same pending-
  activity treatment (resolutions + matches), same daily calculation.
- `cashFlowForecastSeries(daily)` (exported, pure) maps `{date, balance: string}` → `{date, balance: number}` and
  drops any non-finite balance. No arithmetic, no roll-forward — the array is the signal's own `daily[]`.
- `forecastHasData` requires `cashSignal.status !== "no_data"`, matching the Forecast page's own "no_data still
  carries balances rolled forward from an implicit $0" warning: those are never drawn as a real projection.
- `useGetForecast({ days: 90 })` is kept, but now **only** for `bankSnapshot.name`/`.mask` (the title's source of
  truth) — never for a balance figure. `settings.startingBalance` is not read anywhere in the file (see Tests).
  **Round 2 (L1, L2):** removed. The title reads `cashSignal.account` instead.

### Title and help name the scope

> **Superseded in round 2 (L1).** The title below came from the `/forecast` bundle's `bankSnapshot`, while the figures
> came from `resolveSnapshotAccount`, so the two could name different accounts. See [Round 2](#round-2).

- `cashFlowCardTitle(bankSnapshot, horizonDays)` (exported, pure):
  - a real snapshot → `"<name> ••<mask> checking · next <N> days"`, e.g. `"Chase ••1234 checking · next 90 days"`
    (the word "checking" is added only when the account's own name doesn't already say it, so a name like
    `"Chase Total Checking"` doesn't double up);
  - `bankSnapshot === null` (the bundle loaded and there has never been a snapshot) → `"Checking (no bank balance
    set)"` — never a figure built from `settings.startingBalance`;
  - `bankSnapshot === undefined` (the bundle hasn't answered yet) → a neutral `"Checking · next 90 days"`, so the
    card never claims "no bank balance set" a beat before the real answer arrives.
- This app's forecast is always scoped to **one** Plaid checking account (`checkingAccountExternalId`) — there is no
  multi-account "household cash" aggregate to choose between — so the title always names that one account, per the
  decision's "must state whether it shows one checking account or household cash."
- Help text: "The same account, balance anchor and daily calculation the Forecast page uses — bank balance rolled
  forward through every planned bill and income event."

### Loading / failed / no-data states (`components/data-state.tsx` patterns)

`dataState(cashSignalQuery)` drives the card body:
- **cold** (no data yet) → `<Skeleton>`, no numbers rendered.
- **failed** (no data, request errored) → `<RefreshBanner state="failed" .../>` with a Retry button, no chart, no
  numbers.
- **refresh-failed** (stale data on screen, a later refetch failed) → the last-good chart stays up, with
  `<RefreshBanner state="refresh-failed" .../>` above it and its age/Retry.
- **loaded/refreshing with no real data** (`!forecastHasData`) → the kit's plain empty text, "Set a bank balance on
  Forecast to draw this chart" — never `$0`.
- **loaded/refreshing with data** → the chart, unchanged visual chrome (same gradient, colours, axes).

None of these paths render a dollar amount unless `forecastHasData` is true, so a cold/failed/empty state can never
print `$0.00`.

## Figures that move

- **The forecast-balance card's curve** moves whenever a household has a bank snapshot that differs from
  `settings.startingBalance`, or has any resolutions/matches that already took a bill off the curve, or has a
  `no_data` cash signal (previously: silently drew a $0-based curve if `settings.startingBalance` happened to be
  unset while `forecast.events` was non-empty — that path is gone). Concretely: **before**, the card's first point was
  `Number(settings.startingBalance)`; **after**, the card's first point is `cashSignal.daily[0].balance`, i.e. the
  same bank-anchored figure the Forecast page's own chart opens on for the same day. They can only disagree now if the
  underlying `computeCashSignal` call itself disagrees with itself across the two pages' calls, which decision 16
  treats as a defect to fix at the source, not to work around per-card.
- **The card's title** always changes (it used to be a static string, `"Forecast balance · next 90 days"`).

## Must not change

- Every other chart and stat on `CashFlowPage` — Savings rate / Income / Expense / Net tiles, "Income vs expense",
  "Net cash flow", "Locked-in monthly burn", "Money flow this month", "Rolling 30-day burn rate" — is untouched. None
  of them reads `forecast` or the cash signal.
- No spine field, no API route, no OpenAPI spec, no DB schema.
- The landing bundle's budget (580 KB) — `CashFlowPage` is lazy-loaded already; unaffected either way.

## Tests (`cashFlowForecastMissing.test.tsx`, kept — content rewritten for the new behaviour)

- **`cashFlowForecastSeries` (pure, 2 tests):** first/last points equal `daily[0]`/`daily[90]` exactly; `undefined`/
  `null` → `[]`.
- **`cashFlowCardTitle` (pure, 4 tests):** names account + mask; doesn't double "checking"; `null` → "no bank balance
  set"; `undefined` → neutral placeholder.
- **Rendered page (5 tests):** title contains the account name + mask; "no bank balance set" with no snapshot and no
  `$0` anywhere in the card; no `$0` while cold; a retry banner and no `$0` when the first load fails; the last-good
  curve + refresh banner survive a later refetch failure.
- **Source scan (1 test):** the file's code (comments stripped) never matches `/startingBalance/` — comments may still
  explain, in prose, why the field isn't read.
- **Failing before (recorded by stashing the source change and running the new test file against the pre-change
  `CashFlowPage.tsx`):** **12 of 12 new/rewritten tests fail** — the two pure-function tests `TypeError`
  (`cashFlowForecastSeries`/`cashFlowCardTitle` don't exist yet), the five rendered-page tests either see the old
  static title/copy or find no `[data-testid="cashflow-forecast-loading"|"cashflow-forecast-refresh-banner"]` element
  (the old card had neither state), and the source-scan test finds `startingBalance` in the live code path. After the
  source change: **12 of 12 pass.**

## Verification

- **Typecheck:** `pnpm run typecheck` — clean (workspace + libs + `typecheck:e2e`).
- **Web tests, `TZ=UTC CI=true pnpm --filter h2budget exec vitest run`:** **139 files, 1157 pass, 3 skipped.** One
  unrelated flake on the first full run (`chaseReviewInbox.test.tsx`, a 5s timeout on a bulk-update test, under load
  from the full parallel run) passed cleanly both in isolation and on a clean re-run of the full suite — not touched
  by this change.
- **Web tests, `TZ=America/Chicago CI=true pnpm --filter h2budget exec vitest run`:** **139 files, 1158 pass, 2
  skipped.**
- **Build:** `pnpm run build` exit 0.
- **Entry-graph guard:** `node scripts/check-entry-graph.mjs` — landing **574.4 KB of 580 KB**, no recharts on the open
  path, react-dom confined to `vendor-react-*`. (Unchanged in practice: `CashFlowPage` was already lazy.)
- **API suite:** not touched, not run — no API/spec/DDL change.
- **Codegen:** not touched, not run — no OpenAPI spec change.

## Residuals

- **`ProjectedBalanceChart` (the Forecast page's own chart) is the reference implementation this card now mirrors,
  not a shared component.** The two draw from the same `daily[]` data but are two chart components; a future visual
  change to one won't automatically reach the other. Sharing the actual chart component was out of scope for a
  calculation fix and would touch layout/annotations (big-bill markers, past-due tooltip) this card doesn't have.
- **No other `CashFlowPage` chart reads `settings.startingBalance` or any other balance figure** — the audit found
  only the one card doing so before this change, so there is nothing else to list here per the build note's "if
  another one also uses `startingBalance`" instruction.
- *(Round 2: moot. L2 removed this query.)* **The forecast bundle query (`useGetForecast({ days: 90 })`) has no
  dedicated failed-state UI** — it is kept solely
  for `bankSnapshot.name`/`.mask`, and a failed load there simply falls back to the neutral "Checking" title text
  rather than surfacing its own retry banner. The cash-signal query (the actual balance source) has the full
  loading/failed/refresh-failed treatment the decision cares about.

## Round 2

- **Review:** REQUEST CHANGES, no HIGH (2 MEDIUM, 3 LOW, 5 NITs), plus one queued caption fix.
- **Base:** `6b77017` merged with `origin/main` `2731077b`, then with `origin/main` `2e1949f3`. The gates below ran on
  the final merge, `dd9c9ae5`.
- **Names and amounts** in the new tests and in this section are synthetic.

| Commit | What it does |
|---|---|
| `c5cbde89` | Merge `origin/main` (`2731077b`). No conflicts. |
| `ff5d9165` | Round 2: every finding below, with its tests, spec and codegen output, and the golden snapshots. |
| `dd9c9ae5` | Merge `origin/main` (`2e1949f3`, which removes the seed-bills tool). No overlap with this PR. |
| docs commit | This section, plus in-place corrections to round 1 above. |

### M1: one cache entry for one day's balance

**Finding.** The card asked for `{ horizonDays: 90 }`. The Forecast page asked for `{ horizonDays: <tab, default 30>,
fromDate: <browser today> }`, so even its 90-day tab cached under a different key. After a webhook bank sync, the two
entries could each stay fresh for 5 minutes with different balances for the same day. Round 1's comment and note
wrongly said the keys matched.

**What changed.**
- `forecast.tsx`: with look-back closed, the request is `{ horizonDays }` only. With look-back open it is still
  `{ horizonDays, fromDate }`.
  - Without a date, the server uses the household day (`householdTodayDate`).
  - The 90-day tab therefore shares `{ horizonDays: 90 }` with Forecast Overview, the nav/landing prefetch and this
    card.
  - A browser outside Chicago no longer asks for its own calendar day.
- The hero's "Bank before <date>" label reads the response's own `fromDate`, falling back to the picker. It names the
  day its figure was computed for, which the browser's date might not be once the request carries no date.
- Corrected the `CashFlowPage.tsx` comment, and round 1's claim in this note (marked in place).

**Proof.** `forecastCashSignalKey.test.tsx` is new and has 5 tests:
- 90-day tab, look-back closed: exactly `{ horizonDays: 90 }` (`toStrictEqual`, so a `fromDate: undefined` key would
  also fail).
- Default 30-day tab: `{ horizonDays: 30 }`.
- Look-back open: `{ horizonDays: 90, fromDate: "2026-05-01" }`.
- Closing look-back returns to `{ horizonDays: 90 }`.
- "Bank before" names the response's `fromDate`.

Against `6b77017`'s `forecast.tsx`, **4 of 5 fail**. The look-back-open test passes there on purpose: it guards that
an open look-back still sends its date. The card's side of the key is pinned under M2.

### M2: tests pin the no_data gate, the request params and the chart

**Finding.** Removing the no_data gate, or requesting horizon 30, left all 12 round-1 tests green. The no_data test used
`daily: []`, and the "draws the curve" test only checked the title.

**What changed** (`cashFlowForecastMissing.test.tsx`):
- The mock records every params object, and the test asserts each one is `toStrictEqual({ horizonDays: 90 })`.
- `noDataSignal()` carries a full 91-point `daily` rolled forward from $0, as the server really sends. The test asserts
  the empty text, no chart (no `.recharts-responsive-container`) and no dollar figure.
- The ready case asserts the chart is drawn and the empty text is absent.

**Proof.** These three guard behaviour `6b77017` already had right, so they **pass on `6b77017`**. The reviewer's point
was that nothing pinned it. Each one was proven by mutating the final code and re-running the file:

| Mutation of the final code | Tests that fail |
|---|---|
| Remove `&& cashSignal?.status !== "no_data"` | the no_data 91-point test; the no_data + refresh-failed banner test |
| Request `{ horizonDays: 30 }` | the params test |
| Add `fromDate: householdToday(new Date())` | the params test |
| Never draw the chart | the ready-case test; the L3 banner-outside-the-box test |

### L1: the title and the figures name one account

**Finding.** The title came from the `/forecast` bundle's `bankSnapshot`, while the figures came from
`resolveSnapshotAccount`. They could name different accounts:
- a manual snapshot with no pointer or mask;
- `unresolved`;
- " checking" added to a savings account.

**What changed.**
- `resolveSnapshotAccount` also returns the resolved row's own `name`, `mask` and `subtype`, all null when unresolved.
  - The resolution order is unchanged.
  - The change is additive: every caller reads its fields one by one, and none serialises the whole result.
- `buildForecastLedger` keeps that resolution on the ledger (`snapshotAccount`). `computeCashSignal` returns it as
  `account: { name, mask, subtype, via }`.
- OpenAPI adds the `CashSignalAccount` schema and makes `CashSignal.account` required.
  - `computeCashSignal` always fills it, and no code zod-parses a CashSignal.
  - The codegen output is committed, including the new `CashSignalAccount` and `CashSignalAccountVia`.
- `cashFlowCardTitle(cashSignal, 90)` reads `cashSignal.account`:
  - **Resolved:** `Forecast · Test Bank ••0001 checking · next 90 days`. The kind word is the account's own subtype,
    added only when the name doesn't already contain it, and left off when the subtype is null. A savings account reads
    `Forecast · Test Bank ••0002 savings · next 90 days`.
  - **`via: "unresolved"`:** `Forecast · bank account not identified · next 90 days`. It names no account, because no
    account's rows moved the balance.
  - **`no_data`:** `Forecast · no bank balance set · next 90 days`.
  - **No signal yet:** `Forecast balance · next 90 days`.

**Proof.**
- `cashSignal.integration.test.ts` gains 4 tests:
  - **Pointer:** names the row, not a stale label stored on the snapshot.
  - **Manual snapshot with no pointer or mask:** resolves as `sole checking`. That account's synthetic −25.00 row
    moves `bankToday` from 1000.00 to 975.00, so the label and the figure name one account.
  - **Savings:** resolves as `sole depository`, with subtype `savings`.
  - **Nothing resolvable:** `unresolved`, with everything else null.
- Golden snapshots (`forecastLedger.golden.integration.test.ts.snap`):
  - 11 updated, 72 lines added and none removed: 12 `account` blocks (7 `pointer`, 5 `unresolved`).
  - A script strips those blocks from the new file and gets the old file back byte for byte. **No figure in any golden
    case moved.**
- Card: 7 pure title tests and 1 rendered title test. **All 8 fail on `6b77017`.**

### L2: no `/forecast` bundle fetched for two strings

**What changed.** `useGetForecast` and the `forecast` prop are gone from `CashFlowPage`.

**Proof.** The mock counts bundle calls, and the test asserts zero. **It fails on `6b77017`.**

### L3: the refresh banner no longer clips the chart

**What changed.**
- `ChartCard` (`reportsShared.tsx`) gains an optional `banner` slot, rendered between the head and the body, outside the
  fixed-height chart box. It also shows over the empty state.
- The card passes its refresh-failed `RefreshBanner` into the slot.
- No other ChartCard passes `banner`, so their markup is unchanged.

**Proof.**
- One test finds the chart's fixed `height: 320px` box, asserts the banner is not inside it, and checks the chart is
  still drawn.
- A second test checks that a refresh failure over the no_data empty state still shows its banner.
- **Both fail on `6b77017`.**
- **Not checked visually:** the e2e harness needs Clerk credentials. The geometry follows from the banner no longer
  being a child of the fixed-height box.

### NITs

- **The title keeps "Forecast"** and the horizon, pinned by the title tests above. The scope comes before the horizon,
  so a narrow screen truncates the horizon rather than the account.
- **A blank or missing balance is dropped**, never plotted as $0 (`Number("")` and `Number(null)` are both 0). A real
  "0.00" still plots. The test **fails on `6b77017`**.
- **The source scan is narrowed** to `settings(?.)startingBalance`, with comments stripped, so the legitimate
  `CashSignal.startingBalance` is allowed. It still matches the pre-PR source (`df5d8b0b`) and doesn't match `6b77017`.
- **Retry feedback:** the failed-state banner now gets `refreshing`. The test asserts "Refreshing…" and no Retry button
  while a retry is in flight. It **fails on `6b77017`**.
- **staleTime:** informational only, no change. It is inherited from the app-level defaults, as in `forecast.tsx`.

### Queued: the partly-paid caption

**What changed.** The `plan-partial-paid-…` caption in `PlanDropRow.tsx` prints the absolute paid and planned amounts,
like the remainder caption below it.

**Proof.** `forecastMissedActions.test.tsx` asserts the exact text `Paid $1,000.00 of $1,500.00`. It **fails on the
pre-fix `PlanDropRow`**, which rendered `Paid -$1,000.00 of -$1,500.00`.

### Fails-before summary

- **`cashFlowForecastMissing.test.tsx` (21 tests) against `6b77017`:** 13 fail and 8 pass.
  - Pinned by the mutations under M2: the params test, the ready-case chart test and the no_data 91-point test.
  - Kept from round 1: first and last points, missing daily, cold, and failed first load.
  - The narrowed source scan.
- **`forecastCashSignalKey.test.tsx` (5 tests) against `6b77017`:** 4 fail.
- **`forecastMissedActions.test.tsx` against the pre-fix `PlanDropRow`:** 1 fails, the exact-text caption.

### Figures that move

- **None of the card's balances.** `account` is new descriptive data, and the golden strip check proves no number in
  `computeCashSignal`'s output changed.
- **The card's title text.**
- **Forecast page with look-back closed:**
  - The request no longer carries the browser's date.
  - Whenever the browser's calendar day equals Chicago's, nothing changes.
  - When the two days differ, the page shows the household day's figures, which Overview and the spine already showed,
    and "Bank before" names that day.

### Must not change

- **Calculations:** nothing in `computeCashSignal` or `buildForecastLedger` changed. `resolveSnapshotAccount` resolves
  in the same order and only reads three more columns.
- **Schema:** no DDL and no dependency change.
- **Other ChartCards:** they don't pass `banner`, so their markup is unchanged.
- **Spine:** it picks named fields off the signal, so it is unaffected.

### Verification (merged tree `dd9c9ae5`)

- **Typecheck:** `pnpm run typecheck` exit 0 (workspace, libs, and `typecheck:e2e`).
- **Web tests, `TZ=UTC`:** 140 files; 1171 passed, 3 skipped.
- **Web tests, `TZ=America/Chicago`:** 140 files; 1172 passed, 2 skipped.
- **API suite:** `pnpm --filter api-server run test` against an isolated database (`h2budget_test_prk2`), under
  `caffeinate -i`. 145 files; 1479 passed, 7 todo.
- **Build:** `pnpm run build` exit 0.
- **Entry graph:** `node scripts/check-entry-graph.mjs` reports the landing route at **574.4 KB of 580 KB** (173.1 KB
  gzipped), with no recharts on open and react-dom confined to `vendor-react-*`. `CashFlowPage` stays lazy.
- **Codegen drift**, using CI's recipe (delete both generated `dist` folders and their tsbuildinfo, then regenerate):
  no diff and no untracked files under `lib/api-zod` or `lib/api-client-react`, and `git status` clean.

### Residuals

- **Only the 90-day tab shares the card's key.**
  - The Forecast page's 30-day default and its 120-day, 6-month and 1-year tabs are other horizons, each with its own
    cache entry.
  - After a webhook sync, the 30-day tab and the card can still sit on two copies for up to the 5-minute staleTime.
  - When both copies are equally fresh, balances for a shared date agree (the reviewer checked this).
  - Closing that gap fully would need one horizon for every request, or a cross-key invalidation. Both are beyond this
    finding.
- **The register's filter still uses the browser's day.** With look-back closed, its visible-from filter
  (`visibleFromISO`) uses the browser's day. It filters rows, not a figure.
- **The title can still truncate on a phone** for a long account name, because the kit's card head truncates. The
  horizon is what gets cut first.
- **L3 was not checked visually**; see L3 above.
