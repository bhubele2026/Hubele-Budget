# CI guards: web tests in four timezones, codegen drift; household "today" on the Chase trend chart

- **Base:** `main` = `78979fe`.
- **Branch:** `chore/tz-and-codegen-guards`.
- **Scope:** CI (`.github/workflows/ci.yml`) and one browser-local date on the Transactions (Chase) page. No financial
  calculation, query, stored value, spec or dependency changes.

| Commit | What it does |
|---|---|
| `e02c64de` | Web suite under four timezones; codegen drift check in the typecheck job |
| `731d8dee` | `todayISO` on the Transactions page is the household day; `chaseTrendToday.test.tsx` |
| docs commit | This note |

## Why

Two recent bugs got past CI.

1. **Web tests ran in one timezone.** The web-tests job set no `TZ`, so only the runner's UTC was exercised.
   - A Month-mode bug opened the previous month for browsers east of Chicago.
   - Only a reviewer running `TZ=America/New_York` locally caught it.
2. **CI never checked codegen drift.** Codegen is not in the deploy build, so the committed generated clients are what
   ships.
   - There are three orval targets: `@workspace/api-client-react`, its separate `@workspace/api-client-react/ledger`
     module, and `@workspace/api-zod`.
   - A spec edit without a regen typechecks, because stale output agrees with itself. It would pass CI and deploy
     stale hooks.

A third item: the Transactions page's `todayISO` was the last browser-local "today" on that page.

## What changed

### 1. Web tests in four timezones (`web-tests` job)

- **One install, four sequential steps:** `TZ=UTC`, `America/Chicago`, `America/New_York`, `America/Los_Angeles`.
  Each step sets `CI: "true"`.
- **Sequential steps, not a matrix.** A matrix would repeat checkout, pnpm setup and install per zone. The suite is
  about 10 s locally, so the install would cost more than the tests.
- **Later zones still run after an earlier zone fails** (`if: !cancelled() && steps.install.outcome == 'success'`).
  One push shows every zone that breaks. A failed install skips them.
- **Unchanged:** `api-tests`, `build`, and `e2e` with its `E2E_ENABLED` gate.

### 2. Codegen drift check (`typecheck` job)

A step after `pnpm run typecheck`:

```sh
rm -rf lib/api-zod/dist lib/api-client-react/dist lib/api-zod/tsconfig.tsbuildinfo lib/api-client-react/tsconfig.tsbuildinfo
pnpm --filter @workspace/api-spec run codegen
git diff --stat -- lib/api-zod lib/api-client-react
git diff --exit-code -- lib/api-zod lib/api-client-react
untracked="$(git ls-files --others --exclude-standard -- lib/api-zod lib/api-client-react)"
# non-empty -> ::error:: and exit 1
```

- **Both client targets are covered.** `lib/api-client-react` holds `src/generated`, `src/ledger/generated`, and the
  committed `dist` for both. `lib/api-zod` holds the zod target.
- `codegen` is `orval --config ./orval.config.ts && pnpm -w run typecheck:libs`. `typecheck:libs` is `tsc --build`,
  which emits the committed `dist` declarations and maps.
- **It runs even when typecheck failed,** so both signals show. It does not run when install failed.
- **Untracked files fail too.** `git diff` does not show new files, such as a new schema's
  `types/<name>.ts` and its `dist` `.d.ts` / `.d.ts.map`.
- **`dist` is deleted first.** See the determinism findings below.

### 3. Transactions page: household "today" for the trend chart and projection

`artifacts/h2budget/src/pages/transactions.tsx`: `todayISO` was built from `new Date()`'s local fields. It is now
`householdToday(new Date())` from `@/lib/householdDay`, the helper the page's `ymd` already uses.

`todayISO` feeds:
- the cash-signal request's `fromDate`, so the projection's start;
- the trend chart's today point, its forecast seed, and its axis start;
- the actual/forecast split: Saturdays before today are drawn from the ledger, and Saturdays after it from the
  projection;
- the Saturdays sent to `/transactions/balances` (`s < todayISO`).

**Not changed:** totals, balances and list rows. The register's range, and so its totals and balances, already uses the
household day (pinned by `chaseMonthEdge.test.tsx`). None of that code was touched.

## Determinism findings (codegen)

Measured locally on the branch base.

| Run | Starting state | Diff under `lib/api-zod`, `lib/api-client-react` |
|---|---|---|
| 1 | Fresh worktree: no `tsbuildinfo` (as on a CI checkout) | none |
| 2 | Straight after run 1 (incremental `tsc --build`) | none |
| 3 | `dist`, `src/generated`, `src/ledger/generated` and every lib `tsbuildinfo` deleted | none |
| CI step ×2 | The step's own script, extracted from the YAML and run twice back to back | none, exit 0 both times |

- **No absolute paths.** Every `.d.ts.map` has `"sourceRoot":""` and relative `sources` (e.g. `["../src/index.ts"]`).
  A grep of both packages' `dist` and `src` for `/Users/`, `/private/`, `/home/` and `/tmp/` finds nothing. So the diff is not
  scoped down and no paths are normalised: all of `lib/api-zod` and `lib/api-client-react` is checked.
- **Formatting is pinned.** orval formats with the workspace's `prettier`, pinned by the lockfile.
- ⚠️ **Stale declarations survive a regen.** orval's `clean: true` empties `src/generated`, but `tsc --build` never
  deletes a declaration whose source is gone.
  - **Measured:** add a schema, regenerate, remove it, regenerate. `types/ciDriftProbe.d.ts` and `.d.ts.map` stayed in
    `dist`.
  - **On CI:** a removed schema's committed `.d.ts` would pass forever, because a fresh checkout has it and `tsc` never
    deletes it.
  - **Locally:** an untracked orphan fails the check falsely.
  - **So the step deletes both packages' `dist` and `tsbuildinfo` before codegen.** Run 3 and the step runs show a
    from-scratch `dist` is byte-identical to the committed one, so this adds no noise. `main` has no orphan today.

**The step fails when it should.** The step's script was run against edited specs, then the spec was restored and
regenerated:

| Spec edit (no regen committed) | Changed / new | Step |
|---|---|---|
| None | nothing | **exit 0** |
| `summary` of the first operation (main module) | `api-client-react` `src/generated/api.ts` + `dist`; `api-zod` `src/generated/api.ts` + `dist` (4 files) | **exit 1** |
| `summary` of `getTransactionsLedger` (chase-ledger tag, ledger module only) | `api-client-react/src/ledger/generated/api.ts` + `dist/ledger`; `api-zod` `api.ts` + `dist` (4 files) | **exit 1** |
| New component schema `CiDriftProbe` | 9 tracked files (including both clients' `api.schemas.ts`) + 3 untracked (`api-zod` `types/ciDriftProbe.ts`, `.d.ts`, `.d.ts.map`) | **exit 1** |
| Schema removed again (the orphan case) | nothing: `dist` rebuilt from scratch, orphan gone | **exit 0** |
| Spec byte-identical to the original, regenerated | nothing | **exit 0** |

## The `todayISO` test: fails before, passes after

`artifacts/h2budget/src/pages/chaseTrendToday.test.tsx` (new, 4 tests). It renders the Transactions page against
`fakeLedgerServer` with a manual-balance snapshot. It records the cash-signal hook's params and the trend chart's props.
Two pinned instants, both still Wednesday September 30 in Chicago:
- `2026-10-01T02:00Z`: October 1 in UTC (21:00 in Chicago, 22:00 in New York);
- `2026-10-01T04:30Z`: October 1 in New York too (00:30 there, 23:30 in Chicago).

**It asserts, at each instant:**
- the projection's params are exactly `{ horizonDays: 365, fromDate: "2026-09-30" }`;
- the chart's `todayISO` and `axisDates[0]` are `2026-09-30`;
- `actualFromToday` and the forecast seed are `2026-09-30`, followed by the projection's Saturdays 10-03 and 10-10;
- the last historical point is Saturday 09-26 from the ledger;
- no render carries `2026-10-01` on the axis.

**Before the fix** (`main`'s `todayISO`):

| TZ | Result |
|---|---|
| UTC | **4 of 4 fail**: the projection's `fromDate` and the chart's `todayISO` are `"2026-10-01"` |
| America/New_York | **2 of 4 fail** (the 04:30Z instant); the 02:00Z pair pass, as New York is still September 30 then |
| America/Chicago | 4 pass (the browser's date is the household's) |
| America/Los_Angeles | 4 pass |

**After the fix:** **all 4 pass in each of the four zones**, inside the full-suite runs under **Gates**.

## Gates

| Gate | This branch | `main` (`78979fe`) |
|---|---|---|
| `pnpm run typecheck` | exit 0 | — |
| Web suite, `TZ=UTC` | **134 files, 1107 pass** | 133 files, 1103 pass |
| Web suite, `TZ=America/Chicago` | **134 files, 1107 pass** | 133 files, 1103 pass |
| Web suite, `TZ=America/New_York` | **134 files, 1107 pass** | 133 files, 1103 pass |
| Web suite, `TZ=America/Los_Angeles` | **134 files, 1107 pass** | 133 files, 1103 pass |
| `pnpm run build` + `node scripts/check-entry-graph.mjs` | exit 0 / exit 0: landing **574.4 KB of 580** (173.1 KB gz) | 574.4 KB |
| Landing chunks, exact bytes | index 240,641; vendor-react 192,196; vendor-clerk 89,108; vendor-query 52,498: **identical** | identical |
| Codegen run twice | no diff (plus a from-scratch run, and the CI step's script twice) | — |
| Workflow YAML | `yaml.safe_load` parses; every job, step, `if` and `env` listed and read. `actionlint` is not installed. | — |

- **The +1 file / +4 tests** is `chaseTrendToday.test.tsx`.
- **Bundle comparison:** the same tree built twice, once with `transactions.tsx` at `main`. Every landing chunk is
  byte-identical. The only changed chunk is the lazy `transactions` chunk, **59,113 → 58,999 bytes (−114)**, as the
  hand-rolled date formatting became a helper call the page already imported.
- **Not run locally:** GitHub Actions. CI runs on the push to this branch.

## Added CI time (measured)

**Corrected after the merge.** The first version of this note estimated GitHub's `ubuntu-latest` at 2–3× this
machine. The real run (GitHub run `34654376853`) was slower, so the estimate was low. The measured figures replace it.

| Figure | Estimated | Measured |
|---|---|---|
| `web-tests`, per zone | 25–40 s | **64–65 s** |
| `web-tests`, added by the three extra zones | +1 to 2 min | **about +3.2 min** (job total 289 s) |
| `typecheck`, codegen drift step | +10 to 20 s | **+10 s** |
| Billed minutes per push | +1.5 to 2.5 | **about +3.4** |
| Pipeline wall clock | "moves less" | **about +1.5 min** |

- **`web-tests` is now the longest job** (289 s), ahead of `api-tests` (197 s). The earlier claim that the push waits
  on `api-tests` or `build`, "neither of which changed", no longer holds: a push now waits about 90 s longer.
- **Local, for scale** (Apple silicon): 10–13 s per zone, and 4 s for the codegen step. The runner is about 5–6×
  slower on the web suite, not 2–3×.
- **Option: a matrix.** The zones are sequential steps to avoid repeating the install, but the install took about 2 s
  on the runner (cached store). A `strategy.matrix` over the four zones, with `fail-fast: false` to keep "every
  failing zone shows", would run them in parallel. `web-tests` would fall back to about one zone's time plus setup.
  The costs: four job setups (checkout, pnpm, node) in billed minutes, and four status checks instead of one. Not
  changed yet.

## Residuals

- **The API suite still runs in one timezone** (the runner's UTC). The server computes household days in
  America/Chicago explicitly, but a server test that reads the process's local date would not be caught. Running the
  serial API suite again would cost several more minutes per zone.
- **e2e is still not enabled** (`E2E_ENABLED`). No browser-level test runs in CI, in any zone.
- **The zones are the runner's `TZ` only.** Browser locale, `Intl` default time zone overrides and DST transitions are
  covered only where a test pins its own clock. Nothing forces every date test to pin one.
- **~~Still browser-local on the Transactions page: the trend chart's window~~ (`trendWindow`). Fixed in the
  follow-up below.** Its look-back month, end date and week-ending Saturdays came from `new Date()`'s local fields.
  - **Effect:** on the evening of a month's last day in Chicago, a browser east of Chicago is already in the next
    month. The window then starts a month later, so the axis loses its first month of weeks, and it ends a day later,
    so it can gain one Saturday at the far end. The Saturdays themselves are still real Saturdays.
- **Codegen drift is checked only in CI and only against the committed tree.** It does not check that the running API
  implements the spec.
- **The drift step rebuilds `dist` from scratch.** A future hand-written, committed file under either package's `dist`
  (none today) would fail the check.

---

## Follow-up: timezone canary, trend window, workflow permissions

- **Base:** `main` = `b6c51174` (the merge of the branch above).
- **Branch:** `chore/tz-canary-trend-window`.
- **Scope:** one new test file; one line of the Transactions page's trend window, its import and its tests; the
  workflow's token permissions. No financial calculation, query, stored value, spec or dependency changes.

| Commit | What it does |
|---|---|
| `d597c2e9` | `lib/tzCanary.test.ts`: the web suite fails when `TZ` does not resolve to itself |
| `52ed75d7` | `trendWindow` starts from the household day; window assertions in `chaseTrendToday.test.tsx` |
| `27727549` | Top-level `permissions: contents: read` in `ci.yml` |
| docs commit | This section, and the measured CI time above |

### 1. Timezone canary (LOW 1)

**A mistyped zone raises nothing.** Measured on Node 24.18:

| `TZ` | `resolvedOptions().timeZone` | Offset at 2026-01-15T12:00Z |
|---|---|---|
| `UTC` | `UTC` | 0 |
| `America/Chicago`, `America/New_York`, `America/Los_Angeles` | the same name | 360, 300, 480 |
| `America/Chicgo` | `undefined` | **0 (silent UTC)** |
| unset (this Mac) | `America/Chicago`, the machine's zone | 360 |

`artifacts/h2budget/src/lib/tzCanary.test.ts` has three tests, each gated on `TZ`:
- **`TZ=UTC`:** the resolved zone is `UTC` and the offset is 0.
- **Any other `TZ`:** the resolved zone equals `TZ`.
- **The three non-UTC CI zones:** the offset is non-zero, and exactly 360, 300 or 480.
- **`TZ` unset:** all three skip. The process then uses the machine's zone, which is neither known nor wrong.
  Asserting UTC would fail every local run on a Mac set to Central.

| Run (file alone) | Result |
|---|---|
| `TZ=America/Chicgo` | **fails**: `expected undefined to be 'America/Chicgo'` (1 failed, 2 skipped) |
| `TZ=UTC` | 1 passed, 2 skipped |
| `TZ=America/Chicago`, `America/New_York`, `America/Los_Angeles` | 2 passed, 1 skipped, in each |
| `TZ` unset | 3 skipped |

So every suite run now reports 1 or 2 skipped tests. All of them are the canary's.

### 2. Trend window on the household calendar (LOW 2)

`transactions.tsx`, `trendWindow`: `const now = new Date()` became `const now = localDateOf(householdToday(new Date()))`.
The month arithmetic after it is unchanged. It now runs on a local-midnight Date of the household day, the calendar
`todayISO` already uses.

The window decides the chart's subtitle, the axis's Saturdays, and the Saturdays before today that are sent to
`/transactions/balances`.

**Finding: the pinned September 30 instants cannot move the window's start.** Six months back from September or
October is April or May, and both clamp to the May 2026 tracking floor. At those instants only the end month differs
(`Sep 2027` against `Oct 2027`). So a New Year's Eve pair was added, where every end of the window moves:

| | Household (December 31, 2026) | Browser east of Chicago (January 1, 2027) |
|---|---|---|
| Subtitle | `Jul 2026 – Dec 2027` | `Aug 2026 – Jan 2028` |
| First Saturday | 2026-07-04 | 2026-08-01 |
| Last Saturday | 2027-12-25 | 2028-01-01 |
| First date in the balances request | 2026-07-04 | 2026-08-01 (July's four Saturdays dropped) |

`chaseTrendToday.test.tsx` goes from 4 tests to 8:
- **At `2026-10-01T02:00Z` and `04:30Z`,** on every render: subtitle `May 2026 – Sep 2027`, first Saturday 2026-05-02,
  last Saturday 2027-09-25.
- **At `2027-01-01T02:00Z`** (20:00 on December 31 in Chicago) **and `05:30Z`** (00:30 on January 1 in New York, 23:30
  in Chicago): the household column above on every render and every balances request, and no `2028-01-01` on the axis.
  The chart is lazy, so the test waits for both the balances request and a chart render.

**Before the fix** (the file alone, against `main`'s `trendWindow`):

| TZ | Result |
|---|---|
| UTC | **4 of 8 fail**: both September window tests (`May 2026 – Oct 2027`) and both New Year's Eve tests (`Aug 2026 – Jan 2028`) |
| America/New_York | **2 of 8 fail**: the 04:30Z and 05:30Z instants. At 02:00Z New York is still on the household's day. |
| America/Chicago | 8 pass |
| America/Los_Angeles | 8 pass |

**After the fix:** 8 of 8 pass in all four zones, inside the full-suite runs under the gates below.

**Not changed:** totals, list rows, the register and its balances, `todayISO`, the projection request.

### 3. Workflow permissions (NIT)

- **What changed:** a top-level `permissions: contents: read`. No job overrides it.
- **Every step in all five jobs was checked.** They are `actions/checkout@v4`, which reads the repo;
  `pnpm/action-setup@v4`; `actions/setup-node@v4` with `cache: pnpm`; and `run` steps.
- **No step needs more.** None pushes, comments, creates a release or check, publishes a package or uploads an
  artifact (`upload-artifact` appears nowhere), and none reads `GITHUB_TOKEN` or a secret.
- **The pnpm cache is unaffected.** setup-node reaches the Actions cache service with the runner's own token, which
  `permissions` does not govern.
- **Not verified locally:** the run on GitHub. This branch's push shows it.

### Gates (follow-up)

| Gate | This branch | `main` (`b6c51174`) |
|---|---|---|
| `pnpm run typecheck` | exit 0 | — |
| Web suite, `TZ=UTC` | **135 files; 1112 pass, 2 skipped** (1114) | 134 files, 1107 pass |
| Web suite, `TZ=America/Chicago` | **135 files; 1113 pass, 1 skipped** (1114) | 134 files, 1107 pass |
| Web suite, `TZ=America/New_York` | **135 files; 1113 pass, 1 skipped** (1114) | 134 files, 1107 pass |
| Web suite, `TZ=America/Los_Angeles` | **135 files; 1113 pass, 1 skipped** (1114) | 134 files, 1107 pass |
| `pnpm run build` + `node scripts/check-entry-graph.mjs` | exit 0 / exit 0: landing **574.4 KB of 580** (173.1 KB gz) | 574.4 KB |
| Landing chunks, exact bytes | index 240,641; vendor-react 192,196; vendor-clerk 89,108; vendor-query 52,498: **identical** | as recorded above |
| Workflow YAML | `yaml.safe_load` parses; top-level `permissions` is `{contents: read}`; all 5 jobs and their steps listed | — |

- **+1 file and +7 tests:** the canary (3) and the four new window tests. `main`'s counts are this branch's minus
  those.
- **The lazy `transactions` chunk** is 59,015 bytes, against the 58,999 recorded above. That is +16 bytes for the
  `localDateOf` call. It is not on the landing path.
- **Local suite time:** 9.7–10.3 s per zone.

### Residuals (follow-up)

- **The canary checks the zone the process resolved,** not that any date test depends on it.
- **The window is still computed once per mount** (`useMemo` with no dependencies), like `todayISO`. A page left
  open across the household's midnight keeps the previous day's window until it remounts. Unchanged here.
- **The zones still run as sequential steps.** See the matrix option under "Added CI time".
