# Classic (h2budget) parity — hand-verified, 2026-10-08

Supersedes the counts and calculation claims of `2026-10-08-parity-inventory.md` (the grep census). That file stays the checklist CLAUDE.md §3 points at; this one says what is actually in the code, with the proof for each line, and plans Wave C.

## How this was made

- **Tree read:** `origin/main` 38c348a3 (17:00 CT), exported with `git archive`, re-checked against `origin/main` be1f4e86 before writing. Between the two, `artifacts/h2budget/src` changed only in `components/layout.tsx` (the top line, test id `classic-retiring-banner` kept, now links to `/next/dashboard`, `/next/forecast`, `/next/accounts` and "Current app →") and in the b1b/b2b/b3b fixes (`pages/next/*`, `lib/amountDisplay.ts`, `components/next/TxnTable.tsx`, `ProjectedBalanceChart.tsx`: the expanded chart draws its line again; `/next/accounts/:id` accepts a row id or a Plaid id; the combined view is 30 days). No classic page capability below depends on them; D14 (§4) is still present at be1f4e86.
- **Method:** every classic page file, its dialogs and its sub-components was read top to bottom (ten readers in parallel, one page group each), and each capability is cited by handler, hook, test id or storage key with `file:line`. Tests were confirmed by file and by their `describe`/`it` titles. Cross-cutting claims (lib callers, dead exports, query limits, CSS) were re-checked by import search. Nothing was built, run or deployed.
- **IDs:** every capability has an ID (`FC-12`, `AX-07`, …). Wave C (section 8) names the IDs each restyle must keep; a Wave C PR is "done" only when each listed ID still works and its pinning test still passes.
- **Line numbers** are for 38c348a3 and drift with every merge; the handler/test id is the stable proof.

## 0. Verified summary

Hand counts. "Actions" = live user controls (dead code excluded); charts are split into recharts and CSS/SVG; "stale" = e2e specs whose asserted text or test ids the source no longer renders (read, not run). Census figures in brackets.

| Route | Files (lines) | Actions | Dialogs / popovers | Charts recharts · CSS/SVG | Filters | Drilldowns | Persisted state | Unit / e2e (stale) |
|---|---|---|---|---|---|---|---|---|
| `/home` | landing 325 | 14 [3] | 0 | 0 · 0 | 0 | 13 links | — | 1 / 2 [1 / 0] |
| `/banking` | command-center 601 + why 184 + strip 293 | 14 + 4 conditional [2] | 1 popover | 0 · 2 [0] | 2 pagers [3] | 4 | — | 3 / 1 |
| `/forecast/overview` | 297 | 2 [1] | 0 | 0 · 3 [2] | 0 [2] | 0 | — | 1 / 0 |
| `/forecast`, `/review` | 3,937 + 1,801 [3851 + 1,330] | 69 [~30] | 4 | 1 · 5 stats [1] | 8 [~12] | 3 links + 3 jumps | 5 session + 2 local | 18 + 18 lib / 15 (4 stale + 1 trivial) [17 + 12 / 15] |
| `/reports` hub | 319 + shared 468 | 5 links | 0 | 0 · 5 | 0 [2] | 5 | — | 2 / 1 [3 / 1] |
| `/reports/spending` | 960 | 3 [3] | 1 popover | 3–4 · 2 [5] | 1, no compare [6] | 1 in-place | — | 1 + libs / 0 |
| `/reports/cashflow` | 798 | 2 [2] | 0 | 5 · 0 [5] | 2 [5] | 0 | — | 1 / 0 |
| `/reports/debt` | 507 | 0 [1] | 0 | 4 · 2 [4] | 0 [4] | 0 | — | 0 / 0 |
| `/reports/budget` | 457 | 1 [1] | 0 | 1 · 2 [0] | 1, no compare [2] | 0 | — | 0 / 0 |
| `/reports/behavior` | 378 | 1 [1] | 0 | 1 · 5 meters [3] | 1 [2] | 0 | — | 0 / 0 |
| `/transactions` | 2,987 + 1,231 [2960 + 710] | ~40 + 5 dead [~28] | 2 + `confirm` + 6 popovers | 1 · 3 [3] | 4 + 2 URL [~12] | 5 | 3 local + 1 server | 15 / 25 (9) [8 / 20] |
| `/amex` | 2,442 + 286 [2417 + 290] | ~39 + 7 dead [~30] | 2 + 5 popovers | 1 · RingStat [2] | 3 + 3 URL + 1 hidden [~10] | 3 | 2 local | 8 / 13 (3) [5 / 12] |
| `/debts` | 416 | 0 [1] | 0 | 0 · 0 | 0 [1] | 0 | — | 5 / 3 (3) [4 / 3] |
| `/avalanche` | 2,091 + 1,572 components | ~37 [~14] | 4 + picker + 2 `confirm` | 1 · 2 [0] | 2 [3] | 2 | URL 2 + server | 8 + 3 component / 0 own [6 / 3] |
| `/bills` | 254 | 1 [0] | 0 | 0 · 2 [0] | 0 [2] | 0 | — | 1 / 0 |
| `/bills/all` | 1,732 + 163 | 20 [~14] | 1 + `confirm` | 0 · 0 | 2 [5] | 3 | URL `month` | 4 / 8 (2) [2 / 8] |
| `/budget` | 2,081 + 520 [2081 + 384] | 21 + 3 automatic [~22] | 4 popovers + `confirm` | 0 · 3 [1 + bar] | 0 [~8] | 3 + 3 in-page | URL `month` + server pins | 6 / 8 (+2 others) [6 / 8] |
| `/allowances` | 1,304 + 233 | 13 + 6 in split [~10] | 1 popover + 1 dialog | 0 · 4 [0] | 0 [5] | 0 | 1 legacy key + 4 settings | 1 / 0 |
| `/mapping-rules` | 2,483 + 267 | ~30 [~30] | 2 (1 reachable) | 0 · 0 | 2 [~6] | 3 | 2 local + URL `focus` | 6 / 9 |
| `/settings` | 1,447 + 2,869 | 41 [~28] | 3 + 5 `confirm` | 0 · 0 | 0 [~4] | 2 | 2 local + 6 server | 6 + 15 component + 3 / 4 [6 / 3] |
| `/plaid-oauth` | 170 | 1 | 0 | 0 · 0 | 0 | 1 | reads 2 keys | 0 / 0 |

Totals: **≈ 365 live actions** (census ~250) plus ≈ 13 capabilities the census listed that are dead or absent; **19 recharts charts** across 9 routes plus ≈ 25 CSS/SVG visuals (census ~31 "chart components"); **149 unit/component test files** in `src` (census 141) and **88 e2e specs**, ≈ 21 of them stale; `zz-journeys/walk.spec.ts` is untracked in the local checkout, not on `main`. Persisted client state: 13 localStorage keys and 6 sessionStorage keys.

## 1. The biggest corrections to the census

1. **Reports compute far less than the census says.** Spending, Budget and Behavior render server facts and import only `fmtISO`; 17 of 35 `reportsAnalytics` exports have no caller; the radar, spend clock and day-of-month views are **not rendered anywhere**; compare-to-previous exists only on Cash flow; the Debt report has no range control; the Budget report has a recharts chart (census: none).
2. **Chase is server-driven.** Ending balance, running balance and totals come from `/api/transactions/ledger` and `/balances`; `chaseEndingBalance.ts` and `chaseScope.ts` have no product caller. Four handlers the census lists as live (`handleToggleReview`, `bulkSendToReview`, `handleRefreshBank`, `handleClearTransfer`) are dead and `StatChip` (listed as a chart) is rendered by no page; the filter bar is not mounted; bubbles are four (WK/MO/UN/RE).
3. **Amex is not virtualized**, and seven capabilities built in the file are never rendered (anchor set/clear, Refresh from Plaid, ending-balance tile, hide-reviewed toggle, filter bar, month totals, cap hint); the census or the B3 note lists four of them as live. External-card, matched-rule and transfer-override markers are mobile-only. Bulk bucket does not auto-review. Likely bug: `/next/accounts/:id` loses the card scope on a cold load (D3).
4. **Allowances is per bucket, not per person**; it has no pending totals, its streaks are local (not `lib/weeklyStreak`), and its 8-week bars are `CssBars` that misread weeks outside the fetched window.
5. **Settings has a whole Allowances section the census missed** (and the new app has no equivalent); saved days-since trackers are read by nothing; "bucket labels" are the five weekly sub-buckets.
6. **Forecast:** the main write (`useUpsertForecastResolution`) was missed; `saveSettings` saves horizon/starting balance/buffer, not the look-back; row click marks **missed**; `card-from-bank` is the review card; the hash navigation is dead; five sessionStorage keys were missed; `lib/forecast.ts` is type-only at runtime; `/review` has no month picker.
7. **Command center:** the household spending strip, Sync all, the three allowance rows and both pagers were missed; the "biggest-charges month selector" in the B1 note does not exist.
8. **Debts is a read-only table, not cards.** Avalanche has a recharts chart, a ⋯ menu that is the only edit path, a Plaid account picker, tabs with `?tab=` and `?focus=`; "sync minimums" works from recent payments, not bills.
9. **Mapping rules:** the new app does show user-written rules; the reorder priority is set by the server (`omittedMax + 10·(N+1) − 10·i`), not `(N − idx)·10`.
10. **Tests:** e2e is opt-in in CI and ≈ 21 of 88 specs assert things the source no longer renders; 6 money helpers have no direct test (§6); several capabilities have no test at all (§5).
11. **The B-wave notes need three corrections.** B1: `/banking` has no biggest-charges month selector, and it has two pagers (week and month), not one. B3: the embedded Amex ledger has no member/category/search/hide-reviewed filters and no anchor UI (none is rendered); the Chase ledger has no split dialog, pages by a Load-more button (not infinite scroll), and its ending balance is the server's `balanceEnd`, not a client computation. B2's re-hosting claim holds; what it leaves out is listed under 2.4.

## 2. Per-page inventory, verified

Columns: **ID** (used by Wave C) · capability · proof (handler, hook, test id, storage key) · `file:line` at 38c348a3 · **Exists** (Y = rendered and reachable; N = code present but unreachable, or absent) · what the census said.

### 2.1 `/home` landing — `pages/landing.tsx` (325)

| ID | Capability | Proof | line | Exists | Census |
|---|---|---|---|---|---|
| LND-01 | Six tiles: Home `/banking`, Forecast `/forecast/overview`, Spending `/reports/spending`, Review `/review`, Debt `/avalanche`, Settings `/settings` | `TILES`, `landing-tile-${testid}` | 54-97, 130 | Y | listed |
| LND-02 | Hover/focus chunk prefetch | `prefetchRoute(def.href)` | 131-132 | Y | listed |
| LND-03 | Pointer-follow glow, staggered entrance | `onTilePointerMove` (`--mx/--my`), `tile-in` | 119-151 | Y | glow listed |
| LND-04 | Hero band + wordmark | `HeroBand`, `landing-wordmark` | 215-227 | Y | missed |
| LND-05 | Review bell with count | `landing-bell` → `/review`, `landing-bell-count` (only when > 0, from `spine.reviewCount`) | 233, 244-260 | Y | listed |
| LND-06 | Account menu | Clerk `<UserButton />` | 261 | Y | missed |
| LND-07 | % paid on the Debt tile; **no amount owed, no other numbers** | `landing-payoff-pct` | 19-28, 234, 273-280 | Y | listed; the rule (pinned by `landing.test.tsx:121-135`) missed |
| LND-08 | "More" row | `landing-more`, `landing-more-{reports,allowances,transactions,amex,debts,mapping-rules}` | 104-111, 287-305 | Y | listed |
| LND-09 | Version label — **the only place the build version is shown** | `landing-version` | 307-312 | Y | listed |
| LND-10 | Idle warm-up (5 stages from 400 ms) | `useLandingWarmup` | 239; `hooks/useLandingWarmup.ts:41-119` | Y | listed; it warms `getDashboard`, which neither landing nor `/banking` reads |
| LND-11 | Zero-number skeleton before Clerk answers | `LandingSkeleton`, `landing-skeleton`; used by `App.tsx:439-440` | 182-203 | Y | listed |
| LND-12 | One request on open (spine only); header hidden on `/home` | `useSpine`; `layout.tsx:568, 715-719` | 232 | Y | missed |

Tests: `landing.test.tsx` (10 its). E2E: `a11y-smoke.spec.ts:32`, `perf-open.spec.ts` (census said 0).

### 2.2 `/banking` command center — `pages/command-center.tsx` (601) + `components/bank-balance-why.tsx` (184), `components/chase-insight-strip.tsx` (293)

| ID | Capability | Proof | line | Exists | Census |
|---|---|---|---|---|---|
| CC-01 | Spine refresh banner + Retry | `RefreshBanner`, `cc-refresh-banner` | 394-400 | Y | listed |
| CC-02 | Bank balance "as of" household day | `cc-stat-bank` = `spine.bank.balance` | 410-416 | Y | listed |
| CC-03 | "Why this number?" | `BankBalanceWhy`, `button-bank-why`, popover `bank-why-{displayed,snapshot,since,mismatch,next-sync,no-snapshot,refresh-banner}`; `useGetForecastBankBalanceExplain` (`enabled: open`) | 417; bank-balance-why 34-184 | Y | listed |
| CC-04 | Spent this month / this week | `cc-stat-spent-month` = `spine.spentMonth`, `cc-stat-spent-week` = `spine.spentWeek` | 419-432 | Y | listed |
| CC-05 | Next bill ("none scheduled" when empty) | `cc-stat-next-bill` | 433-446 | Y | listed |
| CC-06 | Cash low point + runway hint ("negative in N days" / "next 90 days") | `cc-stat-low-point` | 447-460 | Y | listed; runway missed |
| CC-07 | Household spending strip: week total vs prior window, % chip, uncategorized note, top-5 category `StackBar`, "Unplanned spending" + "Needs a category", "What was unplanned?" list, Retry | `ChaseInsightStrip`, `strip-spend-total`, `strip-comparison`, `strip-uncategorized-*`, `unplanned-spending-details`; `useGetReportsSpendingFacts` ×2 | 467-484; strip 76-290 | Y | **missed entirely** |
| CC-08 | Bank freshness line | `cc-freshness` → `FreshnessLine` | 473-477 | Y | listed |
| CC-09 | Sync all banks + reconnect popover | `<SyncButton asKit compact />`, `button-sync-plaid`, `sync-progress`, `text-sync-error`, `button-plaid-reconnect-trigger` | 481 | Y | **missed** |
| CC-10 | Allowances card with Open link | `cc-allowances` → `/allowances` | 487-501 | Y | listed |
| CC-11 | Weekly / monthly / unplanned rows with over/left/no-cap chip and `?view=` links | `cc-week-tile`, `cc-month-tile`, `cc-unplanned-tile`; `bucketSpendInWindow` | 172-222, 515-558 | Y | **missed** |
| CC-12 | Week pager and month pager | Prev/Next (aria "Previous week"/"Next week"), forward capped at now | 83-125, 520-548 | Y | **missed** |
| CC-13 | Biggest one-off charges this month | `cc-biggest-charges`, `isSplurge`, `makeRecurringMatcher` (`lib/discretionarySpend`) → `CssBars` top 8 | 363-383, 563-598 | Y | listed |
| CC-14 | Month selector on biggest charges | static label only | 573-575 | **N** | n/a — the B1 note's "month selector" does not exist |
| CC-15 | Phone bar widths | `useNarrow()` | 152-168 | Y | missed |

Charts: 2 (`CssBars`, `StackBar`); census said 0. Data pull: `useListTransactions` 90 days, `limit: 1000` (240-256) — see §7. Tests: `commandCenter.test.tsx` (31 its), `bankBalanceWhy.test.tsx`, `chaseInsightStrip.test.tsx`; e2e `bank-snapshot-freshness-label`.

### 2.3 `/forecast/overview` — `pages/forecast-overview.tsx` (297)

| ID | Capability | Proof | line | Exists | Census |
|---|---|---|---|---|---|
| FO-01 | Bank today | `fo-stat-bank` from **`useSpine`** | 65-71, 158-164 | Y | listed; source wrong (census: cash signal) |
| FO-02 | Low point + date, under/above buffer | `fo-stat-low-point` (spine) | 84-85, 168-177 | Y | listed |
| FO-03 | Runway ("Clear" when never negative) | `fo-stat-runway` | 86, 178-184 | Y | listed |
| FO-04 | Ending balance | `fo-stat-ending` from `useGetForecastCashSignal({horizonDays:90})` | 72-80, 189 | Y | listed |
| FO-05 | Curve | `fo-curve`, `Sparkline` (SVG) | 195-228 | Y | listed |
| FO-06 | Money in vs out | `fo-in-out`, `StackBar`, `fo-in-out-empty` | 232-263 | Y | listed |
| FO-07 | Biggest bills ahead (top 6) | `fo-big-bills`, `CssBars` | 100-118, 265-293 | Y | listed (not counted as a chart) |
| FO-08 | Refresh banner / forecast error with Retry / no-data notes | `fo-refresh-banner`, `fo-forecast-error` | 129-152 | Y | listed |

Charts 3 (no recharts); actions 2 retries; 0 filters, 0 drilldowns (census said 2). The helper `cashSignalProjection` the census names does not exist; `cashSignalProjection.test.ts` tests `lib/forecast` + `forecastMatch`, not this page. Test: `forecastOverview.test.tsx`.

### 2.4 `/forecast` (mode `overall`) and `/review` (mode `review`) — `pages/forecast.tsx` (3,937) + `pages/forecast/*` (1,801 non-test lines)

One component, two modes (`App.tsx:465-470`). Overall-only: hero, KPIs, date-balance card, Past due card, chart, bank grid, month block. Review-only: From-Chase card, pinned inbox, bulk bar. Both: header, horizons, planned list, Missed and Moved buckets. **`/review` has no month picker**, so pending bank rows from earlier months never reach the review inbox (`monthFilter` stays current, 674, 871-875).

**Reads and calculations**

| ID | Capability | Proof | line | Exists | Census |
|---|---|---|---|---|---|
| FC-01 | Bundle + cash signal (one key per horizon; `fromDate` only when look-back is open and picked) | `useGetForecast({days})`, `useGetForecastCashSignal` | 391-409 | Y | listed; key rule missed |
| FC-02 | Spine freshness for the bank card | `useSpine`, `FreshnessLine` | 413, 2375-2380 | Y | missed |
| FC-03 | Payoff sim for "ends {month}" chips and cash-freed banners | `simulate`, `linkRecurringToDebts`, `computePayoffsByDebt`, `computePayoffTransitions`, `filterEventsByPayoff` | 700-776 | Y | partly |
| FC-04 | Register, bucket, bank reconcile | `buildLineRegister`, `buildBucket`, `computeBankReconcile` | 773-981 | Y | listed |
| FC-05 | Suggestions, confident picks, one-click picks, ranked dropdown | `buildClientSuggestions`, `pickConfidentBankMatches`, `pickOneClickBankMatches`, `filterDropdownPlans`, `rankPlansForBank` | 1060-1126 | Y | listed |
| FC-06 | Big-bill markers (≥ ½ buffer or $100, top 5) | `bigBillMarkers` | 1992-2027 | Y | listed |
| FC-07 | Write the answer into the cache before refetch; invalidate the whole `/api/forecast*` namespace | `withResolutionWrite`, `invalidate()` | 1167-1250 | Y | census credits `invalidateForecast.ts`, which this page does not import |

**Writes**

| ID | Capability | Proof | line | Exists | Census |
|---|---|---|---|---|---|
| FC-08 | Resolution upsert — match, the three answers, unplanned, missed, rescheduled, skipped, every bulk write | `useUpsertForecastResolution` | 14, 422 | Y | **missed** (the page's main write) |
| FC-09 | Undo a resolution | `useDeleteForecastResolution`, `onUndo` | 423, 1726-1736 | Y | listed |
| FC-10 | Close month (gap, forecastEnd, bankEnd, pending, reconciled) / reopen | `useCloseForecastMonth` `onCloseMonth`, `useReopenForecastMonth` `onReopenMonth` | 1760-1796 | Y | listed |
| FC-11 | Forecast settings: **horizon days, starting balance, cash buffer** | `useUpdateForecastSettings`, `saveSettings` | 1811-1828 | Y | **wrong** (census: forecast-from date and look-back) |
| FC-12 | Remove from forecast (future row → flag off; posted → unplanned) | `onRemoveFromForecast` | 1738-1758 | Y | listed |
| FC-13 | Set bank snapshot manually; link a checking account; refresh from Plaid | `useSetForecastBankSnapshot` `saveSnapshot`, `onLinkChecking`, `useRefreshForecastBank` `onRefreshBank` | 1834-1917 | Y | refresh hook missed |
| FC-14 | Add as bill | `useCreateRecurringItem`, `submitAddAsBill` | 462-528 | Y | listed |

**Header and controls (both modes)**

| ID | Capability | Proof | line | Exists | Census |
|---|---|---|---|---|---|
| FC-15 | Sticky header: title + Help, Bills link, Settings | `pageStickyHeaderRef`, `link-manage-bills` → `/bills`, `openSettings` | 3729-3749 | Y | link missed |
| FC-16 | Horizon tabs 30/90/120/183/365 with pending spinner | `horizon-{d}`, `horizon-{d}-pending` | 184-192, 2064-2102 | Y | listed |
| FC-17 | Look-back toggle + start date (min 2026-05-01, max today) | `toggle-forecast-lookback`, `input-forecast-from`, `forecast-from-pending` | 2106-2169 | Y | listed under Settings (wrong place) |
| FC-18 | Deferred horizon/date/month keep the old register visible | `useDeferredValue` | 355-362, 681-682 | Y | missed |
| FC-19 | First-load skeleton; load error "Retry forecast"; refresh-failed banner; reauth banner | `errorBanner`, `PlaidReauthBanner` | 1922-1928, 2049-2058 | Y | Retry/refresh banner missed |

**Overall mode**

| ID | Capability | Proof | line | Exists | Census |
|---|---|---|---|---|---|
| FC-20 | Hero ending balance + footnotes (Bank before, Matched impact, Through) | `card-forecast-hero`, `hero-forecast-balance` | 3756-3811 | Y | footnotes missed |
| FC-21 | "Inbox cleared" badge | `badge-inbox-cleared`, `shouldCelebrateClear` | 3766-3770, 1134-1165 | Y | missed |
| FC-22 | KPI tiles | `kpi-lowest-point`, `kpi-ending-balance`, `kpi-projected-income`, `kpi-projected-expenses` | 3821-3868 | Y | listed |
| FC-23 | Balance on a chosen date | `ForecastDateBalance`, `forecast-date-balance` | 3870 | Y | **missed** |
| FC-24 | Past due card + jump to plan | `card-dragging-plans-summary`, `dragging-plans-total`, `dragging-plan-jump-*` → `jumpToPlan` | 2173-2230, 630-650 | Y | jump missed |
| FC-25 | Past due Mark missed / Skip | `dragging-plan-mark-missed-*`, `dragging-plan-skip-*`, `onSkipDraggingPlan` | 2246-2267 | Y | listed |
| FC-26 | Past due "Mark matched to…" — a select of **bank transactions** | `dragging-plan-match-trigger-*`, `-option-*` | 2268-2309 | Y | **wrong** (census: the ranked plan dropdown) |
| FC-27 | Partly-paid lock (Missed/Skip/Match refused) | `dragging-plan-partial-*`, `partialPlanKeys` | 988-1013, 2231-2240 | Y | missed |
| FC-28 | Projected-balance chart (recharts Area, 280 px): buffer line, lowest-point **dot**, big-bill markers (click jumps), tooltip with "Dragged onto this day"/"Due this day", tooltip Mark missed (never on partly-paid) | `card-projected-balance-chart`, `ref-cash-buffer`, `ref-lowest-point`, `big-bill-marker-*`, `tooltip-bill-*`, `tooltip-mark-missed-*` | 3879-3925; PBC 216-566 | Y | listed; marker click missed |
| FC-29 | Empty chart → "Set bank snapshot" | `empty-projected-balance`, `button-empty-set-bank-snapshot` | 3894-3911 | Y | listed |
| FC-30 | Bank balance card (Plaid/Manual · ••mask · date, freshness, "No snapshot") with refresh, Set manually, Link checking | `card-bank-snapshot`, `text-bank-balance`, `text-bank-snapshot-meta`, `button-set-bank-snapshot` | 2327-2415 | Y | **wrong testid** (census: `card-from-bank`) |
| FC-31 | No-balance toast with "Set manually" | `action-forecast-refresh-bank-set-manual` | 1851-1892 | Y | missed |
| FC-32 | Avalanche schedule card | `card-avalanche-schedule`, `useGetForecastAvalancheSchedule` | 2419; avalanche-schedule-card 24-154 | Y | missed |
| FC-33 | "N waiting → Go to Review" | `banner-review-waiting`, `link-go-to-review` | 2457-2479 | Y | missed |
| FC-34 | Month picker (current + 6 prior + register + closed months, ✓ / "$ off" / "(closed)") | `select-month-filter`, `month-filter-pending` | 3183-3229 | Y | select missed |
| FC-35 | Closed / reconciled-at-close / gap chips; Close and Reopen (no test ids) | `month-reconciled-at-close`, `month-gap-at-close` | 3230-3256 | Y | listed |
| FC-36 | Review bucket (count, signed total, 360 px scroll, per-row Undo) | `review-bucket-panel`, `-count`, `-total`, `-list` | 3259-3353 | Y | listed |

**Review mode**

| ID | Capability | Proof | line | Exists | Census |
|---|---|---|---|---|---|
| FC-37 | Empty review → Open Chase | `review-empty-state`, `link-open-chase` | 2425-2455 | Y | missed |
| FC-38 | From-Chase card with pending/matched/unplanned chips, Forecast vs Bank, prior period | `card-from-bank` | 2488-2511 | Y | chips missed |
| FC-39 | Match all confident / Mark all unplanned | `bulk-match-confident`, `bulk-mark-unplanned` | 1382-1511, 2512-2533 | Y | listed |
| FC-40 | Drag hint, dismissal persisted | `drag-to-match-hint`; localStorage `h2budget:forecastDragHintDismissed` | 540-554, 2540-2563 | Y | listed |
| FC-41 | "Back in review N" → mark unplanned | `returned-unflagged-note`, `returned-unflagged-mark-unplanned` | 1414-1427, 2567-2595 | Y | missed |
| FC-42 | Selection bar: Match N confident, Mark N unplanned, Clear | `bank-inbox-selection-bar`, `bulk-match-confident-selected`, `bulk-mark-unplanned-selected`, `bank-inbox-clear-selection` | 2597-2640 | Y | last two missed |
| FC-43 | Reconciled-to-bank chip on an empty inbox; resolved list with Undo | `isReconciledToBank`, `bank-resolved-list`, `undo-resolution-*` | 2641-2699 | Y | chip missed |
| FC-44 | Pinned sticky inbox (only ≥ 720 px tall and ≥ 768 px wide), pager, collapse (persisted), collapsed-row Match | `pinned-inbox-area` (`data-pinned`), `bank-inbox-pager*`; localStorage `h2budget:pinnedInboxCollapsed`; `pinned-inbox-collapsed-match` | 618-629, 2704-2849 | Y | collapsed Match missed |
| FC-45 | Inbox card: checkbox, drag handle, per-card hint, one-click Match + **Enter**, ranked "Choose a planned item" dropdown (**no test id**), Add as bill, Unplanned, hover tints the best plan | `select-bank-*`, `inbox-drag-handle-*`, `one-click-match-*` (`aria-keyshortcuts`), `inbox-add-as-bill-*`, `onMarkUnplannedTxn`, `data-suggested-drop` | IC 51-203; 1090-1126 | Y | dropdown test id wrong; hover missed |
| FC-46 | Probably-paid strip: kind, difference, days, confidence, "close call", Confirm / Not this / Partial | `probably-paid-*`, `answerSuggestion` | PPS 30-145; 1216-1280 | Y | strip listed |
| FC-47 | Suggestion chips | `suggest-match-*` | SS 22-65 | Y | listed (Enter does **not** accept these) |
| FC-48 | × Un-send / Not a planned payment; DragOverlay | `onRemoveFromForecast`; `DragOverlay` | 2927-2945, 3159-3174 | Y | overlay missed |

**Both modes: register**

| ID | Capability | Proof | line | Exists | Census |
|---|---|---|---|---|---|
| FC-49 | Planned list (virtualized above 120 rows), "Projected end" | `PlannedItemsList` (`useWindowVirtualizer`), `planned-projected-end` | 2954-2993; PIL 81-93 | Y | virtualization missed (and see §8 risk) |
| FC-50 | Drop targets with eligible/blocked styling; "Can't match here" toast | `plan-row-*`, `data-drop-eligible` | PDR 62-173; 1285-1318 | Y | listed |
| FC-51 | Row click / Enter / Space = **Mark missed** (not match) | `onSelectPlan` | 1558-1564; PDR 135-144 | Y | **wrong** |
| FC-52 | Move to… dialog (min today, max +30, three guards) | `move-plan-*`, `input-move-date`, `button-save-move`, `move-error` | 1566-1623, 3446-3532 | Y | listed |
| FC-53 | Mark missed with Undo; row Confirm / Not this / Partial; probably-paid line; paid X of Y and remainder | `mark-missed-*`, `toast-undo-mark-missed`, `plan-confirm-*`, `plan-not-this-*`, `plan-partial-*`, `plan-probably-paid-*`, `plan-partial-paid-*`, `plan-remainder-paid-*` | PDR 198-349 | Y | listed |
| FC-54 | Payoff chip "ends {month}"; 2 s highlight after a jump; cash-freed banner; 13 status chips | `payoffsByItem`, `highlightedPlanKey`, `cash-freed-*`, `statusBadge` | PDR 164-193; CFB; SB | Y | chip/highlight/status missed |
| FC-55 | Missed bucket (Set new date, Skip, Undo) and Moved bucket (from → to, Undo) | `missed-bucket-panel`, `missed-set-new-date-*`, `missed-skip-*`, `missed-undo-*`, `rescheduled-bucket-panel`, `rescheduled-undo-*` | 2995-3157 | Y | listed |
| FC-56 | Dialogs: Settings (`#days`, `input-starting-balance`, `#buf`), Set bank balance (`input-snapshot`), Move, Add as bill (name, amount, **type**, **frequency** ×5, day or anchor) | — | 3362-3682 | Y | type/frequency missed |
| FC-57 | Undo coverage: only `not_match`, `partial`, mark missed, skip, skip-dragging have toasts; **match, unplanned, bulk, move, remove have none** | `toast-undo-*` | 1253-1719 | Y | missed |
| FC-58 | Session state: `h2budget:forecastHorizonDays`, `forecastLookbackOpen`, `forecastFromDate`, `forecastFromDatePicked`, `forecastReconciled` (sessionStorage) | — | 164-369 | Y | **missed** (5 keys) |
| FC-59 | Touch drag (delay 150, tolerance 5); plan row wraps below `sm` | `TouchSensor` | 1186-1191 | Y | missed |
| FC-60 | URL hash `#bucket`/`#register` | `onHashChange` → `activeTab`, **which nothing reads** | 371-389 | **N** | listed as live; `/forecast#bucket` links from Chase do nothing |

Counts: 69 controls, 4 dialogs, 1 recharts chart (+ 5 `Stat`), 8 filters/toggles, 3 route links + 3 in-page jumps, 7 persisted keys (5 session, 2 local), 2 keyboard paths. Tests: 18 page/component + 18 lib (census: 17 + 12), `forecastAgreement` for `/next`; 15 e2e (4 stale: `bulk-match-confident`, `dragging-plans-summary`, `move-date`, `tooltip-mark-missed`; `chart-day0-bank-balance` passes trivially).

`/next/forecast` (B2) re-hosts FC-16/17/24-27/30/34-36/37-59 as the same elements; it does **not** host FC-15 (title, Bills link), FC-20/21 (hero, cleared badge), FC-23 (date balance), the classic big-bill markers, or the sticky header (the pinned inbox pins at top 0).

### 2.5 `/reports` hub and five reports — `pages/reports.tsx` (319), `reports/reportsShared.tsx` (468), `SpendingPage` (960), `CashFlowPage` (798), `DebtPage` (507), `BudgetPage` (457), `BehaviorPage` (378)

**The census's report calculations are mostly wrong.** Spending, Budget and Behavior render **server facts** (`useGetReportsSpendingFacts`, `useGetReportsBudgetFacts`, `useGetReportsBehaviorFacts`) and import only `fmtISO` from `lib/reportsAnalytics`. The heatmap, streak board, radar, spend clock and day-of-month helpers the census lists are not called; radar, spend clock and day-of-month **are not rendered anywhere**. Only Cash flow and Debt compute series client-side. Compare-to-previous exists **only on Cash flow**.

Shared (`reportsShared.tsx`): recharts re-exported **directly** (12-39, not via `lib/charts`); `ChartCard` (fixed inline height, default 320, `hideWhenEmpty` returns null), `PanelCard`, `ReportShell` (breadcrumb to `/reports`), `ReportsRangeControls` (Wk/Mo/Yr `range-wk|mo|yr` + `Switch#cmp-prev` only when `showCompare`), `ReportsBalanceTiles` (`reports-tile-total-debt`, `-bank`, `-amex` with `title` on its wrapper, `-cash-buffer`; bank and buffer from **`useSpine`**). Ranges are trailing windows `[today − N, today]`, not calendar periods.

| ID | Page | Capability | Proof | line | Exists | Census |
|---|---|---|---|---|---|---|
| RH-01 | Hub | 4 balance tiles | `ReportsBalanceTiles` | 171 | Y | listed |
| RH-02 | Hub | Debt tile: total-debt Sparkline, "No history yet" | `report-tile-debt` | 93-122, 175-195 | Y | listed |
| RH-03 | Hub | Cash flow tile: Sparkline of `facts.dailyNet` | `report-tile-cashflow` | 196-214 | Y | listed |
| RH-04 | Hub | Spending tile: total, top-5 StackBar, "+ $X uncategorized" sub-line | `report-tile-spending`, `report-tile-spending-uncategorized` | 215-243 | Y | **wrong**: census calls the sub-line an "uncategorized tile" |
| RH-05 | Hub | Budget tile: RingStat % of income | `report-tile-budget` | 244-292 | Y | listed |
| RH-06 | Hub | Habits tile: MiniBars by weekday | `report-tile-behavior` | 293-315 | Y | listed |
| RH-07 | Hub | 5 tile links; loading / "Couldn't load" / dash | `report-tile-*` | 40-56, 85-86 | Y | links listed; states missed |
| RS-01 | Spending | Range Wk/Mo/Yr, **no compare** | `showCompare={false}` | 116 | Y | **wrong** (census: compare) |
| RS-02 | Spending | Uncategorized banner (total, count, 3 merchants) | `banner-uncategorized` | 187-307 | Y | listed |
| RS-03 | Spending | Recategorize popover → `CategoryPicker` with "Remember pattern"; `useUpdateTransaction`; **no undo** | `button-recategorize-uncategorized`, `recat-uncat-*` | 196-304 | Y | listed (Remember missed) |
| RS-04 | Spending | Uncategorized rows pull `limit: 500`, **no cap disclosure** | `useListTransactions({uncategorized:true})` | 98-103 | Y | missed (§2 breach) |
| RS-05 | Spending | KPIs: total real spend (+ uncategorized), top category, top merchant, reimbursable outstanding | `spending-total`, `spending-total-uncategorized`, `spending-top-category`, `spending-top-merchant`, `spending-reimbursable` | 516-574 | Y | listed |
| RS-06 | Spending | Top categories donut (recharts Pie, top 8 + Other) | — | 578-634 | Y | listed |
| RS-07 | Spending | Reimbursable vs personal (recharts Pie) | `REIMBURSABLE_SERIES` | 636-663 | Y | listed |
| RS-08 | Spending | 84-day heatmap — **CSS grid of server `dailyBuckets`** | — | 379-415, 666-712 | Y | listed (wrong source) |
| RS-09 | Spending | Day of week (recharts Bar); **click a bar → that day's top merchants** | `selectedDow` | 715-807 | Y | drill **missed** |
| RS-10 | Spending | Top merchants `CssBars` (top 10) | — | 811-834 | Y | missed |
| RS-11 | Spending | Category trends — **one card, three variants** (1 month CSS stack; ≥ 6 months Area grid; otherwise stacked Bar) | `facts.monthlyTrends` | 837-956 | Y | **wrong** (counted as separate charts) |
| RS-12 | Spending | Skeleton; **a facts error leaves the skeleton forever** | — | 110, 484-495 | partial | missed |
| RC-01 | Cash flow | Range + **compare to previous** (the only page with it) | state 206-207 | 290-295 | Y | listed |
| RC-02 | Cash flow | Pull `limit: 2000` with cap note | `cashflow-clipped-note` | 111, 226-306 | Y | listed |
| RC-03 | Cash flow | KPIs with ±% vs previous | `cashflow-savings-rate`, `-avg-income`, `-avg-expense`, `-avg-net` (`cashFlowKpis`) | 446-546 | Y | listed |
| RC-04 | Cash flow | Automatic granularity (day ≤ 60, week ≤ 180, else month); compare on Yr comes back empty | `dailyCashFlow` → `rollupByPeriod` → `withRunningNet` | 222-231, 364-387 | Y | missed |
| RC-05 | Cash flow | Income vs expense (LineChart, dashed previous) | — | 548-591 | Y | listed |
| RC-06 | Cash flow | Net cash flow (ComposedChart: signed bars, running line, prev net, zero line) | — | 593-636 | Y | listed |
| RC-07 | Cash flow | Locked-in monthly burn — **client-side money maths** (`freqMul`) | — | 391-422, 639-669 | Y | **missed** (and absent from census §6) |
| RC-08 | Cash flow | Forecast balance AreaChart with cold / failed / refresh-failed / no-data states | `cashflow-forecast-card`, `cashflow-forecast-loading`, `cashflow-forecast-refresh-banner` | 118-202, 671-744 | Y | listed |
| RC-09 | Cash flow | Money flow this month — **client-side**, income keyed by first word of description | — | 465-509, 748-771 | Y | listed as "Bar" |
| RC-10 | Cash flow | Rolling 30-day burn (Area) | `rolling30DayBurn` | 773-794 | Y | listed |
| RD-01 | Debt | **No range control** | `ReportShell` without controls | 86 | — | **wrong** (census: range + 4 filters) |
| RD-02 | Debt | KPIs: total, months to debt-free, debt-free date, interest avoided | `debt-report-total`, `-months`, `-date`, `-interest-saved` | 116-197 | Y | listed |
| RD-03 | Debt | Paid off % + meter; "projects X % more" sentence (the only use of `payoffProjectionGauge`) | `debt-report-paid-pct` | 200-230 | Y | **wrong** ("gauge" chart) |
| RD-04 | Debt | Per-debt table (meter, paid, balance, APR, months left, payoff, "Not in window") | `debt-progress-<id>` | 234-293 | Y | listed |
| RD-05 | Debt | Charts: balance history (Area), payoff timeline (stacked Area), snowball waterfall (Bar), interest vs principal (stacked Bar) | — | 296-404 | Y | listed (waterfall double-counted) |
| RD-06 | Debt | Payoff order table; months-remaining CSS bars with `DebtPendingHint`; assumptions footnote | `debt-pending-<id>` | 409-504 | Y | **missed** |
| RB-01 | Budget | Month select (this / last / 2 ago / 3 ago), **no compare** | aria "Budget month" | 28-56 | Y | **wrong** (census: compare) |
| RB-02 | Budget | KPIs: money in, bills & loans paid, flex | `budget-report-income`, `-fixed`, `-flex` | 175-196 | Y | listed |
| RB-03 | Budget | Day-to-day panel: pace chip, spent / pace / planned, projected month-end, flex table | `budget-flex-<categoryId>` | 200-286 | Y | listed |
| RB-04 | Budget | Bills & loans table; Paychecks table | — | 289-382 | Y | **missed** |
| RB-05 | Budget | Pace of the month — **recharts `LineTrend`** | — | 385-400 | Y | **wrong** (census: 0 charts) |
| RB-06 | Budget | Six-month streak board from **server** `facts.streak` | — | 403-454 | Y | **wrong** helpers |
| RBH-01 | Behavior | Range Wk/Mo/Yr, no compare; floor-clamp note | `showCompare={false}`, `facts.range.floorApplied` | 60, 125-129 | Y | **wrong** ("Interactions: none") |
| RBH-02 | Behavior | Days since: Dining / Amazon / Coffee (server's fixed buckets) | — | 116-168 | Y | missed |
| RBH-03 | Behavior | Stats: biggest charge, top merchant, next paycheck, quietest day, impulse buys, subscriptions | `habits-biggest-charge`, `habits-top-merchant`, `habits-next-paycheck` | 172-236 | Y | last three missed |
| RBH-04 | Behavior | 2 streak cards (CSS meters) | — | 240-251, 332-378 | Y | listed as charts |
| RBH-05 | Behavior | Spend by day of week (recharts Bar) | — | 253-291 | Y | listed |
| RBH-06 | Behavior | Largest movements | — | 294-327 | Y | missed |

Exports: none (census correct). No report page has an error state except the hub tiles, Budget ("Budget facts unavailable") and Behavior. Tests: `reportsHubKitRestyle` (asserts no `.recharts-wrapper` in the DOM, the 5 hrefs, mono classes), `spendingTotalHint`, `cashFlowForecastMissing` (pins the 320 px box and reads the page's **source file path**), `reportsAnalyticsExclusion` (tests the dead `categoryTotals`), `reportsBalances`, `reportsPalette` (imports named exports from 4 page files), `chartTokens`, `uncategorizedSpend`, `cssBars`; e2e `reports-amex-tile` only. Debt, Budget and Behavior have **no render test**.

### 2.6 `/transactions` Chase — `pages/transactions.tsx` (2,987) + `pages/transactions/*` (1,231 non-test) + `components/account-page/*`

**The page is server-driven now.** Totals, ending balance and running balance come from `/api/transactions/ledger` (`useGetTransactionsLedgerInfinite` from `@workspace/api-client-react/ledger`) and `/balances`; the client helpers the census lists (`computeChaseEndOfMonthBalance`, `scopeChaseTransactions`, `chaseMonthTotals`, `computeRunningBalances`, `accountBalance`, `bucketSpend`) are not imported. Five handlers the census lists as live are **dead** (CH-61..64). `ChaseReviewInbox.tsx` is a module of five sub-components, not one component.

| ID | Capability | Proof | line | Exists | Census |
|---|---|---|---|---|---|
| CH-01 | Title "Chase" + logo (non-embedded); embedded mode | `AccountPageHeader`; props `embedded`, `accountKey` | 191-194, 2314-2347 | Y | b3 only |
| CH-02 | Add transaction | `handleOpenNew`, `button-add-transaction` | 802 | Y | listed |
| CH-03 | Sync scoped to this account's Plaid item; connect a bank | `SyncButton relevantItemIds` (`button-sync-plaid`, `button-plaid-reconnect-trigger`), `PlaidLinkButton` | 274-288, 2323-2328 | Y | **missed** |
| CH-04 | Reauth, post-link import, refetch-error ("Retry transactions") banners | `PlaidReauthBanner`, `PostLinkProgressBanner`, `register.isRefetchError` | 2304-2311 | Y | missed |
| CH-05 | Range Wk/Mo/Yr (Mo when `?month=`); month navigator in Mo | `TimeRangeToggle` `range-*`; `button-prev-month`, `button-next-month`, `text-selected-month` | 455-457, 2354-2361 | Y | navigator miscounted as a chart |
| CH-06 | Account picker (2+ Chase accounts only; Chase = institution "chase" or `ins_56`) | `chase-account-picker`, `select-chase-account`, `option-chase-account-*` | 239-251, 2562-2600 | Y | listed |
| CH-07 | Account choice persisted; silent self-heal; toast when the server refuses the account | localStorage `h2budget:chase-account` + `?account=`; `register.errorCode` | 172-185, 375-427, 556-563 | Y | **wrong**: there is no "stale warning" UI. Note: embedded mode also writes `?account=` and the key |
| CH-08 | Hide reviewed ("Clear reviewed from list" / "Show reviewed") — **one toggle** | `chase-clear-reviewed`, `useChaseHideReviewed` (localStorage `h2-chase-hide-reviewed` + server `chaseHideReviewed` via ui-preferences) | ChaseReviewInbox 63-70; useChaseHideReviewed 11-78 | Y | **wrong** (two capabilities) |
| CH-09 | URL-only filters and deep links | `?category=` (no UI), `?month=`, `?tx=` (scrolls, strips param, **no highlight**) | 438-525, 2121-2173 | Y | missed |
| CH-10 | Search/date/source/category/member filter bar | `AccountFilterBar` imported, **not mounted** | 99 | **N** | **wrong** ("~12 filters") |
| CH-11 | Money in vs out (StackBar of server totals), change % (`DeltaPill`), signed net | `chase-stats-in-out` | 612-623, 2364-2425 | Y | missed |
| CH-12 | Checking start/end balance = **server `balanceEnd`**; sparkline (≤ 40 days) | `chase-stats-balance`, `Sparkline`; `useGetTransactionsBalances` (≤ 120 dates) | 648-689, 2431-2470 | Y | **wrong source** |
| CH-13 | Balance unavailable / three no-account wordings / stats placeholders / stale guard ("—" while placeholder data shows) / manual meta | `chase-balance-unavailable`, `chase-stats-no-account`, `statsStale`, `text-snapshot-meta` | 549-554, 2404-2531 | Y | partly listed |
| CH-14 | Review chip "Match N items in Review" → `/forecast#bucket`; "All reconciled" | `link-bucket-pending-count`, `text-bucket-empty`, `useReviewInboxCount` | 2535-2560 | Y | drilldown missed (and `#bucket` does nothing — FC-60) |
| CH-15 | Household spending strip (same component as CC-07; **every account, not just Chase**) | `ChaseInsightStrip` | 2605 | Y | file named only |
| CH-16 | Balance trend chart (recharts LineChart: actual solid, forecast dashed, today line, Δ tooltip; May-2026 floor to +12 months; 365-day cash signal); collapse persisted; hidden without a snapshot | `BalanceTrendChart`, `card-balance-trend`, `tooltip-delta-*`; localStorage `h2:chart-collapsed:Checking balance — actual vs forecast` | 625-753, 2607-2618 | Y | chart listed; collapse missed |
| CH-17 | To-review count, freshness line | `chase-to-review`, `chase-freshness` | ChaseReviewInbox 41-73 | Y | count listed |
| CH-18 | Select page / select all N posted (pending excluded, 1,000 cap) / clear | `chase-select-page`, `chase-select-all-matching(-count/-too-many/-clear)` | ChaseReviewInbox 54-147; 1608-1640 | Y | cap + pending rule missed |
| CH-19 | Pager "Showing X of Y · Z to review" + **Load more button** (50 a page) | `chase-ledger-pager`, `chase-showing`, `chase-load-more` | ChaseReviewInbox 150-186 | Y | listed (B3 calls it "infinite") |
| CH-20 | Pinned Pending group (all pending for the account, not totalled), "More pending"; After-today rows (never totalled), "More after today" | `group-pending`, `day-net-pending`, `chase-load-more-pending`, `chase-load-more-after-today` | 2734-2837 | Y | listed |
| CH-21 | Row labels: After today / Pending 14+ days / Already in balance / Not counted | `label-<key>-<id>` | ChaseReviewInbox 189-206 | Y | missed |
| CH-22 | Day groups: sticky head, Today chip, select-day (indeterminate), day net | `day-net-<day>`, `toggleDay` | 2839-2873; day-group 27-101 | Y | listed |
| CH-23 | Column heads (xl), scroll to today, empty (two wordings), load error + Retry, cold skeleton | `ledger-columns`, `chase-empty`, `chase-ledger-error`, `AccountPageSkeleton` | 2111-2197, 2650-2724 | Y | partly |
| CH-24 | Row select | `toggleOne` | 1578 | Y | listed |
| CH-25 | Merchant rename (Enter saves; reset to bank default) | `MerchantRenamePopover`: `usePutMerchantAlias`, `useDeleteMerchantAlias`, `rename-*` | transaction-row 120 | Y | listed |
| CH-26 | Source label ("Chase · Plaid") | `formatTransactionSource`, `text-card-*` | 151-164 | Y | missed |
| CH-27 | Row category picker (Uncategorized / Transfer / Ignore, search, Remember) — **the Remember choice is dropped** | `CategoryPicker` → `handleQuickCategorize`, `checkbox-remember-picker` | 1299-1371, 2911 | Y | listed; no-op missed |
| CH-28 | "Categorized" toast with rule Undo; "Apply to past?" → Show matches dialog → Apply → Undo | `action-undo-rule`; `action-apply-rule-past`, `dialog-rule-matches-preview`, `action-undo-bulk-recategorize` | 1317-1356, 2637 | Y | **misplaced** in the bulk bar |
| CH-29 | Bubbles **WK / MO / UN / RE** (first three exclusive; hidden on transfers) | `handleToggleBucket` | 2223-2285 | Y | **wrong** (census: three) |
| CH-30 | Date ‹1d and date popover (Enter/Esc; hidden on pending) | `button-bump-date-back-*`, `button-inline-date-*`, `handleQuickDate` | 1429-1468 | Y | ‹1d missed |
| CH-31 | Inline amount (Enter/Esc, sign kept, posted only); flip expense ↔ income | `amount-*`, `input-inline-amount-*`, `button-flip-kind-*`, `handleQuickFlipKind` | 1377-1506 | Y | listed |
| CH-32 | Running balance "bal $X" = **server's per-row value** | `text-running-balance-*`, `tx.runningBalance` | 2934-2941 | Y | **wrong source** |
| CH-33 | Forecast chip (In Review / Matched / Partly paid / Not planned) → `/forecast#bucket`; × removes (future → flag off; posted in review → not planned; **no undo**) | `badge-forecast-state-*`, `link-forecast-state-*`, `button-remove-forecast-*`, `handleToggleForecast`, `handleNotPlanned` | 1132-1255 | Y | chip missed; **undo claim wrong** |
| CH-34 | Send to Forecast (disabled until categorized; bank rows) | `button-send-forecast-*` | 1262-1295 | Y | listed |
| CH-35 | Row Mark reviewed / Reviewed + Undo toast | `setReviewed` → `reviewByIds` | 1642-1691, 2804, 2947 | Y | **wrong handler** (census: `handleToggleReview`) |
| CH-36 | Edit (posted rows); Delete (posted, `confirm()`, no test id, no undo) | `handleOpenEdit`, `button-edit-tx-*`, `handleDelete` | 821-847, 1058-1070 | Y | listed |
| CH-37 | Row dim when in the forecast or categorised Ignore | `data-sent`, `data-ignored`, `opacity-50` | 484-487, 2770-2921 | Y | **misnamed** in census §4 |
| CH-38 | New/Edit dialog: date, description, category combobox (search, clear), kind, amount, reimbursable, reimbursed, weekly/monthly/unplanned allowance, transfer; live rule auto-pick; matched-rule chip → `/mapping-rules?focus=`; transfer override hint + "Reset to auto" | `TransactionEditDialog`, `combobox-new-tx-category`, `matchRuleClient`, `link-matched-rule-new-tx-dialog`, `transfer-override-hint`, `button-reset-transfer-override` (`useClearTransferOverride`) | TransactionEditDialog 81-233; 854-958 | Y | partly |
| CH-39 | Create toast: rule link + Undo | `link-auto-categorized-rule`, `action-undo-auto-categorize` | 960-1052 | Y | listed |
| CH-40 | Sticky bulk bar: send / remove forecast (skips non-bank and uncategorized; Undo) | `bulk-bar`, `bulk-send-forecast`, `bulk-remove-forecast`, `action-undo-bulk-*-forecast` → `undoBulkForecast` + `undoNotPlanned` | 1785-1818, 1953-2108, 2670-2698 | Y | listed |
| CH-41 | Bulk mark reviewed / unreviewed (by id ≤ 200 per call, or by filter: 409 = count changed, 400 = too many; pending skipped) + Undo | `bulk-mark-reviewed`, `bulk-mark-unreviewed`, `useChaseReviewWrites` (`useBulkUpdateTransactions`, `useBulkReviewMatchingTransactions`) | 1693-1778 | Y | 409/too-many missed |
| CH-42 | Clear selection; pruned to visible rows | `clearSelection` | 1595-1604 | Y | partly |
| CH-61 | Send / unsend to forecast Review per row | `handleToggleReview`, `undoReviewToggle` | 1821-1892 | **N (dead)** | listed as live |
| CH-62 | Bulk send to Review | `bulkSendToReview`, `action-undo-bulk-send-review` | 1899-1948 | **N (dead)** | listed as live |
| CH-63 | Refresh bank / "Set manually" | `handleRefreshBank`, `action-refresh-bank-set-manual` | 1508-1570 | **N (dead)** | listed as live |
| CH-64 | Clear-transfer pill on the row | `handleClearTransfer`; `TransactionRowChips` built (2200) but never rendered | 2205-2222 | **N (dead)** | listed as live |
| CH-65 | `StatChip` | rendered by no page | — | **N** | listed as a chart |

No separate mobile row (flex below `xl`, grid at `xl`). Counts: ~40 live actions, 2 dialogs + `confirm()`, 6 popovers; charts 3 components (`BalanceTrendChart` recharts, `Sparkline` SVG, `StackBar` ×2) + `DeltaPill`; 4 UI filters + 2 URL-only; 5 drilldown links to 2 routes; 3 localStorage keys + 1 server preference. Undo: 6 live, 3 dead. Tests: 15 unit (census 8; `chaseLedger.test.ts` missing from its list; `chaseEndingBalance`/`chaseScope` test orphan libs; `chaseOnlyForecast` tests `forecastMatch`); 25 e2e (20 `transactions-*` + 4 `chase-*` + `matched-rule-chip-surfaces`), **9 stale** (they query `badge-category-*`, `select-${id}`, `badge-uncategorized-*`, `badge-transfer-*`, `button-clear-transfer-*`, `opacity-60`, none of which `/transactions` renders).

### 2.7 `/amex` — `pages/amex.tsx` (2,442) + `components/amex-card-band.tsx` (163), `bucket-bubbles.tsx` (123)

**A large part of the file is computed but never rendered** (it compiles because `noUnusedLocals` is off, `tsconfig.base.json:11`): the ending-balance tile, set/clear anchor, Refresh from Plaid, the hide-reviewed toggle, the filter bar, month totals and the month-cap hint. The census lists several of them as live. **The list is not virtualized** (#772 removed `useWindowVirtualizer`; only a comment remains, 2373-2399). Desktop rows lack the external-card chip, the matched-rule chip and the transfer-override badges — those exist on the mobile rows only.

| ID | Capability | Proof | line | Exists | Census |
|---|---|---|---|---|---|
| AX-01 | Month query (`MONTH_LIMIT` 1000) and 12-month trend query (`limit: 5000`, banned) | `useListTransactions` ×2, `AMEX_SOURCES` (incl. Apple Card) | 116, 348-398 | Y | listed; limits not flagged (§7) |
| AX-02 | Anchor reads (combined and per card) | `useQuery(["/api/amex/anchor"…])` | 408-443 | Y | missed |
| AX-03 | Month navigator; Wk/Mo/Yr (**Yr behaves as Mo**); auto-jump to the latest month with data | `MonthNavigator`, `TimeRangeToggle`, `initialAmexJumpDone` | 234, 556-621, 1857-1858 | Y | navigator missed; Yr not noted |
| AX-04 | Card filter via band tiles; reset to "all" when the card is not among options | `AmexCardBand onSelect`, `amex-tile-all`, `amex-tile-<tier>` (two Platinum cards share one id) | 743-764, 1866-1869; CB 56-105 | Y | missed |
| AX-05 | URL params `?accountId=`, `?month=` (from `/budget`), `?category=` (applied once, **no chip, no clear**) | — | 237-244, 323-338, 528-545 | Y | missed |
| AX-06 | Hide reviewed | localStorage `amex.hideReviewed` read at 628; **`setHideReviewed` never called** | 252-263, 628 | **N** (read-only; a stale "1" hides rows with no way back) | **wrong** (listed as a filter) |
| AX-07 | Search / from / to / source / member / category filter UI | state only; `AccountFilterBar` not rendered | 224-229, 593-640 | **N** | B3 claims it |
| AX-08 | Row select, select day | `toggleOne`, `toggleDay` | 1133-1145 | Y | day listed |
| AX-09 | Row category (Transfer / Ignore / Uncategorized options; Remember pattern) | `setRowCategory` | 1214-1296 | Y | listed |
| AX-10 | Bubbles WK/MO/UN — **per-row bucket sets `reviewed = bucket !== ""`** in the same PATCH; turning a bubble off clears only the active bucket | `setRowBucket`, `onBubbleToggle` | 1394-1457, 1503-1514 | Y | listed |
| AX-11 | RE reimbursable: on → reviewed; off → reimbursed false, reviewed false only if no bucket | `setRowReimbursable`, `reviewedPatch` | 1459-1501 | Y | listed |
| AX-12 | Optimistic cache, per-row serial queue, field-level rollback | `patchTransactionInCache`, `queueBubbleMutation` | 1298-1392 | Y | missed |
| AX-13 | Date ‹1d; date popover (Enter/Esc; hidden on pending) | `handleQuickDate`, `button-bump-date-back-*`, `button-inline-date-*` | 1182-1212 | Y | listed |
| AX-14 | Merchant rename | `MerchantRenamePopover` | 2105 | Y | listed |
| AX-15 | Clear transfer flag (no reset to auto) | `button-clear-transfer-<id>` / `-mobile-<id>` | 2197-2222, 2311-2336 | Y | "override and reset" wrong |
| AX-16 | Transfer badges; `*` overridden and "Manually set" markers **mobile only** | `badge-transfer-*`, `badge-transfer-overridden-mobile-*`, `badge-transfer-overridden-cleared-mobile-*` | 2168-2196, 2300-2310 | Y | mobile-only not noted |
| AX-17 | External-card mark/clear — **mobile only** | `button-mark-external-card-mobile-*`, `badge-external-card-mobile-*`, `button-clear-external-card-mobile-*` | 152-205, 2225-2245 | Y (mobile) | **wrong** (no mobile note) |
| AX-18 | Matched-rule link → `/mapping-rules?focus=` — **mobile only** | `link-matched-rule-amex-mobile-*` | 2246-2252 | Y (mobile) | missed |
| AX-19 | Dim reviewed and Ignore rows | `data-reviewed`, `data-ignored`, `opacity-50` | 519-526, 2077-2283 | Y | **misattributed** to transactions.tsx |
| AX-20 | Card label "name ••mask"; notes line | `text-card-*`, `text-card-mobile-*` | 723-738, 2107-2119 | Y | missed |
| AX-21 | Bulk bar (sticky): category (invalidates budget months), bucket ×4 (**does not set reviewed**), reimbursable mark/unmark (no reimbursed reset), reviewed mark/unmark, owed-by set/clear (Enter/Esc, datalist `amex-owed-by-suggestions`), progress, clear | `bulkSetCategory`, `bulkSetBucket`, `bulkSetReimbursable`, `bulkSetReviewed` (`button-bulk-mark-reviewed`), `bulkSetOwedBy` (`input-bulk-owed-by`, `button-bulk-clear-owed-by`), `text-bulk-progress` | 1659-1978 | Y | listed; bulk auto-review wording wrong |
| AX-22 | One request per unique patch; failure panel; retry failed; dismiss | `runBulkPatch`, `panel-bulk-failures`, `row-bulk-failure-*`, `runBulkRetry` (`button-bulk-retry-failed`), `dismissBulkFailures` | 1529-1657, 1984-2040 | Y | listed |
| AX-23 | Running balance per row (seeded from the month ending balance; ignores filters) | `computeRunningBalances`, `makeAmexBalanceAtEndOf`; `text-running-balance-*` | 944-1032, 2125-2132 | Y | listed (wrong lib functions: `resolveAmexAnchor`/`computeAmexEndOfMonthBalance` are test-only) |
| AX-24 | Anchor chain: all cards = server anchor → `resolveAmexDebt` → computed; per card = debt row → anchor endpoint → $0 | — | 795-932 | Y | missed |
| AX-25 | Forward 12-month balance chart (recharts LineChart, from May 2026, Saturday points); collapse persisted | `buildBalanceWindow` → `BalanceTrendChart`; localStorage `h2:chart-collapsed:Ending balance — forward 12 months` | 1110-1119, 1871-1876 | Y | listed; collapse missed |
| AX-26 | Card band: statement balance, this week's charges, "% cleared" `RingStat` per card, tier colour and name | `useGetAmexWeeklyPayoff`, `useGetSettings` (`amexCardBrands/Names`) | CB 38-153 | Y | ring missed; `BucketBubbles` miscounted as a chart |
| AX-27 | Add card to Avalanche (APR + minimum) | `AddToAvalanche`, `amex-add-to-avalanche(-confirm)` | CB 155-157 | Y | missed here |
| AX-28 | Plaid scoping: reauth banner + Sync for Amex items only; Connect; post-link progress | `relevantAmexPlaidItemIds`, `PlaidReauthBannerView`, `SyncButton`, `PlaidLinkButton`, `PostLinkProgressBanner` | 682-719, 1811-1845 | Y | missed |
| AX-29 | Live "today" (focus, visibility, midnight); scroll to today; sticky offset measured | `todayRef`, `--pinned-pane-h` | 265-319, 1765-1804 | Y | missed |
| AX-30 | Cold skeleton; empty "No transactions match these filters."; chart and band hidden without data | `AccountPageSkeleton` | 1794-1796, 2042-2046 | Y | missed |
| AX-31 | Mobile row variant (CSS split; both trees always mounted) | `row-amex-mobile-<id>` / `row-amex-<id>` | 2071-2358 | Y | listed (not `use-mobile`) |
| AX-32 | Toasts and Undo after a per-row categorize; "Apply to past" prompt + preview + Undo (**per-row only**, not on bulk) | `buildRuleUndoAction` (`action-undo-rule`), `offerBulkRecategorize` | 1255-1287, 2368 | Y | **misplaced** in the bulk bar |
| AX-33 | Ending-balance tile + source footer | `endingBalanceMeta`; `stat-ending-balance` absent from src | 1034-1101 | **N** | implied live |
| AX-34 | Set / clear actual balance | `submitAnchor`, `clearAnchor` (no JSX) | 452-511 | **N** | listed as live |
| AX-35 | Refresh from Plaid | `handleRefreshAmex` ("Currently unwired") | 766-777 | **N** | listed as live |
| AX-36 | Month totals; 1000-row cap hint | `monthTotals`, `monthCapHit` | 590, 660-670 | **N** | — |
| AX-37 | Refetch on focus (#501) | comment only; `/api/transactions` has `refetchOnWindowFocus:false` | 382-396 | **N** | `amexPageMonthRefetchOnFocus` passes only on its own client defaults |

**Likely bug (read, not run):** on a cold cache `cardFilterOptions` is empty, so the effect at 759-764 resets `cardFilter` to "all", and the embedded effect (245-247, deps `[embedded, accountId]`) never runs again. `/next/accounts/:id` and `?accountId=` therefore probably lose their card scope on first load; `Accounts.test.tsx` mocks the page and cannot see it.

Counts: 13 per-row + 14 bulk + ~12 page actions; 2 modals, 5 popovers, 1 inline form; charts 2 kinds (`BalanceTrendChart` recharts, `RingStat` SVG ×N); 3 live filters + 3 URL params + 1 hidden persisted; 2 localStorage keys. Tests: 8 unit (census 5/7; `amexPlaidScope.test.ts` missed), 13 e2e, **3 stale** (`amex-running-balance`, both `relink-duplicate` specs read `stat-ending-balance`).

### 2.8 `/debts` — `pages/debts.tsx` (416)

A read-only **table**, not cards. No page actions, dialogs, filters or drilldowns; rows are not clickable.

| ID | Capability | Proof | line | Exists | Census |
|---|---|---|---|---|---|
| DB-01 | Stats: Active / Cleared / Extra per month | `Stat` ×3 | 217-226 | Y | missed |
| DB-02 | Creditors table: creditor, status, APR, balance, min, payoff, target payoff, extra; always sorted by APR | — | 192-193, 241-399 | Y | **wrong** ("cards per debt") |
| DB-03 | Target highlight (sim month 0; no fallback when nothing is solvable) | `planTargetIds` | 153-164, 306-323 | Y | listed |
| DB-04 | Reserved target slots (row stability) | `debt-card-target-payoff-date`, `debt-card-target-extra`, `*-slot` | 347-393 | Y | listed |
| DB-05 | Payoff month + reason (Underwater / Beyond horizon) | `debt-card-payoff-date` | 201-211, 334-346 | Y | listed |
| DB-06 | Paid-off row: chip + kill month from balance history | `debt-card-paid-off`, `-headline`, `-month`, `killMonthForHistory` | 63-117, 269-302 | Y | listed ("celebration" overstated) |
| DB-07 | % paid under the name; pending hint | `DebtPendingHint` | 311-331 | Y | % missed |
| DB-08 | Reauth banner; empty state; no error state | `DebtReauthBanner`, `text-debts-empty-state` | 188-215, 401-405 | Y | banner missed |

Tests: 5 unit (`debtsPagePaidOff`, `debtsPagePlanMultiTarget`, `debtsPageRowStability`, `debtsPageTargetExtra`, `debtBalanceParity`). E2E: the 3 `debts-*` specs are **stale** (they wait for heading `/debt avalanche/i`, which exists nowhere; empty-state copy differs).

### 2.9 `/avalanche` — `pages/avalanche.tsx` (2,091) + `add-card-to-avalanche` (157), `avalanche-card-config` (190), `avalanche-schedule-card` (154), `debt-pending-hint` (70), `debt-plaid-link` (1,001)

| ID | Capability | Proof | line | Exists | Census |
|---|---|---|---|---|---|
| AV-01 | Hero payoff % (spine) + meter + debt-free hint | `avalanche-hero`, `avalanche-payoff-pct`, `avalanche-debt-free-hint`, `.bar-sweep` | 193-194, 675-747 | Y | listed |
| AV-02 | Paid-off banner (dismissable) | `killedBanner` | 652-668 | Y | missed |
| AV-03 | Sync minimums **from recent payments** | `useSyncDebtMinimums` | 278-296, 703-712 | Y | **wrong** ("from bills") |
| AV-04 | "Paste debts" button — opens Add; no paste logic | `setAddOpen(true)` | 713-720 | button only | missed |
| AV-05 | Add debt dialog (creditor, APR, type, balance, min, due day, notes; Plaid-override warning) | `DebtDialog` → `createDebt` | 721-728, 1545-1554, 1739-1912 | Y | listed (**`handleSave` is archive/restore only**) |
| AV-06 | Stat strip: months to freedom (∞ / excludes underwater), debt-free date, total interest, total debt | — | 752-784 | Y | missed |
| AV-07 | Payoff-order bars | `CssBars` ranked | 566-602, 789-814 | Y | missed ("0 charts") |
| AV-08 | This-month panel, multi-target, pay-target buttons | `panel-this-month`, `this-month-targets`, `btn-pay-target(-{id})`, `this-month-pay-buttons` | 528-550, 817-949 | Y | listed |
| AV-09 | Extra source (manual / budget net / budget line) + category select + breakdowns | `extraSource`, `extraBudgetCategoryId` | 962-1060 | Y | missed |
| AV-10 | Budget slider 0–5000 step 25, live sim from the draft, commit per tick; Reset to $0; room-left text | `text-avalanche-budget-live`, `text-room-left` | 358-376, 1062-1124 | Y | listed; reset missed |
| AV-11 | Strategy toggle avalanche/snowball + verdict; budgeted/actual mode | `PillToggle`, `strategy-verdict`, `budgetMode` | 121-178, 633-646, 1142-1163 | Y | verdict listed; toggles missed |
| AV-12 | Settings save invalidates avalanche, bills summary, forecast family, budget months | — | 209-241 | Y | missed |
| AV-13 | "Your next 3 moves" | `next3` | 513-521, 1171-1226 | Y | missed |
| AV-14 | Schedule card | `card-avalanche-schedule`, `useGetForecastAvalancheSchedule` | 1229-1231 | Y | listed |
| AV-15 | Amex card config (tier, name, cadence → `preferences.amexCard*`) and Add card to avalanche | `amex-tier-set-*`, `amex-add-to-avalanche(-confirm)` | 1234-1236; acc 26-190; a2a 19-157 | Y | listed; **no test reaches either** (tests stub the payoff hook) |
| AV-16 | Tabs Debts / Projection / Chart / Archived with `?tab=`; `?focus=` scroll + 2.2 s ring | — | 309-347, 1239-1301 | Y | missed |
| AV-17 | Debts table: creditor, APR, balance, min, due chip, payoff, daily interest, actions, totals; target highlight; source chip / Plaid source / last synced; pending hint | `DebtSourceChip`, `renderDueChip`, `debt-pending-*` | 1265-1370, 1914-1942 | Y | table listed; details missed |
| AV-18 | Row click → drill-down dialog (schedule, if-min-only, interest/day) | — | 1303, 1633-1693 | Y | missed |
| AV-19 | Row Pay → record-payment dialog (amount, date, account, notes; pay-extra checkbox) | `PayDialog`, `useCreateDebtPayment`, `togglePayExtra` | 1342-1351, 1944-2091 | Y | listed |
| AV-20 | Row ⋯ menu: **Edit (the only way into edit)**, Refresh from Plaid, Unlink (confirm), Link (picker dialog → PostLinkDebtDialog), Reconnect | `button-debt-actions-*`, `-edit-`, `-refresh-`, `-unlink-`, `-link-plaid-*`; `useLinkDebtToPlaid`, `useCreateDebtFromPlaidAccount` | dpl 282-806 | Y | **missed** (census files the picker under Settings) |
| AV-21 | Debt reauth banner | `banner-debt-reauth` | 650; dpl 906-1001 | Y | missed |
| AV-22 | What-if slider (not saved); projection table + show all; Chart tab (**recharts `LineTrend`**); Archived tab + Restore; Archive from edit; Delete (confirm) | — | 377-489, 1377-1580 | Y | chart **missed** ("0 charts"); others missed |
| AV-23 | Loading skeleton; "No active debts."; no error state | — | 606-608, 1277-1283 | Y | missed |

Tests: 6 page + `debtBalanceParity` + `lib/avalanche.test`; `debtReauthBanner`, `debtPlaidReconnect`, `debtPlaidPickerInstitutionMatch` for `debt-plaid-link`. E2E: none of its own; 3 `bills-*` specs visit it, 2 stale (`locked-row` expects `ring-primary`; `celebratory-row` clicks a button that is now the ⋯ trigger).

### 2.10 `/bills` overview and `/bills/all` — `pages/bills-overview.tsx` (254), `pages/bills.tsx` (1,732), `components/bills-health-check.tsx` (163)

| ID | Capability | Proof | line | Exists | Census |
|---|---|---|---|---|---|
| BO-01 | Next bill, bills due | `stat-next-bill`, `stat-bills-due` (spine) | 42-43, 84-104 | Y | due missed |
| BO-02 | Refresh banner + Retry | `bills-refresh-banner` | 109-119 | Y | listed |
| BO-03 | Month card: income, bills, debt min, outflow, net, Surplus/Short chip, committed % + meter (all **server** `summary.monthly.*`) | `bills-month-card`, `text-overview-*`, `chip-net-state` | 123-212 | Y | chip/meter missed |
| BO-04 | Biggest recurring bills (`CssBars` top 6) | `bills-biggest-card` | 216-250 | Y | not counted as chart |
| BL-01 | Month picker (floor 2026-04, `?month=`) | `button-prev-month`, `button-next-month`, `text-current-month` | 243-296, 696-723 | Y | listed |
| BL-02 | Due-window Wk/Mo/Yr (from today, not the picked month) | `TimeRangeToggle`, `bills-due-lead` | 670-682, 762-812 | Y | missed |
| BL-03 | Headline stats: due in window, net + % committed (client), active items | — | 737-757 | Y | missed |
| BL-04 | Add / edit dialog: income/bill toggle, name, amount, frequency (5; **quarterly/annual coerced to monthly on edit**), day of month / one-time date / anchor, category (disabled for debt-linked), active; validation toasts; "Move this bill" + move-result toast; Create another | `openNew`, `openEdit`, `toggle-income`, `select-frequency`, `input-day-of-month`, `input-onetime-date`, `input-anchor-date`, `select-category`, `checkbox-active`, `button-create-another`, `onCreateAnother` | 227-229, 372-469, 1025-1298 | Y | listed; coercion, move, validation missed |
| BL-05 | Category chip opens the dialog with the picker focused | `chip-category-none-{id}` | 351-370, 1517-1528 | Y | missed |
| BL-06 | Delete (dialog or row; `confirm()`); pause/resume | `onDelete`, `onDeleteRow` (`button-delete-row-*`), `onToggleActive` (`button-toggle-active-*`) | 487-539 | Y | listed |
| BL-07 | Per-row actual vs planned (✓ when ≥ 99 %, partial "so far"); per-paycheck amount + ~$/mo | `text-actual-{id}`, `formatBillRowAmount` | 1446-1563 | Y | listed (conflated with the side card) |
| BL-08 | Group cards + totals, sorted by next occurrence | `text-group-total-income/-bill` | 816-839, 1395-1412 | Y | missed |
| BL-09 | Debt minimums card (paid-off rows struck through, lock, "synced from Plaid"), filtered by payoff, rows → `/avalanche?focus=` | `card-debt-minimums`, `row-debt-min-*`, `filterDebtMinRowsByPayoff` | 541-613, 840-855, 1623-1732 | Y | card listed; filter + links missed |
| BL-10 | Archived debts → `/avalanche?focus=` | `card-archived-debts` | 856-893 | Y | listed |
| BL-11 | Per-month card; Actual card (500-row pull, transfers excluded); Cash forecast link | `text-summary-*`, `card-actual-this-month`, `Link href="/forecast"` | 567-607, 898-1005 | Y | link missed |
| BL-12 | Health check: name-match double count; unlinked debt minimum without a due day | `bills-health-check`, `health-issue-duplicate`, `health-issue-no-date` | bhc 12-163 | Y | listed; **no test** (census correct) |
| BL-13 | Skeleton while `!summary` (a failed load shows the skeleton forever) | — | 618-626 | partial | missed |

**Overview and `/bills/all` can disagree:** the overview reads the server's debt minimum, outflow and net; `/bills/all` recomputes them client-side after the payoff filter (bl 645-652), with an unclamped extra (bl 545-549). `buildPayload` never sends `amountKind` (bl 203-224), so a classic save may reset an "estimate" bill — server behaviour unchecked.

Tests: `billsOverviewSpine`; `billsCategoryPicker`, `billsOneTimeMove`, `billsDebtMinFilter` (census omitted it), `billsRowAmount`. E2E: 8 `bills-*`.

### 2.11 `/budget` — `pages/budget.tsx` (2,081) + `budget/allowanceCard.tsx` (252), `budget/planSources.ts` (136), `budget/planStrip.tsx` (132)

Census line count "2081 + 384" omitted `planSources.ts`; the sub-folder is 520 lines.

| ID | Capability | Proof | budget.tsx line | Exists | Census |
|---|---|---|---|---|---|
| BU-01 | Month prev/next, floor April 2026 | `changeMonth(±1)`, `button-prev-month`/`button-next-month`, `MIN_MONTH="2026-04-01"` | 242, 374-397, 779-802 | Y | listed; floor missed |
| BU-02 | Month in the URL | `?month=YYYY-MM-01`, `navigateRoot('/budget?…',{replace:true})` | 260-277, 392-394 | Y | **missed** |
| BU-03 | Adjacent-month prefetch | `prefetchQuery(getGetBudgetMonthQueryKey(±1))` | 293-310 | Y | missed |
| BU-04 | Pin / unpin the month | `handleTogglePinMonth` → `usePinBudgetMonth`, `button-toggle-pin-month`, toasts | 453-473, 804-822 | Y | listed; no test touches it |
| BU-05 | Line pin, automatic only | `handleAutoPinLine` → `usePinBudgetLine` from `handleBlur` when the source is bills/derived; badge `badge-pinned-${id}`. **No per-line pin control exists** (comment 476-483) | 484-490, 1162-1168 | Y (auto) | **wrong framing** ("pinned line" as a control) |
| BU-06 | Planned edit | `input-planned-${categoryId}` commits **on blur only** → `handleUpdatePlanned` → `useUpsertBudgetLine` | 1188-1203, 1155-1169 | Y | **wrong**: no Enter/Escape on this field |
| BU-07 | Avalanche row read-only | chip "Managed by Avalanche" | 1171-1178 | Y | missed |
| BU-08 | "Where did this amount come from?" popover | `button-planned-source-${id}`, kinds pinned/derived/bills, `planned-source-bill-list`, `planned-source-bill-${billId}` | 1206-1313 | Y | listed; **evidence wrong** — the pinning e2e is `bills-category-picker-and-hand-planned.spec.ts:158`, not `budget-popovers-and-mapping-edit` |
| BU-09 | Categorize uncategorized | `button-categorize-${id}`, `uncategorized-list-${id}`, `button-assign-${tx}-to-${cat}` → `handleAssignTxn`; Suggested ≤25 (rule match or name ≥3 chars), Other ≤50 | 1690-1756, 563-587 | Y | listed; ranking and caps missed |
| BU-10 | Category-name drilldown | `button-category-name-${id}` → `pickCategoryDrillDownHref`: `/amex?category=&month=` when Amex count > Bank, else `/transactions?category=&month=`; `icon-drilldown-amex-*`/`-transactions-*`, `data-drilldown-target` | 42-52, 1578-1659 | Y | icons listed; routes, params, tie rule missed |
| BU-11 | Source chips Bank/Amex/Other | `badge-source-{bank\|amex\|other}-${id}` | 1660-1669 | Y | **wrong**: census calls bills/pinned/derived/manual the "source badges" |
| BU-12 | Actuals popover with running totals | `button-actuals-${id}`, `actuals-split-*` (posted/pending), `actuals-row-*` (first 25), `actuals-running-*`, `actuals-hidden-tail(-sum)-*` | 1810-1981 | Y | listed |
| BU-13 | Drill tie rule | `txnsByCategoryThisMonth` skips transfers and replaced pendings, maps inherited categories; month pull `limit: 200` | 533-558, 330-334 | Y | missed |
| BU-14 | View all | `button-view-all-${id}` (same href as BU-10) | 1951-1960 | Y | listed |
| BU-15 | Inline re-categorize | `ActualsRowReassignPicker`, `button-reassign-${tx}`, `item-reassign-${tx}-to-${cat}` → `handleReassignTxn` | 1381-1451, 595-604 | Y | listed |
| BU-16 | Undo re-categorize | `action-undo-reassign-${txId}` | 605-635 | Y | listed; **only e2e pins it** (`budgetInlineCategorize` tests assign, not reassign) |
| BU-17 | Add envelope (My budget) | `button-add-line-My budget`, `input-new-line-My budget` (Enter/Esc), `handleAddCategory` → `useCreateCategory` | 1069-1127, 426-451 | Y | listed |
| BU-18 | Rename envelope | `button-rename-${id}`, `input-rename-${id}` (Enter/blur commit, Esc cancel), 409 duplicate toast | 1596-1626, 706-728 | Y | listed |
| BU-19 | Delete envelope with warning | `button-delete-${id}`, native `confirm()` with count and total | 663-699, 1785-1796 | Y | listed |
| BU-20 | Seed default budget (automatic, once) | `useSeedDefaultBudget`, `seededRef` | 347-372 | Y | hook listed; behaviour missed |
| BU-21 | Hero: planned, basis, committed bar | `budget-hero`, `hero-planned`, `hero-basis`, `hero-committed-bar` | 764-771, 831-894 | Y | listed |
| BU-22 | Tiles Spent / "Left over" / Income | `tile-spent`, `tile-left-to-earn` (label "Left over"), `tile-income` | 856-879 | Y | listed (label differs) |
| BU-23 | Plan strip | `StackBar` in `planStrip.tsx`, `budget-plan-strip`, `plan-strip-total/-allowance/-unbacked` | planStrip 28-110 | Y | listed |
| BU-24 | Sections by source + verdicts | `PLAN_SECTIONS` income/bills/debts/unbacked, `section-*-verdict`, sort by planned → actual → name, empty sections hidden | planSources 36-136; 905-1064 | Y | "envelope grid" listed; verdicts/sort missed |
| BU-25 | Row state chip + meter | `pct-direction-${id}`, `CssFillMeter` | 1546-1567, 1989-2025 | Y | implicit |
| BU-26 | Analysis strip + pace | `analysis-strip-${id}`, `actual-pending-${id}`, `analysis-pace-${id}` (±5 % = on pace; **inline code, not a lib**) | 2027-2078 | Y | listed |
| BU-27 | Allowance card + Manage link | `section-allowance`, `allowance-total`, `allowance-pending-total`, `allowance-row-*`, `allowance-slice-*`; `budget-allowances-manage` → `/allowances` | allowanceCard 45-229 | Y | listed; pending + Manage missed |
| BU-28 | Basis note | `budget-basis-note` | 970-978 | Y | missed |
| BU-29 | Loading / stale / error | skeleton on cold load; stale via `keepPreviousData`; **no error state** | 742-750 | partial | missed |

Counts: 21 user actions + 3 automatic; 4 popovers + 1 `confirm` + 1 undo toast; **0 recharts** (StackBar, hero bar, `CssFillMeter`); 0 filters; 3 route drilldowns + 3 in-page; persisted: URL `month`, server month/line pins. Tests: 6 unit (`budgetAnalysisStrip`, `budgetCategoryDrillDown` — census omitted it —, `budgetEnvelopeGrid`, `budgetInlineCategorize`, `budgetMyBucket`, `budgetPendingOnce`) + helper `__test-helpers__/budget-month.ts`; 8 `budget-*` e2e + `bills-category-picker-and-hand-planned` and `a11y-smoke`.

Census §6 correction: `/budget` imports none of `bucketSpend`, `weeklyStreak`, `discretionarySpend`; its allowance figures are server data (`budgetData.allowance`, 754).

### 2.12 `/allowances` — `pages/allowances.tsx` (1,304) + `components/split-transaction-dialog.tsx` (233)

**The census got the page's unit wrong.** There are no per-person cards; the page is one card per **bucket** (weekly, monthly, unplanned) for the household (`BUCKETS`, 241-245). Per-person allowances exist only in the new app's `PlanWeek` ("Personal allowances").

| ID | Capability | Proof | allowances.tsx line | Exists | Census |
|---|---|---|---|---|---|
| AL-01 | Bucket cards (weekly / monthly / unplanned) with state | `BucketCard`, `allowance-card-${slug}` (expand, `aria-expanded`), `allowance-state-${slug}` No target / Over / Near cap (≥85 %) / Under | 241-272, 433-640, 1106-1134 | Y | **wrong** ("per-person") |
| AL-02 | Week navigation (weekly card) | `weekPrev`/`weekNext`, aria "Previous period"/"Next period", **no testid**, cannot pass this week | 487-513, 670-672 | Y | listed |
| AL-03 | Month navigation (monthly + unplanned share `monthStart`) | `monthPrev`/`monthNext` | 673-680 | Y | missed |
| AL-04 | Planned edit popover | `allowance-edit-planned-${slug}`, `input-planned-${slug}` (Enter saves). Weekly writes a **per-week override** `preferences.weeklyAllowanceOverrides[weekSundayISO]`; monthly/unplanned write `monthlyAllowanceAmount`/`unplannedAllowanceAmount` via `useUpdateSettings` | 466-474, 548-611, 756-798 | Y | listed; per-week semantics missed |
| AL-05 | Legacy override migration | localStorage `h2:weekly-allowance-overrides` read once, merged (server wins), then removed | 704-752 | Y | missed |
| AL-06 | Planned per window | weekly = override else `weeklyAllowanceAmount`; monthly/unplanned = month amount | 864-881 | Y | missed |
| AL-07 | Actual per window | `bucketSpend.expenseMagnitude` only; weekly by effective bucket, monthly/unplanned by raw flags. **Transfers, card payments, reimbursables are not excluded** (the test admits it, `allowancesKitRestyle.test.tsx:146-149`) | 247-251, 884-918 | Y | "bucketSpend" listed; only `expenseMagnitude` used |
| AL-08 | Per-card variance | `allowance-variance-${slug}` | 620-636 | Y | listed |
| AL-09 | 8-week money-left bars | `weeklyVarianceSeries` → `CssBars mode="delta"` (aria-label, **no testid**), time-ordered | 213-235, 973-997, 1136-1165 | Y | **wrong**: census "Charts 0" and testid `allowance-variance-*` |
| AL-10 | Over streak / praise | local `weeklyOverStreak`/`weeklyUnderStreak` (26-week walk, `STREAK_MIN=2`), `allowance-over-streak`, `allowance-praise` | 137-209, 920-942, 1083-1100 | Y | listed; **helper wrong** (not `lib/weeklyStreak`) |
| AL-11 | Breakdown collapsibles | `allowance-bucket-${key}` | 1052-1061, 1167-1235 | Y | missed |
| AL-12 | Groups | `allowance-group-${key}`: weekly by sub-bucket, monthly/unplanned by category | 368-429, 999-1050 | Y | listed |
| AL-13 | Transaction row | `allowance-txn-${id}` | 276-366 | Y | missed |
| AL-14 | Bucket select (weekly rows) | `allowance-bucket-select-${id}` → `changeWeeklyBucket` PATCH `weeklyBucket` | 306-326, 802-818 | Y | listed |
| AL-15 | Category select (monthly/unplanned rows) | `allowance-category-select-${id}` → `changeCategory` | 327-347, 822-835 | Y | listed |
| AL-16 | Split purchase | `allowance-split-${id}` on every bucket's rows → `SplitTransactionDialog`: parts with `split-amount-${i}` + bucket select, Add/remove part, "Splits add up ✓"/"$X left"; valid = ≥2 parts, all > 0, sum within 1¢. Writes: `useCreateTransaction` for parts 2..N (`source:"manual"`), then PATCH the original (**moves a monthly/unplanned row to weekly**) | 348-359, 1295-1301; split 45-233 | Y | listed; fields, writes, side-effect missed; **no test** |
| AL-17 | Over/under summary table | `allowance-summary-${key}` | 1237-1293 | Y | missed |
| AL-18 | Pending totals | none on this page (they are on `/budget`'s allowance card) | — | **N** | **wrong** |
| AL-19 | Loading / error | none; empty notes only | 843-850 | **N** | — |

Behaviour finding (not a census item): the transaction pull is the selected week ∪ month (`limit: 500`, 840-849), and the 8-week bars and streak walks run over that same window, so earlier weeks read as "full plan left" and streaks stop early. Tests do not catch it (the mock ignores params).

Counts: 13 page actions + 6 split-dialog actions + 1 automatic; 1 popover, 1 dialog, 3 `Help`; 0 recharts (1 `CssBars`, 3 `CssFillMeter`); 0 filters; 0 route drilldowns; persisted: legacy localStorage key + 4 settings fields. Tests: 1 unit (`allowancesKitRestyle`, 18 tests; it mocks the split dialog to null), **0 e2e**, not in `a11y-smoke`.

### 2.13 `/mapping-rules` — `pages/mapping-rules.tsx` (2,483) + `mapping-rules/SortableRuleRow.tsx` (225), `CategoryDropTarget.tsx` (42), `components/rule-matches-preview-dialog.tsx` (147), `hooks/use-bulk-recategorize-prompt.tsx`

A `MappingRule` has only pattern, matchType, categoryId and priority (`lib/api-client-react/src/generated/api.schemas.ts:3418-3449`); amount bands and account scope exist only on learned rules.

| ID | Capability | Proof | mapping-rules.tsx line | Exists | Census |
|---|---|---|---|---|---|
| MR-01 | Load rules + categories, hide `excludeFromBudget` categories everywhere | `useListMappingRules`, `useListCategories` (SLOW_CACHE 30 min) | 220-230 | Y | listed; filter missed |
| MR-02 | Loading / empty / no-match states | `PageSkeleton` cold only; "No rules yet…"; "No rules match your search." | 1720, 2009-2014, 2180-2183 | Y | missed |
| MR-03 | Error state | **none**: a failed rules query reads as "No rules yet" | 1720, 2009 | **N** | gap |
| MR-04 | Add rule | match type (contains / exact "Equals exactly" / starts_with), `input-add-pattern`, category select ("Select Category"), `btn-add-rule` → `handleAddRule`; **no priority field** — priority = max(existing,100)+10 | 744-790, 1751-1799 | Y | listed; auto-priority missed |
| MR-05 | Optimistic create/update/delete/reorder with rollback | `beginOptimistic`/`rollback`, temp ids | 243-397 | Y | missed |
| MR-06 | Live add preview (debounced 300 ms) | `usePreviewMappingRuleRecategorizeByPattern`, `rule-add-preview`, `rule-add-preview-count` | 692-742, 1813-1876 | Y | listed |
| MR-07 | "Show matches" dialog (add) | `link-show-rule-matches-add` → `RuleMatchesPreviewDialog` (its Apply only closes) | 1851-1874, 2466-2479 | Y | **wrong**: census credits `useBulkRecategorizePrompt` |
| MR-08 | Add with fresh preview → bulk move + undo | `recategorizeBulk.mutate({fromCategoryId:null})`, toast with `action-undo-add-rule-bulk` → `useUncategorizeTransactionsByIds` | 552-672 | Y | missed (only its e2e listed) |
| MR-09 | Add without preview → "Apply to past too?" toast | `offerBulkRecategorize`, `action-apply-rule-past` (no undo on this page) | 538-550 | Y | listed |
| MR-10 | Edit rule | `rule-edit-btn-${id}` → `startEdit`; pattern, match type ("Exact"), `rule-edit-category-${id}`, `rule-edit-priority-${id}`; `rule-save-${id}` → `saveEdit`; Cancel | 1054-1257, 2262-2329 | Y | listed; Cancel/pattern/type missed |
| MR-11 | Edit preview | `handleEditCategoryChange` → `usePreviewMappingRuleRecategorize`, `rule-edit-preview-${id}`, `link-show-rule-matches-edit-${id}` | 1083-1111, 2355-2403 | Y | listed (testid un-templated) |
| MR-12 | Edit save → bulk move + undo (rows **and** rule) | `action-undo-bulk-recategorize-edit` | 1146-1253 | Y | missed |
| MR-13 | Delete with undo | `rule-delete-${id}` → `handleDeleteRule`; `action-undo-delete-rule-${id}` → restore (no re-prompt) | 1004-1052 | Y | listed |
| MR-14 | Test a description | `input-test-description` (Enter), `btn-run-test` → `handleRunTest` → `useTestMappingRules`, `btn-clear-test`, `test-result`, row chips Winner/Match | 1671-1715, 1880-1958 | Y | listed; **no client test** |
| MR-15 | Search | `input-search-rules` (pattern, category, match type), "N total · M shown" | 1545-1557, 1994-2071 | Y | listed |
| MR-16 | Per-category cards | `rule-category-cards`, `rule-category-card-${key}` (`data-collapsed`), A→Z, uncategorized last, each list `max-h-80` scroll box | 1576-1600, 2185-2244 | Y | listed |
| MR-17 | Collapse one / all, persisted | `rule-category-card-toggle-${key}`, `rule-collapse-all`; localStorage `h2budget:mappingRules:collapsedCategories` | 175-201, 488-500, 2034-2065 | Y | listed; key missed |
| MR-18 | Bulk select | `rule-select-${id}`, `rule-select-all` (visible rows, tri-state) | 1607-1669, 2079-2092 | Y | listed |
| MR-19 | Bulk change category + undo | `rule-bulk-change-category` → `handleBulkChangeCategory`; `action-undo-bulk-change-category` | 899-1002, 2096-2122 | Y | listed |
| MR-20 | Bulk delete + undo | `rule-bulk-delete` → `handleBulkDelete`; `action-undo-bulk-delete-rules` | 803-891, 2124-2134 | Y | listed |
| MR-21 | Bulk clear | `rule-bulk-clear` | 2135-2143 | Y | listed |
| MR-22 | Drag to reorder within a card | handle `rule-drag-${id}` → `handleDragEnd` → `reorderWithinCard` → `useReorderMappingRules`; off during search/focus | 1263-1301, 1425-1446 | Y | listed; **no client test** |
| MR-23 | Up / down buttons | `rule-up-${id}`/`rule-down-${id}` → `moveRule` | SRR 141-170; 1303-1317 | Y | listed; **no test** |
| MR-24 | Priority number on row | `rule-priority-${id}` | SRR 172-178 | Y | missed |
| MR-25 | Drag a rule onto a category chip + undo | `category-drop-strip`, `category-drop-${id}` (`data-drop-over`), `action-undo-rule-reassign` | 1339-1423, 2147-2172 | Y | listed |
| MR-26 | Sensors pointer / touch / **keyboard**, custom collision, DragOverlay | `PointerSensor` dist 4, `TouchSensor` 200/8, `KeyboardSensor`; `pointerWithin`→`closestCenter`; `rule-drag-overlay` | 213-217, 1319-1327, 2446-2461 | Y | touch listed; rest missed |
| MR-27 | `?focus=` deep link | `data-focused`, 4 s ring, scroll to first | 1469-1484, 1686-1709 | Y | listed |
| MR-28 | Focus pill with "Show only these" filter, dismissal persisted | `focus-pill`, `focus-pill-toggle`, `focus-pill-dismiss`; localStorage `h2budget:mappingRules:dismissedFocusBatches` (cap 50) | 117-166, 1502-1565, 1960-1990 | Y | pill listed; toggle + key missed |
| MR-29 | Error toasts on every write | Couldn't add/update/delete/reorder/reassign/restore/undo | 276-1420 (9 sites) | Y | missed |

Inbound links: `?focus=<id>` from `matched-rule-chip.tsx:59` (Amex mobile rows, new-transaction picker, bulk prompt) and `transactions.tsx:1006`; multi-id `?focus=a,b` from `use-plaid-sync.tsx:583` and `settings.tsx:503`; plain links from Settings, layout More, landing More. **Budget has no link here** (census implied one).

Census corrections: the reorder priority `(N - idx) * 10` is only the optimistic client value (370-375); the server writes `omittedMax + 10·(N+1) − 10·i` (`api-server/src/routes/mapping.ts:179-190`). `useRuleActionUndo`, `ruleActionMessage`, `rule-attribution-summary` are not used by this page (they serve Chase, Amex, sync and import toasts). The new app's Rules screen **does** show user rules ("Rules you wrote", `h2/screens/activity/RulesView.tsx:170-238`), sorted ascending by priority — the opposite of classic.

Counts: ~30 actions (23 buttons + inputs, 7 toast actions); 2 dialogs mounted, 1 reachable; 2 filters (search, focus toggle); 2 drag interactions; 2 localStorage keys + URL `focus`. Tests: 6 unit, 9 `mapping-rules-*` e2e (+4 specs that touch the page). Untested on the client: test-a-description, up/down, drag-reorder, pill toggle, keyboard drag.

### 2.14 `/settings` — `pages/settings.tsx` (1,447) + `plaid-link-button` (928), `plaid-reconnect-button` (460), `plaid-sync-history` (423), `owner-invitations` (389), `owner-bank-health-sweep` (189), `post-link-debt-dialog` (269), `post-link-progress` (211)

Census header errors: `plaid-reauth-banner`, `debt-plaid-link` and `sync-button` are **not used on this page** (they serve Chase, Amex, Forecast, Avalanche, Debts, Command center). Section order: header + env chip → Mapping rules card → Members & invitations (owner) → Bank-login health check (owner) → **Allowances** → Banks → Weekly bucket names → Trackers → Workbook import → Privacy.

| ID | Capability | Proof | line | Exists | Census |
|---|---|---|---|---|---|
| ST-01 | Cold skeleton; Plaid env chip | `PageSkeleton`; `badge-plaid-env` | 526-544 | Y | chip listed |
| ST-02 | Mapping rules card | `card-mapping-rules` | 547-565 | Y | listed |
| ST-03 | Owner: invite (email check), resend, revoke (`confirm`), members table, remove member (`confirm`), status badges | `form-invite`, `input-invite-email`, `button-send-invite`, `button-resend-*`, `button-revoke-*`, `table-members`, `badge-owner-*`, `button-remove-member-*` | owner-invitations 62-383 | Y | resend/revoke/members **missed** |
| ST-04 | Owner: bank-login health sweep with scanned/flagged/sample/alert | `button-run-bank-health-sweep`, `useRunPlaidMalformedTokenSweep`, `text-sweep-*` | owner-bank-health-sweep 45-185 | Y | results missed |
| ST-05 | **Allowances form** (weekly / monthly / unplanned amounts, required; `primaryAccount` passed through) | `useUpdateSettings`, `allowance-form-error` | 103-108, 353-374, 571-620 | Y | **missed (whole section)** — the new app has no equivalent |
| ST-06 | Link a bank; reauth guard dialog on a fresh link; OAuth hand-off keys; post-link poll (9 tries ≈ 91 s); inline progress panel; "Add these as debts?" dialog (names editable, Add all/selected, "View on Avalanche" toast) | `button-link-bank`, `dialog-reauth-guard`, localStorage `h2:plaid:link_token`, `h2:plaid:return_to`, `panel-post-link-progress` (`data-phase`), `dialog-post-link-debts` | plaid-link-button 47-927; post-link-debt-dialog 100-268 | Y | panel + dialog listed; guard, keys, poll missed |
| ST-07 | Not-configured banners; non-prod cleanup (**dev only**, `confirm`); "No banks linked yet." | `text-plaid-not-configured`, `banner-non-prod-cleanup`, `button-cleanup-non-prod` | 634-716 | Y | cleanup listed |
| ST-08 | Check disconnect dates now | `handleRefreshConsentExpirations`, `button-refresh-consent-expirations` | 210-249, 724-747 | Y | listed |
| ST-09 | Duplicate count + merge (`confirm`) | `useGetDuplicateTransactionCount`, `useDedupeTransactions`, `badge-duplicate-transaction-count`, `button-dedupe-transactions` | 150-156, 258-296, 749-791 | Y | listed |
| ST-10 | 90 s refetch while preparing; seed rows never "needs reconnect" | `refetchInterval`, `isSyntheticPlaidItem` | 116-140, 799-801 | Y | missed |
| ST-11 | Per bank: needs-reconnect badge with dated reason, still-preparing + elapsed, last synced (absolute + relative), disconnect date checked + stale chip (3 days), stalled hint (6 h), last error / consent error | `badge-needs-reconnect-*`, `badge-still-preparing-*`, `text-last-synced-*`, `text-consent-refreshed-*`, `badge-consent-refresh-stale-*`, `text-preparing-stalled-*`, `text-last-sync-error-*` | 816-1015 | Y | badges listed; rest missed |
| ST-12 | Per bank: Re-enable refresh, Reconnect (update mode; 409 relink fallback; #794 fallback after a still-failing sync), Sync now (free), Force refresh (billable) | `button-reenable-refresh-*`, `button-plaid-reconnect-*`, `button-sync-*`, `button-force-refresh-*` | 956-1051; prb 229-375 | Y | #794 fallback missed |
| ST-13 | Unlink: `confirm` when healthy, guard dialog (Cancel / Reconnect / Remove anyway; closes itself once healed) when reauth; **no error toast** | `handleUnlink`, `performUnlink`, `dialog-disconnect-guard` | 174-187, 298-327, 1324-1375 | Y | listed; "delete item" is the same action counted twice |
| ST-14 | Sync history (loads on open): sort by time/kind/status, "Failed N of last M", copy request id, pending-cleanup detail, HTTP footer, Reconnect dispatch | `button-toggle-sync-history-*`, `sort-*`, `sync-attempt-copy-request-id-*`, `sync-attempt-cleanup-toggle-*`, `sync-attempt-reconnect-*` | plaid-sync-history 17-408 | Y | sort/summary/footer missed |
| ST-15 | Accounts list per bank; import cutoff date per account (until first sync) | `PlaidImportCutoffPicker`, `useUpdatePlaidImportCutoffDate` | 1077-1103, 1386-1447 | Y | listed |
| ST-16 | Weekly bucket names: the **five sub-buckets** (groceries, dining, alcohol, entertainment, misc), save / reset | `saveBucketLabels`, `resetBucketLabels`; `preferences.weeklyBucketLabels` | 376-399, 1109-1147 | Y | **wrong** ("renamable Wk/Mo/UN"); on-page help says "four" |
| ST-17 | Days-since trackers: add / remove / edit, regex validation blocks Save, save / reset | `addTracker`, `removeTracker`, `saveTrackers`, `resetTrackers`, `tracker-value-error-*`, `tracker-save-blocked`; `preferences.daysSinceTrackers` | 401-460, 1149-1261 | Y | listed — **but nothing reads the saved trackers** (no web or API consumer; Behavior uses the server's fixed buckets) |
| ST-18 | Workbook import (.xlsx) with counts + attribution toast → `/mapping-rules?focus=`; sample `public/sample/Hubele_Family_Budget_v36.xlsx` | `handleFileUpload`, `useImportWorkbook`, `button-toast-view-import-matched-rules` | 462-522, 1275-1294 | Y | listed (census line ~1288 correct) |
| ST-19 | Privacy copy | `Foot` | 1298-1322 | Y | missed |
| ST-20 | Theme, sign-out, version on this page | — | — | **N** | n/a |

Silent failures: unlink, allowance save, bucket save and tracker save have no error toast. Counts: 41 actions; 3 dialogs + 5 `confirm()` + the Plaid modal; 2 owner sections; 1 dev-only control; 2 localStorage keys + 6 server fields; 0 filters (census ~4). Tests: 6 page tests (all `vi.mock` a fixed hook list and two component paths — any new hook on the page breaks all six), 15 component tests, `use-plaid-sync`, 2 lib; 4 e2e (2 open `/settings`). Untested: unlink/guard, force refresh, re-enable, cutoff, bucket labels, allowance form, env chip, invite/member actions, `PostLinkDebtDialog`.

### 2.15 `/plaid-oauth` — `pages/plaid-oauth.tsx` (170)

| ID | Capability | Proof | line | Exists | Census |
|---|---|---|---|---|---|
| PO-01 | Resume Link from the stored token; exchange | `useExchangePlaidPublicToken`, `usePlaidLink`, keys `h2:plaid:link_token`/`return_to` | 29-52, 105-110 | Y | listed |
| PO-02 | Open-redirect guard `/^\/(?!\/)/`; strips the `/classic` base | — | 38, 63-78 | Y | missed |
| PO-03 | Error state with "Go to Settings"; success toast only (no post-link poll, no debts dialog) | — | 146-156 | Y | missed |

No classic test (the census names the h2 test).

## 3. Shell and cross-cutting — `components/layout.tsx` (729), `tab-ribbon.tsx` (189), `App.tsx` (568)

**Navigation as coded** (`layout.tsx:78-168`). The census's areas and sub-items are right; "footer links" and "navy rail" are not.

| Area (primary) | Ribbon tabs | Owns |
|---|---|---|
| Home `/banking` | Overview `/banking`, Chase `/transactions`, Amex `/amex`, Budget `/budget`, Allowance `/allowances` | `/banking` |
| Forecast `/forecast/overview` | Overview, Forecast `/forecast`, Bills `/bills` (also `/bills/all`) | `/forecast*`, `/bills*` |
| Spending `/reports/spending` | Spending, Budget `/budget`, Allowances `/allowances`, Reports `/reports` | `/reports/spending`, `/budget`, `/allowances`, `/reports` |
| Review `/review` | Review, Chase, Amex | `/review`, `/transactions`, `/amex` |
| Debt `/avalanche` | Debt, Debts `/debts`, Debt report `/reports/debt` | `/avalanche`, `/debts`, `/reports/debt` |
| More (`MORE_NAV`) | Mapping rules, Settings — a desktop dropdown shown **only outside an area**, plus the drawer's More group | — |

Outside every area: `/reports/{cashflow,budget,behavior}`, `/mapping-rules`, `/settings`, `/next/*`, `/plaid-oauth`.

| ID | Capability | Proof | line | Exists | Census |
|---|---|---|---|---|---|
| SH-01 | Top line on every page incl. `/home` | `classic-retiring-banner`; at f5466123 it reads "Modernization preview: Dashboard · Forecast · Accounts · Current app →" | 551-564 | Y | listed (old text) |
| SH-02 | Navy **horizontal** header (`h-12`, not a rail), hidden on `/home` | `app-header` | 568-573 | Y | "rail" wrong |
| SH-03 | Wordmark → `/home` | `brand-home`, `h2-wordmark` | 229-241, 606 | Y | missed |
| SH-04 | Area ribbon: tabs, count badge, underline, hover/focus prefetch, overflow chevrons, ←/→ keys, boundary-aware active tab | `TabRibbon`, `topnav-*`, `data-tabhref`, `ribbon-scroll-left/right` | tab-ribbon 55-183; 177-204 | Y | chevrons/keys missed |
| SH-05 | More dropdown (dead orange dot: `moreBadgeTotal` is always 0) | `topnav-more`, `morenav-*` | 525-538, 619-668 | Y | listed |
| SH-06 | Mobile drawer "Navigation" with areas, nested pages, More, Account; closes on navigate; mobile page title | `button-mobile-menu`, `mobilenav-area-*`, `mobilenav-*`, `mobile-page-title` | 298-388, 576-603, 677-682 | Y | title missed |
| SH-07 | Review badge (phone-only when the ribbon shows Review) | `topnav-review-badge` (`spine.reviewCount`) | 547-548, 683-700 | Y | listed |
| SH-08 | Account menu | `<UserButton />` (header + drawer) | 701, 382-385 | Y | listed |
| SH-09 | Hover query prefetch (7 branches) + idle chunk warm | `prefetch(href)`, `requestIdleCallback` | 417-509 | Y | query branches missed |
| SH-10 | `<main>` is the only scroller; page entrance `.page-in`; content `max-w-[1600px] p-3 md:p-5` | — | 551, 708-726 | Y | missed |
| SH-11 | Version prompt: checks on boot/focus (no polling), self-reload once per session, banner otherwise | `version-update-banner`, sessionStorage `h2:version-self-reloaded` | version-update-prompt 33-137 | Y | listed |
| SH-12 | Mutation invalidation: spine, bank-explain, **every `/api/reports/*`**, ledger + balances; `OWN_INVALIDATION` opt-out | `onWriteSuccess`, `invalidateAfterWrite` | App 117-129; mutationInvalidation 22-85 | Y | reports missed |
| SH-13 | Error boundary per route ("Try again" / "Reload app"); route skeleton; landing skeleton | `page-error-boundary`, `route-loading`, `page-skeleton` | App 393-456 | Y | listed |
| SH-14 | Optimistic shell before Clerk (`h2:auth-hint`); module-scope spine prefetch + one recovery ask; cache cleared on user switch | `askForSpineAgainIfFailed`, `ClerkQueryClientCacheInvalidator` | App 259-303, 413-448, 503-521 | Y | hint/clear missed |
| SH-15 | Query defaults (5 min / 30 min / `keepPreviousData` / retry 1) + FORECAST, TXN, SLOW caches; `window.__qc` | — | App 131-241 | Y | missed |
| SH-16 | App-wide Plaid reconnect listener (`plaid:reconnect`; 409 relink fallback only) | `PlaidReconnectListener` | App 550 | Y | listed ("relink when update mode fails" overstated) |
| SH-17 | Redirects `/`→`/home` or `/sign-in`; `/dashboard`→`/banking`; `/recurring`→`/bills/all` | — | App 377-485 | Y | listed |

`data-state.tsx` exports `moneyFace`, `FreshnessLine`, `RefreshBanner`; the states (cold / loaded / refreshing / refresh-failed / failed, no "empty") live in `lib/queryState.ts` (census wrong). Tests: `appShell.test.tsx` (34 its; reads visibility from **class names** such as `hidden`, `md:hidden`), `routes.test.tsx` (31 rows; hand-typed ribbon table; "no header" on `/home`), `index.css.test.ts`, `dataState`, `useSpine`, `useReviewInboxCount`, `spineRecovery`, `mutationInvalidation`. Untested: version prompt, error boundary, page skeleton, ribbon chevrons/keys, query prefetch, top line, `useLandingWarmup`.

## 4. Dead code, broken links and likely bugs found while reading

None of these is a parity obligation. Each is listed so a restyle neither "restores" dead UI nor silently drops something the owner thinks exists. Fixes that touch queries or money need the owner's OK (CLAUDE.md §1).

| # | Finding | Where | Kind |
|---|---|---|---|
| D1 | Amex: ending-balance tile, set/clear anchor, Refresh from Plaid, month totals, cap hint, filter bar — computed, never rendered | `amex.tsx` 452-511, 590, 660-670, 766-777, 1034-1101 | dead |
| D2 | Amex hide-reviewed is read from localStorage but has no toggle; a stale value hides reviewed rows permanently | `amex.tsx` 252-263, 628 | **bug** |
| D3 | Amex card scope is lost on a cold load for `/next/accounts/:id` and `?accountId=` (filter reset to "all" before options load) | `amex.tsx` 245-247, 759-764 | **likely bug** (read, not run) |
| D4 | Chase: per-row and bulk "send to Review", refresh bank, clear-transfer pill, `StatChip` — dead | `transactions.tsx` 1508-1570, 1821-1948, 2200-2222 | dead |
| D5 | Chase: "Remember" in the row category picker is dropped | `transactions.tsx` 2911 | **bug** |
| D6 | `/forecast#bucket` and `#register` do nothing (`activeTab` never read); Chase links to them in two places | `forecast.tsx` 371-389; `transactions.tsx` 1233, 2540 | broken link |
| D7 | Forecast planned list virtualizes against the **window** above 120 rows, but `<main>` is the scroller; likely blank below the first screen on the 365-day horizon | `PlannedItemsList.tsx` 81-93; `layout.tsx` 551, 709 | **likely bug** |
| D8 | `/review` has no month picker; earlier months' pending bank rows never appear | `forecast.tsx` 674, 871-875 | gap |
| D9 | Saved days-since trackers are read by nothing | `settings.tsx` 401-422 | dead feature |
| D10 | Allowances 8-week bars and streaks see only the selected week ∪ month | `allowances.tsx` 840-955 | **bug** |
| D11 | Allowances actuals do not exclude transfers, card payments or reimbursables | `allowances.tsx` 884-918 | money question for the owner |
| D12 | Bills overview vs `/bills/all` compute debt minimum / outflow / net differently | `bills-overview.tsx` 51-53; `bills.tsx` 645-652 | two answers |
| D13 | `/bills/all` edit coerces quarterly/annual to monthly; never sends `amountKind` | `bills.tsx` 203-229 | **data hazard** |
| D14 | `/next/dashboard` POSTs `/recap/preview` on every open with no `meta`, so the mutation cache invalidates the spine, bank-explain, every report and the ledger on each open (and spends one of six daily recap model calls when AI is on) | `pages/next/dashboard/queries.ts` 84-98 (unchanged at be1f4e86) | **bug** |
| D15 | Layout and landing warm `getDashboard`, which neither `/home` nor `/banking` reads | `layout.tsx` 425-430; `useLandingWarmup.ts` 42-50 | waste |
| D16 | `lib/charts.tsx` `HBar` and `Donut` have no callers; 17 `reportsAnalytics` exports have none | — | dead |
| D17 | Reports hub imports `reportsShared`, which imports recharts statically, contradicting its own "no chart library" comment | `reports.tsx` 15-19 | chunk weight |
| D18 | Page sticky headers use `-mx-4 -mt-4 md:-mx-8 md:-mt-8`, but the shell pads `p-3 md:p-5`: they overshoot 4/12 px (hidden by `overflow-x-hidden`) | forecast 3729, transactions 2314, amex 1821; `layout.tsx` 721 | layout debt |
| D19 | `index.css` says html is the sole scroller; the shell makes `<main>` the scroller, with no `scrollbar-gutter` | `index.css` 356-379; `layout.tsx` 551, 709 | contract drift |
| D20 | New dashboard: "Categories to confirm" links to `/review` (the forecast bank-match inbox), and a loading/failed queue counts as 0 ("Nothing is waiting") | `ReviewPanel.tsx` 25-36 | **bug** |

## 5. Test health

- **E2E is opt-in in CI** (`.github/workflows/ci.yml` job `e2e`, `if: vars.E2E_ENABLED == 'true'`), and has drifted. Specs that assert strings or test ids the source no longer renders (read, not run): forecast 4 (`bulk-match-confident`, `dragging-plans-summary`, `move-date`, `tooltip-mark-missed`; `chart-day0` passes trivially); transactions/chase 9; amex 3; debts 3; bills 2 (`avalanche-locked-row`, `debt-payoff-celebratory-row`). **≈ 21 of 88 specs are stale.** "Its test still passes" is therefore only a real gate for the unit suite until the e2e suite is repaired and enabled.
- Unit tests that pin DOM or classes a restyle will move (keep or deliberately rewrite each, in the same PR): `appShell` (visibility by class), `routes` (ribbon table, "no header" on `/home`), `budgetEnvelopeGrid` (`chip`, `bar-sweep` inline styles), `allowancesKitRestyle` (`chip`, rgb fills, translateY order), `avalanchePagePlan` (`.space-y-3`, `.grid > div`), `avalancheDebtsTable` (cell indexes), `debtsPageRowStability` (`invisible`), `forecastBigBillJump` (`ring-primary`), `forecastReviewBucketShrink` (`max-h-[360px]`), `mappingRulesFocusHighlight` (`ring-brand-navy/50`), `cashFlowForecastMissing` (320 px box, page source path), `reportsPalette` (named exports from page files), `landing` (six tiles, two numbers).
- Tests that mock a fixed list of hooks or modules (adding one import breaks them): the 6 `settings*` tests, the mapping-rules tests (dnd-kit exports and `ui/select`), 4 forecast tests (`vi.mock("recharts")`).
- Capabilities with no test at all: mapping test-a-description, up/down, drag-reorder; allowances split; Amex Add-to-Avalanche and card config; settings unlink/guard, force refresh, re-enable, cutoff, bucket labels, allowance form, invitations writes; bills health check; Debt/Budget/Behavior report renders; version prompt; error boundary.

## 6. Client-side money helpers: callers and tests, verified (replaces census §6)

The census said every helper is called by its page and "all have unit tests in `src/lib`". Neither holds. Callers below are product imports (tests excluded); "direct test" is a test file that imports the module.

| Helper (lines) | Product callers today | Direct test | Correction |
|---|---|---|---|
| `lib/accountBalance.ts` (124) | `amexEndingBalance.ts`, `chaseEndingBalance.ts` | `accountBalance.test.ts`, `chaseScope.test.ts` | No page or `BalanceTrendChart` imports it (census: "Chase, Amex, BalanceTrendChart"). |
| `lib/amexEndingBalance.ts` (346) | `amex.tsx` | `amexEndingBalance.test.ts`, `amexBalanceWindow.test.ts` | Correct. Not imported by `reportsBalances`. |
| `lib/amexBalanceWindow.ts` (197) | `amex.tsx` | `amexBalanceWindow.test.ts` | Correct. |
| `lib/chaseEndingBalance.ts` (175) | **none** | `chaseEndingBalance.test.ts` | **Dead in product code.** The Chase page reads the server ledger (`useGetTransactionsLedgerInfinite` from `@workspace/api-client-react/ledger`, `useGetTransactionsBalances`); ending and running balances are server figures. |
| `lib/chaseScope.ts` (101) | only `chaseEndingBalance.ts` | `chaseScope.test.ts` | Dead with it. |
| `lib/runningBalance.ts` (66) | `amex.tsx` (`computeRunningBalances`), `transactions.tsx` (`compareNewestFirst` only) | `runningBalance.test.ts` | Chase running balance is `tx.runningBalance` from the server ledger (`transactions.tsx:2934`). |
| `lib/effectiveSnapshot.ts` (164) | `transactions.tsx`, `reportsShared.tsx`, `next/Accounts.tsx`, `chaseEndingBalance.ts` | `effectiveSnapshot.test.ts` | Command center and forecast do not import it (census said so). |
| `lib/forecast.ts` (255) | **type only** (`CashEvent`) in `forecast.tsx`, `forecastMatch.ts`, `forecastDebts.ts` | indirect, via forecast lib tests | **`expandAll`, `buildDaily`, `aggregateMonthly` are called by no page.** The projection is the server's cash signal. Census listed them as the forecast's calculations. |
| `lib/forecastMatch.ts` (1045) | `forecast.tsx`, `transactions.tsx`, 8 files in `pages/forecast/*` and `pages/next/forecast/types.ts` | 15 lib tests | Correct; `findCandidates`, `isNeedsReviewStatus`, `suggestPlanMatchesForBank` are internal (not called by pages). |
| `lib/forecastReconcile.ts` (194) | `forecast.tsx` | 3 tests | Correct. |
| `lib/forecastPastDue.ts` (128) | `forecast.tsx`, `ProjectedBalanceChart.tsx`, `next/forecast/*`, `next/dashboard/ForecastPanel.tsx`, `forecastEventKinds.ts` | `forecastPastDue.test.ts` | Correct. |
| `lib/forecastDebts.ts` (259) | `forecast.tsx`, `bills.tsx`, `PlannedItemsList.tsx`, `CashFreedBanner.tsx`, `PlanDropRow.tsx` | `forecastDebts.test.ts`, `billsDebtMinFilter.test.ts` | Not debts page (census: "forecast, bills, debts"). |
| `lib/reportsAnalytics.ts` (965) | Cash flow (`dailyCashFlow`, `rollupByPeriod`, `withRunningNet`, `rolling30DayBurn`, `cashFlowKpis`) and Debt (13 functions incl. `simulate`, `debtToSim`); the hub, Spending, Budget and Behavior import only `fmtISO` | `reportsAnalyticsExclusion.test.ts` (tests the dead `categoryTotals`), `reportsPalette.test.ts` | **17 of 35 exports are imported by nothing**: `categoryTotals`, `spendingHeatmap`, `dayOfWeekSpend`, `topMerchants`, `categoryMonthlyTrends`, `reimbursableSplit`, `daysSinceLast`, `spendByDayOfMonth`, `hourlySpendClock`, `onTrackMonthStreak`, `underBudgetMonthStreak`, `noPurchaseStreak`, `personalityRadar`, `biggest`, `groupBalanceHistory`, `monthRange`, `safeNumber`. Spending, Budget and Behavior figures come from the server facts endpoints. |
| `lib/reportsBalances.ts` (275) | `amex.tsx`, `reportsShared.tsx` | `reportsBalances.test.ts` | Correct. |
| `lib/debtBalance.ts` (81) | `avalanche`, `debts`, `bills`, `forecast`, `reports.tsx`, `reportsShared`, `debt-pending-hint`, `reportsAnalytics` | **none direct**; page-level via `debtBalanceParity.test.tsx` | Census: "all have unit tests". |
| `lib/avalanche.ts` (26) | avalanche, debts, bills, forecast, `CashFreedBanner`, `PlanDropRow`, `forecastDebts`, `reportsAnalytics` | `avalanche.test.ts` | Correct. |
| `lib/bucketSpend.ts` (87) | `command-center.tsx`, `allowances.tsx`, `next/dashboard/SpendingPanel.tsx` | **none direct**; exercised unmocked by `allowancesKitRestyle.test.tsx` | Not budget (census: "budget, allowances, command center"). |
| `lib/weeklyBuckets.ts` (59) | `settings`, `allowances`, `budget/allowanceCard`, `split-transaction-dialog`, `bucketSpend` | **none** | |
| `lib/weeklyStreak.ts` (25) | `command-center.tsx` | `householdWeeks.test.ts`, `householdMonths.test.ts` | |
| `lib/discretionarySpend.ts` (140) | `command-center.tsx`, `next/dashboard/SpendingPanel.tsx` | **none** | `isSplurge` rule for biggest charges is untested at lib level. |
| `lib/uncategorizedSpend.ts` (65) | `reports/SpendingPage.tsx` (the recategorize popover rows only) | `uncategorizedSpend.test.ts` | The banner and hub figure are the server's `facts.uncategorized`. |
| `lib/billsRowAmount.ts` (54) | `bills.tsx` | `billsRowAmount.test.ts` | Correct. |
| `lib/householdDay.ts` (59) | 20+ files | `householdDay.test.ts` (+ tz canary) | Correct. |
| `lib/timeRange.ts` (88) | bills, transactions, command-center, amex, three reports, `reportsShared`, `time-range-toggle`, `chase-insight-strip` | indirect (`householdWeeks/Months.test.ts`) | |
| `lib/daysSinceTrackers.ts` (73) | `settings.tsx` only | **none direct**; page-level `settingsTrackerValidation.test.tsx` | Census: "settings, behavior" — Behavior does not import it. |
| `lib/amexBrand.ts` | `amex-card-band.tsx`, `avalanche-card-config.tsx` | **none** | |

Rule for Wave C: port or restyle with these callers in mind; the two dead Chase helpers are not a parity obligation (the server ledger is), but deleting them is a separate PR.

## 7. CLAUDE.md §2 data rules: existing breaches (do not copy into new panels)

| Pull | Where | Rule |
|---|---|---|
| Amex 12-month trend `limit: 5000` | `amex.tsx:375` | "The `limit=5000` pattern is banned." |
| Amex month `limit: 1000` | `amex.tsx:348` | list views ≤ 100 |
| Command center 90 days `limit: 1000` | `command-center.tsx:242-248` | ≤ 100; aggregates for summaries |
| `/transactions` hover prefetch, 3 years, `limit: 1000` — and the Chase page no longer reads that key | `layout.tsx:468-472` | ≤ 100; no duplicate keys |
| Cash flow `limit: 2000` (discloses its cap) | `CashFlowPage.tsx:111` | allowed exception, disclosed |
| Spending uncategorized `limit: 500`, **no cap disclosure** | `SpendingPage.tsx:98-103` | "A capped pull discloses its cap." |
| Allowances week ∪ month `limit: 500` | `allowances.tsx:848` | ≤ 100 |
| Bills actuals `limit: 500` | `bills.tsx:580` | ≤ 100 |
| Budget month `limit: 200` | `budget.tsx:333` | ≤ 100 |

These are query changes: each needs its own PR and the owner's OK, never a ride-along in a restyle.

## 8. Wave C work breakdown

What exists to build on: `components/next` has `PageGrid`, `Panel` (title, sub, accent, actions, `to`, span 3/4/6/8/12), `StatBlock`, `AccountChip`, `TxnTable`; `index.css` has `.panel`, `.grid-12`, `.span-*` and the `acct-*` tokens; `lib/accountIdentity.ts`. `ui.tsx` (`card`, `cardHead`, `Stat`, `Foot`, `Help`, `Note`, button and table tokens) is already used by every page. The colour work is mostly done: **0 Tailwind palette utilities in any page file** and 8 real hex literals in pages (`reportsShared.tsx:103,120,122`, `SpendingPage.tsx:594,650` `#fff`, `ProjectedBalanceChart.tsx:486,533,604` `#ffffff`), 4 in `lib/charts.tsx`, and the `h2-wordmark` brand constants; most `#NNN` grep hits are issue numbers in comments. Wave C is a **layout and composition** job, not a palette clean-up.

Estimates are builder-hours for one agent builder, including the restyle, test updates, the parity check against the IDs listed, and the PR note. They exclude owner decisions and the §4/§7 fixes, which are separate PRs.

### C0. Shared groundwork — do first (10–14 h)

The existing `Panel` cannot host half the classic pages yet:

1. **Panel variants.** `.panel` is `overflow: hidden` (`index.css:440`), `Panel` always wraps children in `p-4` and always adds the `panel-link` hover lift. A sticky element inside a `hidden` box sticks to the box, not to `<main>`, which is why the B3 embedded ledgers' bulk bars do not stick. Add `flush` (no padding, for tables and ledgers), `sticky-safe` (`overflow: clip` — clips like `hidden` but is not a scroll container, so `position: sticky` descendants still stick to `<main>`) and `static` (no hover lift). Add `ChartPanel` (fixed-height body so `ResponsiveContainer` has a sized parent) and `TablePanel` (flush, header row, optional max-height scroll).
2. **Shell scroll contract.** `<main>` is the only scroller (`layout.tsx:551, 709`); `index.css:356-379` says html is. Pick `<main>`, fix the comment, add `scrollbar-gutter: stable`, and publish `--shell-pad-x/--shell-pad-y` so the three page sticky headers stop hard-coding `-mx-4 -mt-4 md:-mx-8 md:-mt-8` against a `p-3 md:p-5` shell (D18). Publish one `--page-sticky-top` that pages set (today: `pageStickyHeaderRef` on forecast, `--pinned-pane-h` on Chase/Amex).
3. **Window virtualizer.** `PlannedItemsList` uses `useWindowVirtualizer` while `<main>` scrolls (D7); switch to `useVirtualizer({ getScrollElement: () => main })` before the forecast moves.
4. **Codegen sub-module for fold-in hooks.** The generated client lives in the entry chunk (`App.tsx:17`, `layout.tsx:15-25`; `vite.config.ts` gives `lib/` no manual chunk), so every newly used hook grows the landing JS; headroom is at most ≈ 1.9 KB (B1 measured 578.1 of 580 KB; B2 and B3 were measured on their own branches). Tag the fold-in operations in `openapi.yaml` and generate them into `@workspace/api-client-react/features` the way `chase-ledger` is (`lib/api-spec/orval.config.ts:24-58`). Move `usePreviewRecap` and `useGetMoneyPosition` there too (≈ 1 KB back); keep `useListCategorizationReview` in the main module if F1's Review badge, which lives in the entry-resident layout, reads it. Nothing on the entry path may import the sub-module (`lib/mutationInvalidation.ts` and `components/layout.tsx` are on it).
5. **Ported helpers.** `fmtMoney` (null → "—"; classic `formatCurrency` renders null as "$0.00", which breaks "blank, never zero"), `h2/lib/dates.ts`, and a toast with two actions (classic `use-toast.ts:17` takes one; the review queue needs Undo + "Apply to N similar").
6. **Recharts through the kit.** `reportsShared.tsx:12-39` and `account-page/balance-trend-chart.tsx:1-13` import recharts directly, against `lib/charts.tsx:35-37`. Route them through `@/lib/charts` (no bundle change: both are already lazy).
7. **Test policy.** Repair a stale e2e spec in the PR that restyles its page (§5); do not count a stale spec as a passing parity check.

### C1. Reports hub + five reports (22–28 h)

- **Keep:** RH-01…07, RS-01…12, RC-01…10, RD-02…06, RB-01…06, RBH-01…06. The figures read server facts; the restyle must not move Spending/Budget/Behavior onto client maths.
- **Shares today:** `ui.tsx` (`Stat`, `Foot`, `Help`, `card`/`cardHead` via `ChartCard`/`PanelCard`, `cardButton` hub tiles), `components/viz` (hub only), `lib/cssBars` (`CssBars`, `CssFillMeter`), `lib/charts` (`LineTrend`, Budget only), `time-range-toggle`. No `components/next`.
- **Composition:** replace `ChartCard`/`PanelCard` with `ChartPanel`/`Panel` and `ReportShell` with `Page` + crumbs + a controls row. Hub: balance tiles as 4 × `StatBlock` (span-3), report tiles as `Panel to=` (span-4, 2 rows). Spending: 4 KPIs span-3; banner span-12; Top categories span-6 + Reimbursable span-6; heatmap span-12; Day of week span-6 + Top merchants span-6; trends span-12. Cash flow: clip note + 4 KPIs; Income vs expense span-12; Net span-12; Burn span-4 + Forecast span-8; Money flow span-6 + Rolling burn span-6. Debt: 4 KPIs; Paid off span-4 + per-debt table span-8; History span-6 + Timeline span-6; Waterfall span-6 + Interest span-6; Payoff order span-6 + Months remaining span-6. Budget: 3 KPIs; Day-to-day span-8 + Pace chart span-4; Bills span-6 + Paychecks span-6; Streak board span-12. Behavior: Days since span-4 + 6 stats span-8; streaks span-6 + Day of week span-6; Largest movements span-12.
- **Risks:** `ResponsiveContainer` needs the fixed inline height (`cashFlowForecastMissing` pins the 320 px box and reads `src/pages/reports/CashFlowPage.tsx` by path — moving the file breaks it); the Day-of-week card grows 190 → 300 px on click and misaligns its row neighbour; `hideWhenEmpty` returns null and leaves holes in 2-up rows (let the survivor take span-12); SVG gradient ids collide if a chart renders twice (`forecastGrad`, `burn-gradient`, `past-balance`, `payoff-<id>` — use `useId`); the hub's `reports-tile-amex` `title` attribute is asserted by e2e; `reportsPalette` imports named exports from four page files.
- **Add:** render tests for Debt, Budget and Behavior (none today).

### C2. Budget (10–12 h)

- **Keep:** BU-01…29 (BU-05 auto-pin only; BU-06 blur-commit; BU-10 drill rule and params; BU-16 undo).
- **Shares today:** `ui.tsx` (12 tokens incl. `Stat`, `Foot`, `Help`, `inputInline`), `CssFillMeter`, `MoneyText`, `StackBar`, `CHART`, `ui/popover` + `ui/command` + toast. No recharts — keep it that way (`budget.tsx:98-100` avoids `lib/charts` on purpose).
- **Composition:** header row (month stepper, pin) in the page head; hero span-8 + plan strip span-4; tiles as 3 × `StatBlock` inside the hero panel; each `PlanSection` a flush `TablePanel` span-12 (Income and the allowance card can sit span-6 + span-6 on desktop); basis note as the page `Foot`.
- **Risks:** `budgetEnvelopeGrid` asserts `chip`/`bad`/`gray` classes, `.bar-sweep` inline width/background and `grow-x`; `budgetInlineCategorize` asserts innerHTML order; `budgetMyBucket` asserts move controls are absent. The hover-revealed row controls (`[@media(hover:hover)]`, `budget.tsx:214, 1216`) must survive the row restyle. `ROW_GRID` is viewport-responsive, not container-responsive, so a span-8 placement needs a container query.

### C3. Allowances (6–8 h)

- **Keep:** AL-01…17. Do not invent per-person cards (they belong to the fold-in of PlanWeek, not this page).
- **Shares today:** `ui.tsx` (14 tokens incl. `th`/`td`/`tdNum`), `CssBars`, `CssFillMeter`, `ui/collapsible`, `ui/select`, `ui/popover`; the split dialog is off-kit shadcn (`Button`, `Input`, `text-muted-foreground`).
- **Composition:** three bucket panels span-4 (accent none; state chip in `actions`); 8-week bars span-6 + breakdown span-6; summary `TablePanel` span-12; restyle the split dialog onto `ui.tsx` tokens.
- **Risks:** `allowancesKitRestyle` asserts `chip` classes, rgb fills on `.bar-sweep`, a `span[style*='left']` marker and **oldest-first order by `translateY`**; it mocks the split dialog, so the restyled dialog needs its first test. D10/D11 are money questions for the owner, not restyle work.

### C4. Bills overview + all bills (8–10 h)

- **Keep:** BO-01…04, BL-01…13.
- **Shares today:** `ui.tsx`, `data-state` `RefreshBanner` (overview), `CssBars` (overview), `time-range-toggle`, `ui/dialog`, `ui/select`, `ui/skeleton`. Neither page uses `Page`.
- **Composition:** overview: 2 `StatBlock`s span-3 + refresh banner; month card span-4 + biggest bills span-8. All bills: head row (month picker, Add) + 3 stats; main column span-8 (due window, health check, income, bills, debt minimums, archived as stacked panels), side column span-4 (per month, actual, forecast link). Keep both routes (both are in the nav).
- **Risks:** e2e asserts `text-brand-navy`/`text-neutral-500` and an svg count on the actual-vs-planned row, exact minus signs ("-$300.00" vs "−$300.00") and heading `/^bills$/i`; `billsOneTimeMove` asserts button text; D12/D13 stay out of the restyle.

### C5. Debts (2–3 h + 1 h e2e repair)

- **Keep:** DB-01…08.
- **Shares today:** `ui.tsx` (`Page`, `Stat`), `debt-pending-hint`, `DebtReauthBanner` from `debt-plaid-link`, `page-skeleton`.
- **Composition:** 3 `StatBlock`s span-4; creditors `TablePanel` span-12.
- **Risks:** `debtsPageRowStability` asserts the `invisible` reserved slots; the three `debts-*` e2e specs wait for a heading that does not exist (fix them here). Whether Debts survives next to Avalanche is the owner's call (census open question 4).

### C6. Avalanche (12–15 h)

- **Keep:** AV-01…23 (AV-20 the ⋯ menu is the only edit path; AV-15 card config; AV-22 chart tab).
- **Shares today:** `ui.tsx`, `lib/charts` (`LineTrend`, `CHART`), `CssBars`, `ui/slider`, `ui/select`, `ui/dialog`, `ui/tabs`, `debt-plaid-link` (menu, picker, banner — shared with Debts), `avalanche-card-config`, `add-card-to-avalanche` (also in the Amex band), `avalanche-schedule-card` (also on Forecast).
- **Composition:** hero span-8 + 4 stats span-4; payoff-order bars span-6 + this month span-6; Extra span-6 + Strategy span-6; next 3 moves span-6 + schedule span-6; card config span-12 (card accents via `AccountChip`); tabs panel span-12 (Debts table flush; Projection; Chart in a `ChartPanel`; Archived).
- **Risks:** `avalanchePagePlan` asserts `.space-y-3` and `.grid > div`; `avalancheDebtsTable` asserts cell indexes 0–4 and row order; `avalancheHeroPayoff` asserts `.bar-sweep`; every avalanche test stubs the weekly payoff, so AV-15 has no coverage — add it; `debt-plaid-link` restyle reaches `/debts`.

### C7. Mapping rules (10–12 h; learned rules fold-in is F2)

- **Keep:** MR-01…29.
- **Shares today:** `ui.tsx` (11 tokens), `ui/toast`, `ui/checkbox`, `ui/select`, `ui/dialog`, `page-skeleton`, `RuleMatchesPreviewDialog`, `use-bulk-recategorize-prompt`, `@dnd-kit/{core,sortable,utilities}` (`vendor-dnd`).
- **Composition:** Add a rule span-8 + Test a description span-4; focus pill + search row span-12; one span-12 `Panel` (sticky-safe, static) that holds the single `DndContext`: controls + bulk bar + drop strip on top, category cards in an inner 2/3-column grid. Learned rules (F2) as a second span-12 panel below.
- **Risks:** the drop strip and every card must stay inside **one** `DndContext`; the strip is not sticky and is reached by dnd-kit auto-scroll of the nearest scroller — making it sticky or moving cards into their own scroll panel strands it unless a `measuring` strategy is set; `DragOverlay` is fixed-position, so any ancestor with `transform`, `filter` or `contain` offsets it (do not give this page's panels the `tile-in` entrance, which animates a transform); rows carry an inline transform, so a `press` transition smears drags; the unit tests mock an exact list of dnd-kit exports (a new import such as `MeasuringStrategy` throws) and mock `ui/select` as a native select; e2e drag specs use `scrollIntoViewIfNeeded` mid-drag and a 414×896 touch viewport with a 200 ms delay.

### C8. Settings (10–12 h; fold-ins F5, F8-memory, F9, F10 land here)

- **Keep:** ST-01…19, including ST-05 (allowance amounts), ST-16 and ST-17 even though ST-17 is unread (owner decides, D9).
- **Shares today:** `ui.tsx` (card set, `Field`, `Foot`, `Help`, `errorBanner`), `ui/toast`, `ui/alert-dialog`, `ui/select`, `page-skeleton`; the child components use a second kit (shadcn `Card`, `Button`, `Form`, `Badge`, `Progress`, `Collapsible`, `Dialog`).
- **Composition:** split into sub-pages under one Settings area with a local tab bar: **Banks** (link, list, per-bank rows as panels with `AccountChip`s, sync history, cutoff; duplicates; consent check), **Household** (members & invitations, allowance amounts, bucket names, trackers), **Data** (workbook import, non-prod cleanup), **Automation**, **Morning text**, **AI** (owner), **Privacy**. Each section a `Panel` span-6/12.
- **Risks:** all six page tests `vi.mock` `@workspace/api-client-react` with a fixed hook list and mock `owner-invitations` and `plaid-link-button` by path, so moving an import or adding a hook breaks all six; `settingsDedupeTransactions` stubs `window.confirm`; `settings-reconnect-relink-fallback` needs exactly one `button-plaid-reconnect-<id>` (do not add `PlaidReauthBanner` here); `PlaidLinkButton` renders its dialogs inside the Banks head's `ml-auto` div and is also used on Chase, Amex and the debt picker; unify the two kits on `ui.tsx` without changing `data-phase` (asserted).

### C9. Chase `/transactions` standalone (16–20 h; includes the shared account-page kit)

- **Keep:** CH-01…42. Not CH-61…65 (dead; removing them is a separate PR).
- **Shares today:** account-page kit (`AccountPageHeader`, `BalanceTrendChart`, `DayGroup`, `LedgerColumns`, `MonthNavigator`, `AccountTransactionRow`, `AccountPageSkeleton`), `ui.tsx`, `components/viz` (`Sparkline`, `StackBar`, `DeltaPill`, `MoneyText`), `FreshnessLine`, `ChaseInsightStrip`, `SyncButton`, Plaid banners, `use-bulk-recategorize-prompt`. Not `components/next`.
- **Composition (same for `/amex` and `/next/accounts/:id`):** account head with `AccountChip` (checking accent) + Sync/Connect in `actions`; Money in vs out span-6 + Balance span-6; spending strip span-12; trend chart `ChartPanel` span-12; review controls + ledger in a flush, sticky-safe `TablePanel` span-12 whose head carries the pinned pane, with the bulk bar and day heads sticking under `--page-sticky-top`. Render the standalone route and the embedded route from the same layout so there is one account experience.
- **Risks:** the `--pinned-pane-h` contract (measured pane → bulk bar and day heads) breaks inside `overflow: hidden`; `LEDGER_GRID` (`transaction-row.tsx:42-43`) switches on the viewport `xl` breakpoint and is shared with Amex, so a span-8 panel squeezes the merchant column (use a container query); rows are not `TxnTable` rows — CLAUDE.md asks for 36–40 px rows with the account chip on every row, which is a shared-row change that reaches Amex; tests: 15 unit (class asserts `font-mono`, `tabular-nums`), 25 e2e (9 stale, 1 px row-drift geometry at 1280×800 and 390×844, heading `/^chase$/i`, "Match N items in Review").

### C10. Amex `/amex` standalone (14–18 h)

- **Keep:** AX-01…32. Not AX-33…37 (dead). Decide with the owner whether desktop rows get the mobile-only external-card, matched-rule and override markers (AX-16…18); parity with the mobile tree suggests yes.
- **Shares today:** the account-page kit (as Chase), `SectionHeader` (`components/stat`), `AmexCardBand` (with `RingStat`, `AddToAvalanche`), `BucketBubbles`, `TimeRangeToggle`, Plaid scoping components.
- **Composition:** as C9 with the Amex accent; the card band becomes a row of card panels (span-4 each, `AccountChip` + statement, week charges, ring) or the `/next/accounts` selector; chart `ChartPanel` span-12; ledger `TablePanel` span-12.
- **Risks:** both row trees are always mounted (CSS split) and tests expect both; the inline mobile row is ≈ 184 lines of JSX; accent swap points (`CB:62, 91`, `A:1874, 1883`, `CB:139`); D3 card-scope bug must be fixed before `/next/accounts` becomes the entry; three e2e specs read a tile that no longer renders; `amex-tile-<tier>` ids collide for two cards of one tier.

### C11. Landing → dashboard switch (12–16 h, plus 6–8 h command-center/overview gap closure)

- **Keep (gap list):** LND-05 review count, LND-07 % paid, LND-09 version label (needs a new home), LND-11 zero-number skeleton, LND-12 cheap open; CC-01 refresh banner (the dashboard's `Gate` hides a failed refresh), CC-04 `spine.spentWeek`/`spentMonth` (the dashboard shows **different** figures), CC-06 runway, CC-07 spending strip, CC-09 sync all + reconnect, CC-11/12 allowance rows with words, `?view=` links and both pagers, CC-13 top 8 not 5; FO-03 runway and FO-07 biggest bills ahead (retire `/forecast/overview` into the dashboard and `/next/forecast`).
- **Shares today:** `components/next` (all five), `ui.tsx` `Page`, `lib/cssBars`, `lib/attention`, `ProjectedBalanceChart` (lazy), `BankBalanceWhy`, `FreshnessLine`.
- **Composition:** B1's panel order stands; add a span-12 "Spending this week" panel (CC-07) and fold the allowance rows into the Spending panel with pagers.
- **Steps:** route `/home` to the dashboard (keep it lazy; make `LandingSkeleton` dashboard-shaped with zero numbers; start the chunk import at module scope when the auth hint is set, as the spine prefetch does — a dynamic import is not counted by `check-entry-graph.mjs`); drop the `/home` header special case (`layout.tsx:568, 715-719`); rewrite `routes.test.tsx` rows and `appShell.test.tsx:206-210`; replace `landing.test.tsx`; rewrite the layout and `useLandingWarmup` warm-ups to warm what the dashboard reads; remove the top line at the switch; fix D14 (`OWN_INVALIDATION` on the recap preview).
- **Risks and owner decisions:** **`perf-open.spec.ts` fails twice** — the dashboard pulls `/api/transactions` (`SpendingPanel.tsx:42`, `ActivityPanel.tsx:13`) and lazy-loads recharts as soon as the cash signal arrives (`ForecastPanel.tsx:11-13, 83`); either draw the landing chart as SVG and defer recharts past `load`, or change the spec with a written reason. **"Landing-facing surfaces show % paid, never the amount owed"** (CLAUDE.md §1) conflicts with `dash-debt-total` and the accounts row's "Balance owed" — needs the owner's word before `/home` changes. The 580 KB cap has ≈ 1.9 KB headroom.

### C12. Layout / ribbon (8–10 h)

- **Keep:** SH-01…17 (SH-01 goes at the switch).
- **Shares today:** `tab-ribbon.tsx`, `h2-wordmark`, `ui/sheet`, `ui/dropdown-menu`, Clerk `UserButton`, `routePrefetch`.
- **Work:** restyle header, ribbon, drawer and More on the tokens (two `rgba()` glows and 15 `white/NN` utilities are the only literals); add the fold-in sub-items (Review › Categories, Suggestions; Spending › Wish list; Settings sub-pages; an Ask launcher in the header); decide where `/next/accounts` lives (Home area, replacing the separate Chase and Amex tabs or sitting beside them); delete the dead More dot; give the version label (LND-09) a home in the account menu or Settings.
- **Risks:** `appShell.test.tsx` reads visibility from class names (`hidden`, `md:hidden`, `sm:flex`…) and the exact tab order per area; `routes.test.tsx` holds a hand-typed ribbon table and a row for every `path=`; `routePrefetch.ts` and `App.tsx` move in lockstep; `a11y-smoke` and `perf-open` need the `<main>` landmark.

### C13. Forecast cut-over (6–8 h; not in the brief's list, needed for the switch)

B2 already hosts the register, month and dialogs. To make `/forecast` and `/review` use the new layout: re-host FC-15 (title, Bills link), FC-20/21 (hero + cleared badge), FC-23 (date balance), the classic big-bill markers and the sticky header (`pageStickyHeaderRef` is never mounted on `/next`, so the pinned inbox sits at top 0); add a month picker to review mode (D8, owner OK); repair the four stale forecast e2e specs.

### New-app features to fold in (F1–F10)

Rules (CLAUDE.md §3): port the pure logic into `h2budget/src/lib` with its tests; rebuild the UI on h2budget primitives; never import across apps. Every hook below exists in the generated client (checked); generate them into the C0 sub-module, or the ≈ 19–21 KB they add would blow the landing cap. Paths: `h2/` = `artifacts/h2/src/`, `srv/` = `artifacts/api-server/src/routes/`.

| # | Feature | API routes (server file) | h2 files to port from (pure logic first) | Home in classic | Overlap / decision | Est. |
|---|---|---|---|---|---|---|
| F1 | **Activity review queue** | GET `/categorization/review`; POST `/categorization/review/{decisionId}/accept`, `/skip`, `/correct`; POST `/category-decisions/{id}/undo`; GET `/category-decisions` (`srv/categorization.ts:88-165`); PATCH `/transactions/:id` | `screens/activity/words.ts` (`reviewWhy`, `reviewFlags`, `dayHeader`), `useFiling.ts` (`patchLedgerCaches`, `isProvisional`; drop the `decisionId` workaround — PATCH now returns it, `srv/transactions.ts:450-497`), `data/activityData.ts` (`badgeCount`, `reviewParams`), `CategoryPickerSheet.tsx:29-38` (grouping); UI `ReviewView.tsx` (j/k/a/c/s keys), `RowSheet.tsx`; tests `activity.test.tsx` 165-436, 613-646 | **Review › Categories** (`/review/categories`); the Review badge becomes forecast review + queue total | Three different queues stay distinct: `/review` (forecast bank-match), Chase review inbox (mark reviewed), this one (category decisions). Fix D20 (dashboard link). Needs the two-action toast (C0) | 8–10 h |
| F2 | **Learned rules** | GET/PATCH/DELETE `/learned-rules[/{id}]`; POST `/learned-rules/{id}/apply-retroactively` (`dryRun` supported) (`srv/learnedRules.ts:35-114`) | `RulesView.tsx`: `SCOPES` labels, sort (off last, `lastConfirmedAt` desc), amount-band line; tests `activity.test.tsx` 437-516 | **Mapping rules**, second list "Learned from your corrections" | Drop h2's "Rules you wrote" half — `/mapping-rules` is the superset. Classic already learns silently on every hand filing (no screen shows it today). Watch for double learning with the picker's "Remember pattern" (a mapping rule) | 4–6 h |
| F3 | **Agent trail, findings, runs** | GET `/agent/actions`, POST `/agent/actions/{id}/undo` (501 for types not wired); GET `/agent/findings`, POST `/{id}/dismiss` and `/resolve`; GET `/agent/runs`; POST `/agent/monitor/run` (owner) (`srv/agent.ts:82-173`) | `activity/trailWords.ts` (`groupTrail`, `trailTitle`, `FINDING_TITLE`, `payloadLines`), `AgentTrail.tsx:18` `OUTCOME`, `data/trailQuery.ts`; tests `trailWords.test.ts`, `activity.test.tsx` 517-612 | "Handled by H2" panel on Review › Categories; open findings as a "Needs attention" panel on the dashboard | `duplicate_charge` overlaps Settings' duplicate merge and the dashboard "Possible duplicates" row; `shortfall` overlaps the forecast | 4–5 h |
| F4 | **Category splits** | GET/POST/DELETE `/transactions/{id}/splits` (`srv/categorization.ts:175-200`; Σ parts = parent) | `activity/splitMath.ts` (all: `parseCents`, `splitState`, `MAX_PARTS`), `SplitSheet.tsx`; tests `splitMath.test.ts`, `activity.test.tsx` 255-321 | Row detail on the Chase and Amex ledgers ("Split by category") | Different from classic's **bucket** split (`split-transaction-dialog.tsx`, Allowances), which creates manual rows; label both. Server category totals honour splits; client groupings do not (`CashFlowPage.tsx:465-501` money flow, `budget.tsx:533-558` actuals popover) — decide before shipping. (`reportsAnalytics.categoryTotals`, sometimes cited here, is dead code.) | 4–6 h |
| F5 | **Automation + backlog run** | GET/PUT `/categorization/settings` (PUT owner-only) (`srv/categorizationSettings.ts:176-182`); POST `/categorization/run` `{scope:"all"}` (owner; model pass only if `AI_ENABLED`) (`srv/categorization.ts:34-60`); POST `/category-decisions/{id}/undo`; optional `/ops/jobs`, `/ops/jobs/{id}/retry` (owner) | `household/automationWords.ts` (all: `MODE_LADDER`, `backlogLine`, `runResultLine`, `requirementFigure`, …), `Automation.tsx:45` `errWords`; tests `household/automation.test.tsx` (drop the hand-written-client parity block) | **Settings › Automation** (owner), linked from Review › Categories and Mapping rules | Drop `h2/data/automationApi.ts`: it exists only because h2's 400 KB cap was full; classic uses the C0 sub-module. "Bank data" line repeats Settings › Banks | 6–8 h |
| F6 | **Afford + wish list** | POST `/money/afford` (`srv/money.ts:47`); POST `/wishlist/{id}/evaluate` (`srv/money.ts:106`); GET/POST `/wishlist`, PATCH `/wishlist/{id}` (409 inside the waiting period) (`srv/ai.ts:320-382`); reads `/money/position`, `/allowance-plans` | `afford/verdict.ts` (`VERDICT`, `monthWord`), `AffordSheet.tsx` (`comingSaturday`, `refusal`), `plan/format.ts` `parseDollars`, `PlanWishlist.tsx` (`parseAmount`, `DECISION`); tests `afford.test.tsx`, `askPages.test.tsx` 124-190 | **Spending**: an Afford launcher on Budget, Allowances and the dashboard; **Spending › Wish list** sub-item | None in classic. Verdict figures are server-computed (avalanche-core) | 5–6 h + 4–6 h |
| F7 | **Ways back** | GET `/money/ways-back`; POST `/money/week-adjustments`; DELETE `/money/week-adjustments/:weekStart` (owner) (`srv/money.ts:150-194`) | `today/WaysBackSheet.tsx` (`fmtCents`, `errorWords`, `weekdayName`), the `wayBack` flag classic's `lib/attention.ts:89-96` dropped; tests `today.test.tsx` 840-919, `data/mutationInvalidation.test.ts` | **Spending › Allowances** over-limit state + dashboard briefing | A carry-over lowers the **server** weekly position (`spine.position.weekAdjustment`); classic `/allowances` computes its week client-side and never reads it — reconcile first (owner). Add ways-back and money-position keys to `lib/mutationInvalidation.ts` (entry-resident) | 3–4 h |
| F8 | **Ask + proposals + memory** | POST/GET `/ai/conversations`, GET `/ai/conversations/{id}`, POST `/ai/chat` (SSE, `ai-stream` tag, excluded from codegen by design), GET `/agent/proposals`, POST `/{id}/approve`, `/reject` (`srv/ai.ts:80-262`); GET `/memory`, PUT `/memory/{scope}/{key}`, DELETE `/memory/{id}` (`srv/ai.ts:281-313`); `/healthz` (`ai.enabled`) | `data/aiStream.ts` (all; plain `fetch`, ports as is), `ask/askWords.ts` (all), `Ask.tsx` `HINT`/`SUGGESTIONS`, `askData.ts`; UI `Ask.tsx`, `ProposalCard.tsx`, `Proposals.tsx`, `AskMemory.tsx`; tests `aiStream.test.ts`, `ask.test.tsx`, `askPages.test.tsx` 60-123 | **Ask**: header launcher + an "Ask" route outside the five areas; **Proposals**: Review › Suggestions; **Memory**: Settings | Answer refs link to `/activity?txn=`; map them to `/transactions?tx=` (exists, CH-09) and add a `?tx=` to Amex (none today). Gated by `AI_ENABLED` (unset on Render), 30/min rate limit, daily caps | 14–18 h |
| F9 | **Recap (morning text)** | GET/PUT `/recap/settings`; POST `/recap/verify/start`, `/confirm`, `/test-send` (3/day), `/pause`, `/unsubscribe`; GET `/recap/deliveries`, `/recap/history`; POST `/recap/preview` (`srv/recap.ts:182-462`) | `recap/recapWords.ts` (all: `toE164`, `maskedPhone`, `ladderRows`, `historyWords`, …); UI `Recap.tsx` (647); tests `recap.test.tsx` | **Settings › Morning text**; the dashboard briefing keeps the preview | Fix D14 first: each dashboard open spends one of the six daily recap model calls when AI is on | 8–10 h |
| F10 | **AI cost** | GET `/ai/usage/summary` (`srv/ai.ts:410`, includes recent runs); PUT `/ai/budget` (owner) (`srv/ai.ts:464`) | `household/AiCost.tsx` (`capOf`, `CAP_WORDS`), `kit/Meter.tsx` (`meterStatus`, `meterWords`), `askWords` (`taskWord`, `usd`, `percent`); tests `askPages.test.tsx` 191-270, `kit/Meter.test.tsx` | **Settings › AI** (owner), next to Automation | None | 3–4 h |

Also in h2 and absent from classic (one line each, not in this list): Today's "Room in the plan" hero and assumptions sheet; Plan › Week's server-suggested weekly cap, owner-set cap and per-member allowances (`useListAllowancePlans`, `useUpdateAllowancePlan`); Plan › Debt's payoff ranges (`useGetDebtPlan`); the all-accounts Activity ledger; goals have an API but no screen in either app. Members and invitations are already in classic.

### Totals and order

| Block | Builder-hours |
|---|---|
| C0 groundwork | 10–14 |
| C1 reports | 22–28 |
| C2 budget | 10–12 |
| C3 allowances | 6–8 |
| C4 bills | 8–10 |
| C5 debts | 3–4 |
| C6 avalanche | 12–15 |
| C7 mapping rules | 10–12 |
| C8 settings | 10–12 |
| C9 Chase + account kit | 16–20 |
| C10 Amex | 14–18 |
| C11 landing → dashboard (+ gap closure) | 18–24 |
| C12 layout / ribbon | 8–10 |
| C13 forecast cut-over | 6–8 |
| **Restyle subtotal** | **153–195** |
| F1–F10 fold-ins (shared helpers are in C0) | 63–83 |
| **Wave C total** | **≈ 216–278** |

Order: C0 first (everything depends on it). Then three lanes that do not share files: (a) C9 → C10 → C13 (ledgers and forecast share the sticky contract), (b) C1 → C2 → C3 → C4 → C5/C6 (spending and debt pages), (c) C7 + F2, then C8 + F5/F9/F10. F1/F3/F4 follow C9 (they live on the ledgers and Review). C11 and C12 go last, behind the owner's answers on the perf spec, the debt-total law and the cap.

## 9. Report

**Counts:** 21 route pages; about 365 live actions (the census said about 250); 19 recharts charts and about 25 CSS/SVG visuals; 149 unit test files; 88 e2e specs, about 21 stale. CI runs e2e only when switched on.

**Census corrections:**
- Reports show server figures. 17 analytics helpers are never called. The radar and spend clock never appear. Compare is on Cash flow only.
- Four "live" Chase handlers are dead code.
- Amex is not virtualized and seven built features never show. A likely bug drops the card choice on first load.
- Allowances are per bucket, not per person.
- Settings has an allowance form the census missed. Its saved trackers are never read.
- The census missed Forecast's main save. A row click marks the item missed.

**Wave C:** about 216–278 builder-hours. Groundwork comes first, including a separate API module for the new screens. Without it they add about 20 KB, and the open path has 1.9 KB to spare.

**Riskiest ports:**
1. Chase/Amex ledgers: sticky bars inside panels, a shared grid, 38 e2e specs.
2. Dashboard as landing: the open-speed test fails, and the debt total breaks the % paid rule.
3. Mapping-rules drag-and-drop.
