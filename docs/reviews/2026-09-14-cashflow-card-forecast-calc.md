# Reports → Cash flow: the forecast-balance card shares the Forecast page's cash signal (owner decision 16)

- **Base:** `main` = `df5d8b0b`.
- **Branch:** `fix/cashflow-card-forecast-calc`.
- **Scope:** `artifacts/h2budget/src/pages/reports/CashFlowPage.tsx` and its test. No API, spec, DDL or dependency
  change; every other chart/total on the page is untouched.

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
  `fromDate` override — this page never opens a look-back, so the server defaults `fromDate` to today exactly as the
  Forecast page's own default 90-day tab does). This is the **same endpoint, same function
  (`computeCashSignal`)** the Forecast page and the spine already read — same account scope
  (`checkingAccountExternalId` resolution), same balance anchor (the bank snapshot, rolled forward), same pending-
  activity treatment (resolutions + matches), same daily calculation.
- `cashFlowForecastSeries(daily)` (exported, pure) maps `{date, balance: string}` → `{date, balance: number}` and
  drops any non-finite balance. No arithmetic, no roll-forward — the array is the signal's own `daily[]`.
- `forecastHasData` requires `cashSignal.status !== "no_data"`, matching the Forecast page's own "no_data still
  carries balances rolled forward from an implicit $0" warning: those are never drawn as a real projection.
- `useGetForecast({ days: 90 })` is kept, but now **only** for `bankSnapshot.name`/`.mask` (the title's source of
  truth) — never for a balance figure. `settings.startingBalance` is not read anywhere in the file (see Tests).

### Title and help name the scope

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
- **The forecast bundle query (`useGetForecast({ days: 90 })`) has no dedicated failed-state UI** — it is kept solely
  for `bankSnapshot.name`/`.mask`, and a failed load there simply falls back to the neutral "Checking" title text
  rather than surfacing its own retry banner. The cash-signal query (the actual balance source) has the full
  loading/failed/refresh-failed treatment the decision cares about.
