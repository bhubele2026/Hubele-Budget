# C13 — `/forecast` and `/review` render the one forecast screen (2026-10-09)

Branch `restore/c13-forecast-cutover`.
- Base: the 10/08 builder's WIP `1352de7e` (on b47d0997, C10 included), then `origin/main` 2077b109 merged in (C8, C11, C11b). The merge was clean.
- Spec: `2026-10-08-parity-verified.md` §2.4 (FC-*), §8 "C13", §4 D8 and D18.

No query, money helper or write changed. No figure moved:
- the hero, the KPI tiles and the date balance are the same expressions, moved;
- `forecastAccuracy`, `forecastProbablyPaid` and `forecastProbablyPaidRefetch` pin those values and pass unmodified.

## The screen now

- **One layout:** `pages/forecast/ForecastBody.tsx` lays out `ForecastPage`'s own blocks for `/forecast`, `/review` and `/next/forecast`.
  - The register, drag-and-drop, month close and dialogs are the page's own elements (B2's `renderNext` contract).
  - The classic layout branch in `forecast.tsx` is gone (−290 lines).
  - `/next/forecast` is now a 30-line wrapper.
- **Head:** h1 (Forecast / Review) + Help, Bills link, Settings, horizons and look-back (FC-15/16/17).
  - Sticky from `md` up. Its measured height is `--page-sticky-top`.
  - On a phone it scrolls away: there it is ≈ 135 px of an 844 px screen, and nothing pins under it (the inbox pins only at ≥ 768 px).
- **Row 1:** "Forecast balance" hero with its three footnotes and the "Inbox cleared" badge (FC-20/21), span-4. Beside it, the six summary figures (FC-22 + B2's bank today and cash buffer), span-8.
- **Row 2:** the expanded projected-cash chart, span-12 (FC-28/29).
  - The classic big-bill markers are re-hosted as navy rings around their day's marker. The ring jumps to the plan.
- **Row 3, register panel (span-8, `sticky-safe`):**
  - `/review` shows "Register & reconcile": the month picker, From-Chase card, pinned inbox, planned list, Missed and Moved.
  - `/forecast` shows "Month & bank": Past due, the bank and avalanche cards, the planned list, Missed and Moved, then month close and the bucket.
- **Row 3, side (span-4):** the selected day, and "How much will we have?" (FC-23).
- **The two views:**
  - On the routes they are links to `/review` and `/forecast`, in a nav, with `aria-current`.
  - On `/next/forecast` they are real tabs over one always-present tabpanel.
  - Before: links carried `role="tab"` and an `aria-controls` that pointed at a pane not on the page, which is an axe violation.

## Behaviour changes (all called for by the block)

- **D8, owner OK:** `/review` has the month picker (`review-month-row`), the same element as the month block's.
  - Before: Review always listed the current month, so an earlier month's pending row never reached the inbox.
  - It changes which rows are listed only.
- **D18:** `--page-head-overshoot` is 0 at both sizes. The head bleeds exactly the shell pad.
  - Gone: the hidden 4 px horizontal overflow on a phone, and the 24 px over-width past 1,600 px.
  - The content under the head sits 4/12 px lower, on purpose.
- **Phone layout:**
  - the inbox card and the plan row's right-hand group wrap, instead of running off the card. Before, the "Add as bill" and "Unplanned" buttons were out of reach at 390 px;
  - the register panel's title is screen-reader-only below `sm`, because the view links fill the head. `Panel`'s `title` prop now accepts a node.
- **Accessibility:**
  - the month, inbox-card and link-checking comboboxes get `aria-label`s (a combobox never takes its name from its value);
  - the filters note is `neutral-600` (it measured 4.49:1).

## Parity (§2.4)

| ID | Kept — test or testid |
|---|---|
| FC-01 | `useGetForecast` / cash-signal keys unchanged — `forecastCashSignalKey`, `forecastHorizonSwitchPerf` |
| FC-02 | `FreshnessLine` in the bank card — `forecastBankSnapshotFreshness`; e2e `bank-snapshot-freshness-label` |
| FC-03 | payoff chips and cash-freed banners, page logic unchanged — `PlannedItemsList.test`, `forecastAccuracy` |
| FC-04 | register, bucket, reconcile — `forecastReviewBucketShrink`, `forecastReviewMonthPicker` (`card-from-bank` counts) |
| FC-05 | suggestions, confident and one-click picks — `forecastOneClickMatchButton`, `forecastDropdownPlanFilter`; e2e `forecast-one-click-match` |
| FC-06 | big-bill markers on the screen's chart — `forecastAgreement` (C13: `big-bill-marker-2026-06-15`), `forecastBigBillJump` |
| FC-07 | write-before-refetch + namespace invalidation, unchanged — `forecastProbablyPaidRefetch`, `avalancheForecastInvalidation` |
| FC-08 | resolution upserts — `forecastDragMatch`, `forecastInboxTransitions`; harness: Enter-match and bulk-unplanned POSTs |
| FC-09 | Undo — `undo-resolution-*` in `bank-resolved-list`; e2e `forecast-one-click-match` |
| FC-10 | Close / Reopen month in the "Month & bank" view (month block unchanged) |
| FC-11 | Settings dialog — head `button-forecast-settings` → `openSettings`; `#days`, `input-starting-balance`, `#buf` unchanged |
| FC-12 | × Un-send / Not a planned payment — e2e `forecast-inbox-pager` (role name read in the harness) |
| FC-13 | `button-set-bank-snapshot`, `input-snapshot`, link checking, refresh — e2e `forecast-empty-bank-snapshot` |
| FC-14 | Add as bill — e2e `forecast-add-as-bill` (`inbox-add-as-bill-*`, `dialog-add-as-bill`) |
| FC-15 | **re-hosted:** h1, Help, `link-manage-bills`, Settings in `forecast-sticky-head` — `forecastAgreement` (C13), `shellScrollContract` |
| FC-16 | `horizon-{d}`, `horizon-{d}-pending` in the head — `forecastHorizonSwitchPerf`, `forecastAgreement` |
| FC-17 | `toggle-forecast-lookback`, `input-forecast-from` — `forecastMinFromDate`, `forecastFromAndMonthSwitchPerf` |
| FC-18 | deferred horizon, date and month — `forecastHorizonSwitchPerf`, `forecastFromAndMonthSwitchPerf` |
| FC-19 | skeleton, Retry, refresh and reauth banners (`bannerBlock`, above the screen) — unchanged |
| FC-20 | **re-hosted:** `card-forecast-hero`, `hero-forecast-balance`, footnotes — `forecastAgreement` (C13: $1,200.00, "Matched impact $200.00"), `forecastAccuracy` |
| FC-21 | **re-hosted:** `badge-inbox-cleared` in the hero — `forecastAgreement` (C13, FC-21 case); `shouldCelebrateClear` in `forecastReschedule.test` |
| FC-22 | `kpi-*` — `forecastAccuracy`, `forecastAgreement`; e2e `forecast-chart-day0-bank-balance` |
| FC-23 | **re-hosted:** `forecast-date-balance` beside the selected day — `forecastAgreement` (C13), `forecast-date-balance.test` |
| FC-24 | `card-dragging-plans-summary`, jump — e2e `forecast-dragging-plans-summary` (repaired); `forecastAgreement` (`dragging-plans-list`) |
| FC-25 | Mark missed / Skip on past due — `forecastProbablyPaid` |
| FC-26 | `dragging-plan-match-trigger-*` (bank-row select) — `forecastProbablyPaid` |
| FC-27 | `dragging-plan-partial-*` lock — `forecastProbablyPaid` |
| FC-28 | chart: buffer, low point, markers, tooltip, tooltip Mark missed — `ProjectedBalanceChart.test` / `.expanded.test`, `forecastChartAnnotations`; e2e `forecast-tooltip-mark-missed` (repaired; flow driven in the harness) |
| FC-29 | `empty-projected-balance`, `button-empty-set-bank-snapshot` — `forecastChartAnnotations`; e2e `forecast-empty-projected-balance-set-snapshot` |
| FC-30 | `card-bank-snapshot`, `text-bank-balance`, `text-bank-snapshot-meta` — e2e `forecast-empty-bank-snapshot`, `forecast-chart-day0-bank-balance` |
| FC-31 | `action-forecast-refresh-bank-set-manual` toast — handler unchanged |
| FC-32 | `card-avalanche-schedule` in the bank grid — unchanged (in the "Month & bank" view) |
| FC-33 | `banner-review-waiting`, `link-go-to-review` — in the overall register (harness: "3 waiting → Go to Review") |
| FC-34 | `select-month-filter` — `forecastFromAndMonthSwitchPerf`, `forecastReviewMonthPicker` (overall keeps exactly one); e2e `forecast-move-date` |
| FC-35 | `month-reconciled-at-close`, `month-gap-at-close`, Close / Reopen — month block unchanged |
| FC-36 | `review-bucket-panel`, `-count`, `-total`, `-list` — `forecastReviewBucketShrink` |
| FC-37 | `review-empty-state`, `link-open-chase` — harness, fresh-user `/review` (screenshot and axe) |
| FC-38 | `card-from-bank` + chips + "Prior period" — `forecastReviewMonthPicker`; e2e `forecast-add-as-bill`, `-bulk-mark-unplanned` |
| FC-39 | `bulk-match-confident`, `bulk-mark-unplanned` — e2e `forecast-bulk-match-confident` (repaired), `transactions-bucket-badge` |
| FC-40 | `drag-to-match-hint` + localStorage — `forecastDragMatch` |
| FC-41 | `returned-unflagged-note` / `-mark-unplanned` — unchanged inside `card-from-bank` |
| FC-42 | `bank-inbox-selection-bar`, `bulk-*-selected`, clear — e2e `forecast-bulk-mark-unplanned`; harness: "3 selected", "Mark 3 unplanned" |
| FC-43 | reconciled chip, `bank-resolved-list`, `undo-resolution-*` — e2e `forecast-enter-to-match`, `-one-click-match` |
| FC-44 | `pinned-inbox-area` (`data-pinned`), pager, collapse — e2e `forecast-pinned-inbox-*`, `-inbox-pager`. Harness at 1280×720: pins flush under the head (157.9 vs 157.8 px) after a 1,500 px scroll |
| FC-45 | `select-bank-*`, drag handle, `one-click-match-*` + Enter, dropdown, Add as bill, Unplanned — `forecastOneClickMatchButton`; e2e `forecast-enter-to-match` |
| FC-46 | `probably-paid-*` strip — `forecastProbablyPaid`, `needsReviewStrip.test`; e2e `forecast-probably-paid` |
| FC-47 | `suggest-match-*` — `forecastProbablyPaid` |
| FC-48 | × remove; `DragOverlay` inside the sticky-safe panel (no entrance transform) — `forecastDragMatch` |
| FC-49 | planned list, `planned-projected-end` — `PlannedItemsList.test` |
| FC-50 | drop targets, `data-drop-eligible` — `forecastDragMatch` |
| FC-51 | row click / Enter / Space = Mark missed — `forecastMissedActions`, `PlannedItemsList.test` |
| FC-52 | Move to… dialog — `forecastMissedActions`; e2e `forecast-move-date` (repaired) |
| FC-53 | Mark missed + Undo, Confirm / Not this / Partial — `forecastMissedActions`, `forecastProbablyPaid` |
| FC-54 | payoff chip, 2 s highlight, cash-freed, status chips — `PlannedItemsList.test`, `forecastBigBillJump` |
| FC-55 | `missed-bucket-panel`, `rescheduled-bucket-panel` + Undo — e2e `forecast-move-date`; in both views |
| FC-56 | the four dialogs (`dialogsBlock`), unchanged — e2e `forecast-add-as-bill` |
| FC-57 | undo coverage unchanged — `forecastMissedActions`; e2e `toast-undo-mark-missed` |
| FC-58 | the 5 session keys + 2 local keys — `forecastCashSignalKey`, `forecastMinFromDate`, `forecastDragMatch` |
| FC-59 | `TouchSensor` (150 ms / 5 px); plan row wraps below `sm`, now also its action group — unchanged sensors |
| FC-60 | `#bucket` / `#register` → the other route (D6, `hashTab.test`) — still live; `/next/forecast` ignores it |

## E2E — the 15 `forecast-*` specs

**Not run.** No Clerk keys exist locally (the C9 and C10 situation). Every spec's test ids were checked against the source by script; all are present. The repaired selectors and the key flows were driven against the real page in the scratch harness (fake API, built CSS, 1280×720 and 390×844).

**Repaired (7):**
- by the 10/08 WIP: `bulk-match-confident`, `chart-day0-bank-balance` (it had passed vacuously), `dragging-plans-summary`, `move-date`, `tooltip-mark-missed`;
- here:
  - `bulk-match-confident` now switches month with the `/review` picker (D8), not a detour through `/next/forecast`;
  - `chart-day0-bank-balance` now scrolls the chart into view before hovering. At 1280×720 the chart's middle is at y≈743, below the fold, so the mouse would miss it.

**Read, unchanged, and still valid (8):**
- `add-as-bill`, `bulk-mark-unplanned`, `empty-bank-snapshot`, `empty-projected-balance-set-snapshot`, `enter-to-match`, `inbox-pager`, `one-click-match`, `probably-paid`;
- `pinned-inbox-collapsed-persistence` and `pinned-inbox-sticky-on-scroll` (their doc comments still say "Active Register tab"; the assertions hold).

**Driven in the harness:**
- pinned inbox: the sticky-on-scroll checks, all true;
- collapse, and the localStorage key;
- pager;
- the Unplanned and × buttons, by role name;
- the review month switch, by option name;
- Enter-to-match (matched POST);
- the select-all bar and bulk unplanned (3 `ignored_unforecasted` POSTs, toast "Marked 3 as unplanned");
- day-0 tooltip ("Balance $4,210.55");
- tooltip "Dragged onto this day" → force-click `tooltip-mark-missed-*` → `toast-undo-mark-missed`;
- the Move dialog title.

**Other specs that open these routes:**
- `a11y-smoke` (`/review`): axe in the harness on a fresh-user `/review` finds 0 critical/serious at 1280 and 390;
- `bank-snapshot-freshness-label` and `transactions-bucket-badge`: they read only ids that still render.

## Tests

- **New:**
  - `forecastReviewMonthPicker.test.tsx` (3): the picker heads the review register; picking April lists April's pending row; overall has exactly one picker.
  - `forecastAgreement` C13 cases (4): the `/forecast` and `/review` screens; the FC-21 badge; `/next/forecast` tabs vs route links.
- **Changed:**
  - `shellScrollContract`: `md:sticky md:top-0`;
  - `index.css.test`: overshoot 0;
  - `chartsDoor`: the WIP. No exception is left; `ProjectedBalanceChart` reads recharts through the kit.

## Bundle

- Landing JS: **627,241 bytes** (main 627,242), cap 633 KB. No recharts on open.
- Chunks: classic `forecast` 96.8 KB; `/next` `Forecast` 1.3 KB (was 17.1 KB; the layout moved into the shared chunk).
- `vendor-charts` 443.4 KB, lazy.

## Gates

- `pnpm run typecheck`: clean, e2e specs included.
- h2budget vitest, 188 files:
  - UTC: 1,638 passed, 3 skipped;
  - Chicago: 1,639 passed, 2 skipped.
- `pnpm run build` + `check-entry-graph`: OK.
- `pnpm audit --prod`: 1 high, already ignored.
- No API or spec change.

## For the lead

- **The old layout is already removed** (the WIP did it). The brief's condition, "removed once the 15 e2e specs pass", is met here only by reading and the harness. A real e2e run with Clerk keys should gate the merge, or I restore the old branch behind the prop.
- **Existing problem, not new: axe `nested-interactive`.** On any account with planned items, axe flags it on `/forecast`, `/review` and `/next/forecast`: `PlanDropRow` is a `role="button"` row (click = Mark missed, FC-51) with buttons inside. `a11y-smoke` passes only because its fresh user has no plans. Fixing it changes the row's interaction, so it is outside a restyle.
- **"Bank today" shows $0.00 with no snapshot.** It reads `startingBalance`, B2's approved tile. Left unchanged under "numbers never move".
- **Harness:** a vite server left by the 10/08 builder was still serving this worktree on port 5199. I reused it and did not stop it.
