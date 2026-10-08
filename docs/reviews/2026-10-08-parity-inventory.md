# Classic (h2budget) parity inventory, 2026-10-08

Base: main at 070ebb1c. Source: `artifacts/h2budget` (CLASSIC) vs `artifacts/h2` (NEW).

## 1. How to read this

- Every classic capability is listed with the handler, hook or test id that proves it exists. Later PRs are scored against these lists: a line is "done" only when the capability works in the restored app and its test still passes.
- Counts are a census of handlers, `data-testid`s, dialogs and chart components found by grep, not a hand count of every pixel. Treat them as a floor (marked "~").
- New-app status: **preserved** (same capability), **weakened** (partial), **hidden** (exists only as a link to `/classic/`), **omitted** (gone). Status is judged from file and keyword search in `artifacts/h2/src`; the classic app is currently mounted at `/classic` with a "Classic app — retiring" banner (`layout.tsx`, testid `classic-retiring-banner`).

### Summary table

| Route | File(s) | Lines | Actions (~) | Charts | Filters / drilldowns (~) | Unit tests / e2e specs | New app |
|---|---|---|---|---|---|---|---|
| `/home` | `pages/landing.tsx` | 325 | 3 (tile nav, bell, More) | 0 | 0 | 1 / 0 | omitted: Today replaces it |
| `/banking` | `pages/command-center.tsx` | 601 | 2 (refresh banner, drill) | 0 (stat tiles) | 3 | 1 / 1 (bank-snapshot-freshness) | weakened: Today shows balance and week, not low-point or biggest charges |
| `/forecast/overview` | `pages/forecast-overview.tsx` | 297 | 1 | 2 (Sparkline, StackBar) | 2 | 1 / 0 | omitted: no runway, low point, big bills |
| `/forecast`, `/review` | `pages/forecast.tsx` + `pages/forecast/*` | 3851 + 1,330 | ~30 | 1 area chart | ~12 | 17 + 12 lib / 15 | omitted: only a bills list in Plan; no matching, inbox or projection |
| `/reports` hub | `pages/reports.tsx`, `reports/reportsShared.tsx` | 319 + 468 | 5 tiles | 5 | 2 | 3 / 1 | omitted |
| `/reports/debt` | `reports/DebtPage.tsx` | 507 | 1 (range) | 4 | 4 | 0 / 0 | omitted (PlanDebt shows milestones only) |
| `/reports/cashflow` | `reports/CashFlowPage.tsx` | 798 | 2 (range, compare) | 5 | 5 | 1 / 0 | omitted |
| `/reports/spending` | `reports/SpendingPage.tsx` | 960 | 3 (range, compare, re-categorize) | 5 | 6 | 1 / 0 | omitted |
| `/reports/budget` | `reports/BudgetPage.tsx` | 457 | 1 | 0 (bars) | 2 | 0 / 0 | omitted |
| `/reports/behavior` | `reports/BehaviorPage.tsx` | 378 | 1 | 3 (bar, 2 streak cards) | 2 | 0 / 0 | omitted |
| `/transactions` (Chase) | `pages/transactions.tsx` + `transactions/*` | 2960 + 710 | ~28 | 3 | ~12 | 8 / 20 | weakened: Activity ledger and review are good but lose account scope, running balance, forecast flag, bulk bar |
| `/amex` | `pages/amex.tsx`, `components/amex-card-band.tsx`, `bucket-bubbles.tsx` | 2417 + 290 | ~30 | 2 | ~10 | 5 / 12 | omitted (ledger shows Amex rows with no card view) |
| `/debts` | `pages/debts.tsx` | 416 | 1 | 0 | 1 | 4 / 3 | weakened: PlanDebt |
| `/avalanche` | `pages/avalanche.tsx` | 2091 | ~14 | 0 (bars) | 3 | 6 / 3 | weakened: PlanDebt has strategy, extra, milestones |
| `/bills` | `pages/bills-overview.tsx` | 254 | 0 | 0 | 2 | 1 / 0 | weakened: PlanBills |
| `/bills/all` | `pages/bills.tsx` | 1732 | ~14 | 0 | 5 | 2 / 8 | weakened: PlanBills (no month picker, no actual vs planned) |
| `/budget` | `pages/budget.tsx` + `budget/*` | 2081 + 384 | ~22 | 1 strip + hero bar | ~8 | 6 / 8 | weakened: PlanCategories has month and planned edit only |
| `/allowances` | `pages/allowances.tsx` | 1304 | ~10 | 0 | 5 | 1 / 0 | weakened: PlanWeek and allowance plans |
| `/mapping-rules` | `pages/mapping-rules.tsx` + `mapping-rules/*` | 2483 + 267 | ~30 | 0 | ~6 | 6 / 9 | weakened: Activity Rules shows learned rules, not user rules |
| `/settings` | `pages/settings.tsx` + 5 components | 1447 + ~1,900 | ~28 | 0 | ~4 | 6 / 3 | weakened: Household has banks, members; imports and clean-up hidden |
| `/plaid-oauth` | `pages/plaid-oauth.tsx` | 170 | 1 | 0 | 0 | 0 / 0 | preserved (`screens/plaid-oauth`) |

Totals: 20 route pages (23 URLs counting `/review`, `/dashboard` and `/recurring` aliases), ~250 actions, ~31 chart components, 141 unit/component test files, 88 e2e specs plus `zz-journeys/walk.spec.ts` (e2e by prefix: transactions 20, forecast 15, amex 12, mapping 9, bills 8, budget 8, chase 4, debts 3, plaid 2, others 1 each).

## 2. Per-page inventory

Hook names are the generated `@workspace/api-client-react` hooks. "Tests" lists classic unit files in `src/pages` or `src/lib` and e2e specs in `e2e/`.

### 2.1 `/home` Landing (`landing.tsx`)

- Answers: where do I go. Six tiles (Home `/banking`, Forecast, Spending, Review, Debt, Settings), More list (Reports, Allowances, Chase, Amex, Debts, Mapping rules).
- Actions: tile click with pointer-follow glow (`onTilePointerMove`), hover/focus prefetch (`prefetchRoute`), review bell with count (`landing-bell`, `landing-bell-count` from `useReviewInboxCount`), payoff percent chip (`landing-payoff-pct`), version label, warmup (`useLandingWarmup`).
- States: skeleton `landing-skeleton`.
- Tests: `landing.test.tsx`.
- New app: omitted by design (Today is the landing). Warmup/prefetch is replaced by `h2/src/lib/routePrefetch.ts`.

### 2.2 `/banking` Command center (`command-center.tsx`)

- Answers: how am I doing right now.
- Calculations: bank balance, low point, next bill, spent this week, spent this month, biggest charges, allowance rows. Sources: `useSpine` (spine stats `cc-spine-stats`), `useGetSettings`, `useListRecurringItems`, `useListTransactions`; helpers `householdDay`, `timeRange`, `bucketSpend`.
- Testids: `cc-stat-bank`, `cc-stat-low-point`, `cc-stat-next-bill`, `cc-stat-spent-week`, `cc-stat-spent-month`, `cc-biggest-charges`, `cc-allowances`, `cc-freshness`, `cc-refresh-banner`.
- States: stale snapshot (`bank-snapshot-freshness.tsx`), spine recovery (`spineRecovery.ts`), refresh banner.
- Tests: `commandCenter.test.tsx`, `bankBalanceWhy.test.tsx`, e2e `bank-snapshot-freshness-label`. Also `bank-balance-why.tsx` (explains the bank number; endpoint `bankBalanceExplain`).
- New app: weakened. Today has balance, week, attention list, but no low point, biggest charges or "why this bank balance".

### 2.3 `/forecast/overview` (`forecast-overview.tsx`)

- Answers: how long does cash last.
- Figures: bank, ending, low point, runway (`fo-stat-*`), curve (Sparkline, `fo-curve`), in/out StackBar (`fo-in-out`), big bills (`fo-big-bills`). Source: `useGetForecastCashSignal`; helper `cashSignalProjection`.
- States: loading, error `fo-forecast-error`, refresh banner.
- Tests: `forecastOverview.test.tsx`, `cashSignalProjection.test.ts`.
- New app: omitted.

### 2.4 `/forecast` and `/review` (`forecast.tsx` + `pages/forecast/*`)

- Answers: which bank transactions are unmatched, which plans have passed, and what the balance will be.
- Hooks read: `useGetForecast`, `useGetForecastCashSignal`, `useListRecurringItems`, `useListCategories`, `useListDebts`, `useGetAvalancheSettings`, `useGetAvalancheExtra`. Writes: `useUpdateTransaction`, `useCreateRecurringItem`, `useDeleteForecastResolution`, `useSetForecastBankSnapshot`, `useUpdateForecastSettings`, `useCloseForecastMonth`, `useReopenForecastMonth`.
- Actions (handler -> meaning):
  - `matchInboxToPlan`, `onSelectPlan`: match a bank txn to a plan (drag, button or select).
  - Drag and drop: `onDragStart`, `onDragEnd`, `PlanDropRow` (drop target per plan), `InboxCardView` drag handle, drag hint (`drag-to-match-hint`, dismiss stored at `h2budget:forecastDragHintDismissed`).
  - One-click match button and Enter on a focused inbox card (`oneClickSuggestion`, `aria-keyshortcuts=Enter`; `pickOneClickBankMatches`).
  - Suggested matches strip (`SuggestionStrip`, `suggest-match-*`; `buildClientSuggestions`, `suggestPlanMatchesForBank`).
  - Match-to select: dropdown of plans (`dragging-plan-match-trigger/option-*`, `filterDropdownPlans`, `rankPlansForBank`).
  - Match all confident: `bulk-match-confident` and `-selected` (`pickConfidentBankMatches`).
  - Mark unplanned: `onMarkUnplannedTxn`, `markTxnsUnplanned`, bulk `bulk-mark-unplanned`.
  - Add as bill: `openAddAsBill`, `submitAddAsBill`, dialog `dialog-add-as-bill` (name, amount, day, anchor) -> `useCreateRecurringItem`.
  - Remove from forecast: `onRemoveFromForecast`.
  - Undo: `onUndo`, `toast-undo-*`, resolved list `undo-resolution-*`.
  - Plans past due: `onMarkMissed` (mark missed, also from chart tooltip `tooltip-mark-missed-*`), `onSkipDraggingPlan`, `onSkipFromBucket`, `onSetNewDateFromBucket` (reschedule), `onMoveStart`/`onMoveSave` (move plan date), partial payment (`plan-partial-*`, `partialRemainder`, `canRecordPartial`), "remainder paid".
  - Probably paid strip (`ProbablyPaidStrip`: confirm, partial, reject, confidence, curve).
  - Buckets: Missed, Rescheduled, Review; each with total and scroll (`missed-bucket-*`, `rescheduled-bucket-*`, `review-bucket-*`).
  - Pinned inbox: pager (`bank-inbox-pager`, prev/next/indicator), collapse toggle (`togglePinnedInboxCollapsed`, stored `h2budget:pinnedInboxCollapsed`), sticky on scroll, selection bar (`toggleBankSelected`, `bank-inbox-selection-bar`).
  - Bank snapshot: `openSnapshot`, `saveSnapshot`, `onRefreshBank`, `onLinkChecking`, from-bank card (`card-from-bank`), manual starting balance.
  - Settings: `openSettings`, `saveSettings` (forecast-from date, look-back panel `forecast-lookback-panel`).
  - Horizon tabs `horizon-*` (days).
  - Month close and reopen: `closeMonth`, `onCloseMonth`, `onReopenMonth`, notes `month-reconciled-at-close`, `month-gap-at-close`, `month-filter-pending`.
  - Hash navigation (`onHashChange`), empty states `empty-projected-balance`, `button-empty-set-bank-snapshot`.
  - Cash freed banner when a debt is paid off (`CashFreedBanner`, `computePayoffTransitions`).
- Calculations: `forecast.ts` (`expandAll`, `buildDaily`, `aggregateMonthly`), `forecastReconcile.ts` (`computeBankReconcile`), `forecastMatch.ts` (1045 lines: `buildLineRegister`, `findCandidates`, `buildBucket`, `partialRemainder`, `isNeedsReviewStatus`, `shouldCelebrateClear`), `forecastPastDue.ts` (`buildDraggingPlans`), `forecastDebts.ts` (`linkRecurringToDebts`, `computePayoffsByDebt`), `effectiveSnapshot.ts`, `forecastResolutionCache.ts`, `forecastRowState.ts`, `invalidateForecast.ts`. KPIs: ending balance, lowest point, projected income, projected expenses (`kpi-*`), hero balance, planned-projected-end.
- Chart: `ProjectedBalanceChart` (Recharts area), reference lines cash buffer and lowest point, big-bill markers (`big-bill-marker-*`), tooltip lists bills with mark missed, day-0 equals bank balance.
- States: loading, empty bank snapshot, pending "forecast from", stale bank, error toasts.
- Tests: unit `forecastAccuracy`, `forecastBankSnapshotFreshness`, `forecastBigBillJump`, `forecastCashSignalKey`, `forecastChartAnnotations`, `forecastDragMatch`, `forecastDropdownPlanFilter`, `forecastFromAndMonthSwitchPerf`, `forecastHorizonSwitchPerf`, `forecastMinFromDate`, `forecastMissedActions`, `forecastOneClickMatchButton`, `forecastProbablyPaid`, `forecastProbablyPaidRefetch`, `forecastReviewBucketShrink`, `needsReviewStrip`, `ProjectedBalanceChart`; lib tests (12): `forecastMatchRanking`, `forecastNeedsReview`, `forecastOneClickMatch`, `forecastPastDue`, `forecastPastRowsReconcile`, `forecastProbablyPaid`, `forecastReconcile`, `forecastReschedule`, `forecastSkipped`, `forecastVisibleWindow`, `forecastInboxTransitions`, `forecastDebts`. e2e (15): `forecast-add-as-bill`, `-bulk-mark-unplanned`, `-bulk-match-confident`, `-chart-day0-bank-balance`, `-dragging-plans-summary`, `-empty-bank-snapshot`, `-empty-projected-balance-set-snapshot`, `-enter-to-match`, `-inbox-pager`, `-move-date`, `-one-click-match`, `-pinned-inbox-collapsed-persistence`, `-pinned-inbox-sticky-on-scroll`, `-probably-paid`, `-tooltip-mark-missed`.
- Memory rule: this forecast is separate from the owner's own 13-week; keep the two un-tied only if that rule applies to this app (see open question 8).
- New app: omitted. `screens/plan/planData.ts` reads bills/recurring only.

### 2.5 `/reports` hub and five sub-pages

Shared (`reportsShared.tsx`): `ReportShell`, `ChartCard`, `PanelCard`, `ReportsBalanceTiles` (Amex, bank, cash buffer, total debt; `useGetDashboard`, `useListDebts`, `useListPlaidLiabilityAccounts`), `ReportsRangeControls` (Wk/Mo/Yr `TimeRangeToggle` plus compare-to-previous switch), `daysForMode`, chart wrappers and axis/tooltip formatters. Palette/anim: `chartTokens.ts`, `chartAnim.ts`.

| Page | Figures and endpoints | Charts | Interactions |
|---|---|---|---|
| Hub (`reports.tsx`) | tiles per report with Sparkline/MiniBars/RingStat/StackBar; `useGetForecast`, `useGetReportsSpendingFacts`, `useListDebts`, `useListDebtBalanceHistory`; `report-tile-*`, uncategorized tile | 5 mini viz | tile click -> sub-page |
| Spending | total, top category, top merchant, reimbursable split, uncategorized banner (`banner-uncategorized`, `button-recategorize-uncategorized`, `handleChange` -> `useUpdateTransaction`), `useGetReportsSpendingFacts`; helpers `categoryTotals`, `spendingHeatmap`, `dayOfWeekSpend`, `topMerchants`, `categoryMonthlyTrends`, `reimbursableSplit`, `uncategorizedSpend` | Area, 2 Bar, 2 Pie, heatmap | Wk/Mo/Yr, compare, popover |
| Cash flow | avg income/expense/net, savings rate, clipped-range note; `useGetForecastCashSignal`, `useListTransactions`, `useListRecurringItems`; helpers `dailyCashFlow`, `rollupByPeriod`, `withRunningNet`, `rolling30DayBurn`, `cashFlowKpis` | 2 Area, Bar, Composed, Line | Wk/Mo/Yr, compare; forecast loading/refresh banner/missing states |
| Debt | total, paid percent, months to free, interest saved, date; `useListDebts`, `useListDebtBalanceHistory`, `useGetAvalancheSettings/Extra`; helpers `payoffStackedSeries`, `snowballWaterfall`, `interestVsPrincipal`, `perDebtProgress`, `totalPaidOffSoFar`, `interestIfMinimumsOnly`, `payoffProjectionGauge`, `debtsKilledOrder`, `debtFreeCountdown` | 2 Area, 2 Bar, waterfall, gauge | per-debt progress rows |
| Budget | income, fixed, flex lines planned vs actual (`budget-flex-*`); `useGetReportsBudgetFacts`; `onTrackMonthStreak`, `underBudgetMonthStreak` | progress bars | streak |
| Behavior | habits: biggest charge, top merchant, next paycheck; `useGetReportsBehaviorFacts`; `noPurchaseStreak`, `hourlySpendClock`, `spendByDayOfMonth`, `personalityRadar`, `daysSinceLast` | Bar, 2 StreakCard | none |

- Exports: none found (no CSV code in reports; confirm, see 7).
- Tests: `reportsHubKitRestyle`, `cashFlowForecastMissing`, `spendingTotalHint`, `reportsAnalyticsExclusion`, `reportsBalances`, `reportsPalette`, `chartTokens`, `uncategorizedSpend`; e2e `reports-amex-tile`.
- New app: omitted. Recap (`screens/recap`) is a morning text, not a report.

### 2.6 `/transactions` Chase ledger (`transactions.tsx`, `transactions/*`, `account-page/*`)

- Answers: what happened in the checking account, what is unreviewed, what is the running balance.
- Reads: `useGetTransactionsLedger`, `useGetTransactionsBalances`, `useListPlaidItems`, `useListCategories`, `useListMappingRules`, `useGetForecast`, `useGetForecastCashSignal`, `useReviewInboxCount`, `useSpine`. Writes: `useUpdateTransaction`, `useCreateTransaction`, `useDeleteTransaction`, `useBulkSetForecastFlag`, `useUpsertForecastResolution`, `useDeleteForecastResolution`, `useSendTransactionsToReview`, `useUnsendTransactionsFromReview`, `useClearTransferOverride`, `useRefreshForecastBank`.
- Actions: add (`handleOpenNew`, `button-add-transaction`), edit dialog (`TransactionEditDialog`: category, is-transfer checkbox, reset transfer override), delete (`handleDelete`), inline amount (`InlineAmountEditor`, Enter/Escape, flip kind `handleQuickFlipKind`), inline date (`handleQuickDate`, `row-date-controls.tsx`), inline category (`handleQuickCategorize`, `category-picker.tsx`), merchant rename (`MerchantRenamePopover`), toggle forecast flag (`handleToggleForecast`, `handleNotPlanned`, undo `undoNotPlanned`), toggle bucket (`handleToggleBucket`: Wk/Mo/UN bubbles), toggle reviewed (`handleToggleReview`, `undoReviewToggle`), clear transfer (`handleClearTransfer`), refresh bank (`handleRefreshBank`, `action-refresh-bank-set-manual`), bulk bar (`bulk-bar`: send/remove forecast `bulkSetForecast`, mark reviewed/unreviewed, send to review `bulkSendToReview` with undo `action-undo-bulk-send-review`, bulk recategorize `bulkRule` with preview `use-bulk-recategorize-prompt`, undo `useRuleActionUndo`), select-all page / all matching / clear (`chase-select-*`), day group toggle `toggleDay`, select row `toggleOne`, auto-categorized rule link and undo (`link-auto-categorized-rule`, `action-undo-auto-categorize`).
- Review inbox (`ChaseReviewInbox`, `useChaseReviewWrites`, `useChaseHideReviewed`): to-review count, hide reviewed, clear reviewed, pager and load more (`chase-ledger-pager`, `chase-load-more`, `-after-today`, `-pending`).
- Account picker (`chase-account-picker`, `chase-account-options`; Chase-only, hidden when single, stale warning, Amex hidden from Chase).
- Calculations: `chaseEndingBalance` (`computeChaseEndOfMonthBalance`), `chaseScope` (`scopeChaseTransactions`, `dedupeTransactionsByIdentity`, `chaseMonthTotals`), `runningBalance` (`computeRunningBalances`, day net `day-net-*`), `accountBalance`, `effectiveSnapshot`, `bucketSpend`, `chase-insight-strip.tsx`.
- Charts: `BalanceTrendChart` (627 lines), Sparkline, StackBar; month navigator (`month-navigator.tsx`), `stat-chip.tsx`.
- States: `chase-empty`, `chase-ledger-error`, `chase-balance-unavailable`, `chase-stats-no-account`, pending group `group-pending`.
- Tests: unit `chaseBucketChip`, `chaseForecastInclusion`, `chaseMonthEdge`, `chaseReviewInbox` (937 lines), `chaseReviewed`, `chaseStats`, `chaseTrendToday`, `chaseOnlyForecast`, `chaseScope`, `chaseEndingBalance`, `runningBalance`, `statChip`, `chaseInsightStrip`, `rowDateControls`; e2e (20 `transactions-*`, 4 `chase-*`, plus `matched-rule-chip-surfaces`).
- New app: weakened. Activity (Ledger, Review) covers search by range, "needs filing", file-under sheet, splits and reviewReason. Missing: account scope, running balance and day net, ending balance, forecast flag, bulk bar, inline amount/date/kind edit, delete, create, transfer override, month trend chart.

### 2.7 `/amex` (`amex.tsx`, `amex-card-band.tsx`, `bucket-bubbles.tsx`)

- Answers: what is on the card, what to repay, which spending is mine, work or owed.
- Reads: `useListTransactions`, `useGetAmexWeeklyPayoff`, `useListDebts`, `useListPlaidItems`, `useListCategories`, `useListMappingRules`, `usePlaidSync`; list is virtualized (`useWindowVirtualizer`). Writes: `useUpdateTransaction`, `useBulkUpdateTransactions`.
- Actions: per-row bucket (`setRowBucket`, bubbles `onBubbleToggle`), category (`setRowCategory`), reimbursable (`setRowReimbursable`), external-card mark/clear (`button-mark-external-card-*`, `button-clear-external-card-*`, `badge-external-card-*`), transfer badge and override clear (`badge-transfer-*`, `button-clear-transfer-*`, overridden/cleared mobile badges), merchant rename, quick date, refresh (`handleRefreshAmex`), anchor/ending-balance (`submitAnchor`, `clearAnchor`), day toggle, hide reviewed filter (#495), week/month toggle.
- Bulk bar: set bucket, set category, set reimbursable, set owed-by (`input-bulk-owed-by`, `button-bulk-clear-owed-by`), mark/unmark reviewed, progress text, failure panel with per-row failures, retry failed (`runBulkRetry`), dismiss (`dismissBulkFailures`), bulk recategorize rule prompt (`bulkRule`).
- Auto-review: choosing any bucket sets `reviewed=true`; clearing unsets it (code near lines 1395-1461); reimbursable bubble does the same.
- Calculations: `amexEndingBalance` (`resolveAmexDebt`, `resolveAmexAnchor`, `computeAmexEndOfMonthBalance`), `amexBalanceWindow` (`buildBalanceWindow`, MAY_2026 cutover), `reportsBalances` (`resolveAmexRevolvingBalance`), `runningBalance`, `amexBrand`, weekly payoff endpoint.
- Charts: `BalanceTrendChart`, `BucketBubbles`.
- Tests: unit `amexPageBucketAutoReview`, `amexPageMonthRefetchOnFocus`, `amexPageMonthRendersWithoutTrend`, `amexPagePerfTweaks`, `amexSourceCardLabel`, `amexEndingBalance`, `amexBalanceWindow`; e2e (12): `amex-bucket-bubble-auto-review`, `-reimbursable-bubble-auto-review`, `-bulk-action-bar` (+ `-bucket-owedby-reimb`, `-failures-retry`), `-month-not-trimmed` (+ `-after-recovery`), `-relink-duplicate-no-double-balance` (+ `-with-transactions-`), `-running-balance`, `-transfer-override`, `-wk-toggle-row-stability`; `transactions-amex-ignore-row-dim`.
- New app: omitted (Amex rows appear in Activity with no card-level view; `reimbursable` appears only in `activity/RowSheet.tsx`; no owed-by, external card, transfer override).

### 2.8 `/debts` (`debts.tsx`)

- Cards per debt with payoff date, target highlight, paid-off celebration (`debt-card-paid-off*`), empty state. Hooks: `useListDebts`, `useListDebtBalanceHistory`, `useGetAvalancheSettings`, `useGetAvalancheExtra`. Helpers `debtBalance` (`effectiveDebtBalance`, `pendingPaymentTotalOf`), `avalanche.ts`.
- Tests: `debtBalanceParity`, `debtsPagePaidOff`, `debtsPagePlanMultiTarget`, `debtsPageRowStability`, `debtsPageTargetExtra`; e2e `debts-empty-state`, `debts-payoff-dates`, `debts-target-toggle-row-stability`.
- New app: weakened (`PlanDebt`).

### 2.9 `/avalanche` (`avalanche.tsx` and 5 components)

- Answers: how to pay debts off fastest with the budget.
- Actions: add/edit debt (`DebtDialog`, `handleSave`, `useCreateDebt`, `useUpdateDebt`), delete (`deleteDebt`, `useDeleteDebt`), record payment (`PayDialog`, `useCreateDebtPayment`), pay target buttons (`btn-pay-target`, `this-month-pay-buttons`), `togglePayExtra`, sync minimums from bills (`useSyncDebtMinimums`), budget slider (`useUpdateAvalancheSettings`, `text-avalanche-budget-live`, `text-room-left`), add card to avalanche (`add-card-to-avalanche.tsx`), card config (`avalanche-card-config.tsx`), schedule card (`avalanche-schedule-card.tsx`), multi-target plan.
- Figures: hero payoff percent and debt-free date (`avalanche-hero`, `avalanche-debt-free-hint`), this-month targets (`panel-this-month`), strategy verdict (`strategy-verdict`), debts table; `forecastDebts`, `reportsAnalytics.payoffProjectionGauge`; sim input `debtToSim`.
- Tests: `avalancheBudgetSlider`, `avalancheDebtsTable`, `avalancheForecastInvalidation`, `avalancheHeroPayoff`, `avalanchePagePlan`, `avalanchePagePlanMultiTarget`, `avalanche.test` (lib); e2e `bills-avalanche-locked-row`, `bills-avalanche-nav`, `bills-debt-payoff-celebratory-row`.
- New app: weakened. `PlanDebt` has strategy (avalanche/snowball), extra, balances, milestones; `useCreateDebtPayment`, `useGetDebtPlan`. Missing: sync minimums, add card, per-month target panel, verdict.

### 2.10 `/bills` and `/bills/all`

- Overview (`bills-overview.tsx`, `useGetBillsSummary`, `useSpine`): income, bills, debt minimums, committed, outflow, net (`text-overview-*`), biggest card, month card, next bill, refresh banner.
- All bills (`bills.tsx`): month picker (`button-prev-month`/`-next-month`, `text-current-month`), add/edit dialog (`openNew`, `openEdit`, `onSubmit`, create another `onCreateAnother`, frequency select, category picker, one-time date, day of month, anchor date, income toggle), delete (`onDelete`, `onDeleteRow`), active toggle (`onToggleActive`), actual vs planned per row (`card-actual-this-month`, `text-actual-*`), per-paycheck row, debt minimums card (`card-debt-minimums`, paid state), archived debts, category chips, net monthly, health check (`bills-health-check.tsx`). Helpers `billsRowAmount.formatBillRowAmount`.
- Tests: `billsCategoryPicker`, `billsOneTimeMove`, `billsOverviewSpine`, `billsRowAmount`; e2e (8): `bills-actual-vs-planned-indicator`, `-avalanche-locked-row`, `-avalanche-nav`, `-category-picker-and-hand-planned`, `-debt-payoff-celebratory-row`, `-month-picker-summary`, `-month-picker`, `-per-paycheck-row`.
- New app: weakened (`PlanBills`: add/edit/delete, cadence, kind, category; no month picker, no actual vs planned, no health check).

### 2.11 `/budget` (`budget.tsx`, `budget/allowanceCard.tsx`, `budget/planStrip.tsx`)

- Answers: how much did I plan and spend per category this month.
- Reads: `useGetBudgetMonth`, `useListCategories`, `useListMappingRules`, `useListTransactions`. Writes: `useUpsertBudgetLine`, `usePinBudgetLine`, `usePinBudgetMonth`, `useSeedDefaultBudget`, `useCreateCategory`, `useUpdateCategory`, `useDeleteCategory`, `useUpdateTransaction`.
- Actions: month prev/next, pin or unpin the month (`handleTogglePinMonth`, `button-toggle-pin-month`), edit planned (`handleUpdatePlanned`, `handleBlur`, Enter/Escape), auto-pin line when typing a plan into a bill/debt row (`handleAutoPinLine`), "where did this come from?" popover (`button-planned-source`, `planned-source-bill-list`, source badge kinds bills/pinned/derived/manual), My budget add / rename / delete with warnings (`handleAddCategory`, `handleRenameMyBudgetCategory`, `handleDeleteMyBudgetCategory`), actuals popover with running totals (`actuals-row`, `actuals-running`, hidden tail `actuals-hidden-tail`, split rows), re-categorize inline (`handleAssignTxn`, `handleReassignTxn`, `item-reassign`, undo `action-undo-reassign`), categorize uncategorized (`button-categorize`), drilldown icons to Chase and Amex (`icon-drilldown-transactions`, `icon-drilldown-amex`), view all (`button-view-all`).
- Calculations: hero basis, committed bar, planned, tiles income / left-to-earn / spent; envelope grid; pace analysis strip (`analysis-pace`, `analysis-strip`); allowance card (`useWeeklyBucketLabels`); plan strip (StackBar).
- Tests: `budgetAnalysisStrip`, `budgetEnvelopeGrid` (538 lines), `budgetInlineCategorize`, `budgetMyBucket`, `budgetPendingOnce`; e2e (8) `budget-actuals-popover-reassign-undo`, `-actuals-running-totals`, `-amex-drill-down`, `-drilldown-icon`, `-hand-planned-rename`, `-my-budget-delete-warn`, `-my-budget-rename-duplicate`, `-popovers-and-mapping-edit`.
- New app: weakened (`PlanCategories`: month nav, planned edit via `useUpsertBudgetLine`). Missing: pin, source popover, My budget CRUD, actuals drill, re-categorize, pace.

### 2.12 `/allowances` (`allowances.tsx`)

- Answers: how each person is doing against the weekly limit.
- Reads `useGetSettings`, `useListCategories`, `useListTransactions`, `useWeeklyBucketLabels`; writes `useUpdateSettings` (`savePlanned`), `useUpdateTransaction`.
- Actions: per-card planned edit (`allowance-edit-planned`, `input-planned`), bucket select per txn (`allowance-bucket-select`), category select, split transaction (`SplitTransactionDialog`, `allowance-split`), popover details, week navigation (`addDays`).
- Figures: per-person state, variance (`allowance-variance`, 8-week variance), over-streak and praise (`allowance-over-streak`, `allowance-praise`), groups, pending totals. Helpers `weeklyBuckets`, `weeklyStreak`, `bucketSpend`.
- Tests: `allowancesKitRestyle`; none e2e.
- New app: weakened (`PlanWeek` + `useListAllowancePlans`, `useCreateWeekAdjustment`; has "Where the suggestion comes from"). Missing: per-transaction bucket assignment, 8-week variance, streak/praise.

### 2.13 `/mapping-rules` (`mapping-rules.tsx`, `SortableRuleRow`, `CategoryDropTarget`, `rule-matches-preview-dialog.tsx`)

- Answers: how merchants map to categories.
- Reads `useListMappingRules`, `useListCategories`; writes `useCreateMappingRule`, `useUpdateMappingRule`, `useDeleteMappingRule`, `useReorderMappingRules`, `useRecategorizeTransactionsByPattern`, `useUncategorizeTransactionsByIds`; previews `usePreviewMappingRuleRecategorize`, `usePreviewMappingRuleRecategorizeByPattern`; test `useTestMappingRules`.
- Actions: add rule (`handleAddRule`, `submitMappingRule`) with live match preview (`rule-add-preview`) and prompt to recategorize existing (`useBulkRecategorizePrompt`, `link-show-rule-matches-add`), edit (`startEdit`, `saveEdit`, priority input, category change `handleEditCategoryChange`, edit preview `rule-edit-preview`), delete with undo, per-category cards (`rule-category-cards`, collapse each/all, persisted via `saveCollapsedCategories`), drag a rule onto a category strip to recategorize (`category-drop-strip`, touch support), drag to reorder priority (`handleDragEnd`, `reorderWithinCard`, up/down buttons `rule-up/down`), "test a description" (`input-test-description`, `handleRunTest`, `btn-run-test`, `test-result`), search (`input-search-rules`), bulk bar (select all visible `toggleAllVisible`, bulk change category with undo, bulk delete with undo, clear), focus pill (`focus-pill`, deep link highlight), undo reassign.
- Tests: unit `mappingRulesAddPromptsBulk`, `mappingRulesBulkChangeCategory`, `mappingRulesFocusHighlight`, `mappingRulesFocusPillPersistence`, `mappingRulesRestoreNoPrompt`, `mappingRulesSearchFilter`; e2e (9) `mapping-rules-add-bulk-undo`, `-add-recategorize-preview`, `-bulk-delete`, `-collapsed-persistence`, `-drag-to-category`, `-drag-to-category-touch`, `-edit-recategorize-preview`, `-edit-undo-roundtrip`, `-per-category-cards`.
- New app: weakened. `activity/RulesView` lists learned rules (scope any/this account/similar amounts; apply retroactively, edit, delete). Missing: manual rule create, priority/reorder, test, bulk, preview, drag.

### 2.14 `/settings` (`settings.tsx` + `plaid-link-button`, `plaid-reconnect-button`, `plaid-sync-history`, `owner-invitations`, `owner-bank-health-sweep`, `plaid-reauth-banner`, `debt-plaid-link`, `post-link-*`, `sync-button`)

- Actions: link bank (`PlaidLinkButton`, `usePlaidLink`), reconnect (`PlaidReconnectButton`, relink fallback), sync now (`handleSync`, `button-sync-*`), force refresh and re-enable (`button-force-refresh-*`, `clearRefreshDisabled`), unlink with disconnect guard dialog (`handleUnlink`, `dialog-disconnect-guard`, remove anyway), delete item (`deletePlaidItem`), refresh consent expirations (`handleRefreshConsentExpirations`), badges (needs reconnect, still preparing, consent stale, plaid env), import cutoff date (`useUpdatePlaidImportCutoffDate`), non-prod link cleanup (`useCleanupNonProdPlaidItems`, dev only), duplicate count and merge (`useGetDuplicateTransactionCount`, `handleDedupeTransactions`, `button-dedupe-transactions`), workbook import (`handleFileUpload`, `importWorkbook`, `useImportWorkbook`, sample file `sample/Hubele_Family_Budget_v36.xlsx`, toast `button-toast-view-import-matched-rules`), tracker editor (days-since trackers: `addTracker`, `removeTracker`, `saveTrackers`, `resetTrackers`, validation), bucket labels (`saveBucketLabels`, `resetBucketLabels`), sync history (`plaid-sync-history.tsx`: copy request id, pending cleanup), owner invitations, owner bank-health sweep, link to mapping rules card, post-link debt creation (`post-link-debt-dialog.tsx`, progress panel).
- Tests: unit `settingsBankReconnect`, `settingsDedupeTransactions`, `settingsPlaidPolling`, `settingsRefreshConsentExpirations`, `settingsTrackerValidation`, `settingsWorkbookImportToast`, plus component tests (`plaidReauthBanner`, `plaidReconnect*`, `plaidSyncHistory*`, `debtPlaid*`, `ownerInvitations`, `ownerBankHealthSweep`, `sync-button`, `plaidLinkButton`, `use-plaid-sync`); e2e `settings-reconnect-relink-fallback`, `toast-reconnect-relink-fallback`, `plaid-link-button-reauth-guard`, `plaid-sync-error-toast`.
- New app: weakened. `Household` + `BankLink` + `Members` cover link, reconnect, force refresh, unlink, invitations, members. "Classic tools" section points to `/classic/` for workbook import, duplicate clean-up and link clean-up (hidden). Trackers, bucket labels, import cutoff, sync history: omitted.

### 2.15 `/plaid-oauth` (`plaid-oauth.tsx`)

- Exchanges public token (`useExchangePlaidPublicToken`, `usePlaidLink`, `onSuccess`). Test: `h2/src/screens/plaid-oauth/plaidOAuth.test.ts` only.
- New app: preserved.

## 3. Shell and cross-cutting

- Navigation (`components/layout.tsx`, 729 lines): five areas with ribbon and sub-items. Home (Overview `/banking`, Chase, Amex, Budget, Allowance), Forecast (Overview, Forecast, Bills), Spending (Spending, Budget, Allowances, Reports), Review (Review `/review`, Chase, Amex), Debt (Debt, Debts, Debt report); footer links Mapping rules and Settings. Desktop navy rail with wordmark, area ribbon (`tab-ribbon.tsx`), account menu; mobile menu (`button-mobile-menu`, `mobilenav-*`, `mobilenav-area-*`), "More" overflow (`topnav-more`, `morenav-*`), review badge (`topnav-review-badge`, `useReviewInboxCount`), rail badges.
- Prefetch: `lib/routePrefetch.ts` exports one `import()` per page; used on hover/focus and idle after first paint, same importers as `App.tsx` lazy routes so they cannot drift.
- Mutation invalidation: `lib/mutationInvalidation.ts` (`invalidateAfterWrite` refreshes spine, bank-balance explain, ledger; `OWN_INVALIDATION` meta opts out; `onWriteSuccess`), `invalidateForecast.ts`, `forecastResolutionCache.ts`. h2 has its own `data/mutationInvalidation.ts`.
- Plaid reconnect listener: `plaid-reconnect-listener.tsx` listens for `window` event `plaid:reconnect` (`dispatchPlaidReconnect`) so a toast or banner opens Link in update mode without navigating; relink fallback when update mode fails; `plaid-reauth-banner.tsx`.
- Version prompt: `version-update-prompt.tsx` (no polling; checks on boot/focus; one self-reload guarded by `h2:version-self-reloaded`; manual banner otherwise). h2 has `shell/VersionUpdatePrompt.tsx`.
- Toasts: `ui/toast.tsx`, `hooks/use-toast.ts`, undo toasts (`useRuleActionUndo`, `ruleActionMessage`, `rule-attribution-summary`).
- Reduced motion: `hooks/useReducedMotion.ts`, `useCountUp.ts`, `chartAnim.ts`.
- Error/loading: `page-error-boundary.tsx`, `page-skeleton.tsx`, `data-state.tsx` (loading, empty, error, stale), `queryState.ts`, `spineRecovery.ts`, `bank-snapshot-freshness.tsx`.
- Bundle: `vite.config.ts` `manualChunks`: `vendor-charts` (recharts, d3), `vendor-react` (react, react-dom, scheduler, wouter, clsx; clsx pinned so the entry does not import the charts chunk), `vendor-clerk`, `vendor-query`, `vendor-dnd`; per-page lazy routes; entry-graph check script `check-entry-graph.mjs`.
- Mobile: `use-mobile.tsx`, separate mobile rows in Amex.
- Tests: `appShell.test.tsx` (580), `a11y-smoke.spec.ts`, `perf-open.spec.ts`.

## 4. Hidden or easy-to-miss capabilities (confirmed in source)

| Capability | Where | Evidence |
|---|---|---|
| Amex bucket auto-review (choosing a bucket marks reviewed) | `amex.tsx` ~1395-1461 | e2e `amex-bucket-bubble-auto-review`, unit `amexPageBucketAutoReview` |
| Reimbursable bubble auto-review | `amex.tsx` `setRowReimbursable`, `reviewedPatch` | e2e `amex-reimbursable-bubble-auto-review` |
| External-card mark/clear | `amex.tsx` | testids `button-mark-external-card-*`, `badge-external-card-*` |
| Transfer override and reset | `amex.tsx`, `transactions.tsx`, `TransactionEditDialog` | e2e `amex-transfer-override`, `transactions-transfer-override`, `transactions-reset-transfer-override` |
| Owed-by (bulk set/clear) | `amex.tsx` `bulkSetOwedBy` | e2e `amex-bulk-action-bar-bucket-owedby-reimb` |
| Bulk bar retry / dismiss failures | `amex.tsx` `runBulkRetry`, `dismissBulkFailures` | e2e `amex-bulk-action-bar-failures-retry` |
| Forecast look-back panel | `forecast.tsx` `forecast-lookback-panel`, forecast-from setting | `forecastMinFromDate` |
| Month close / reopen with gap note | `forecast.tsx` `closeMonth`, `onReopenMonth` | `useCloseForecastMonth`, `month-gap-at-close` |
| Partial payment and remainder | `forecastMatch.partialRemainder`, `PlanDropRow` | testids `plan-partial-*` |
| Mark missed (row and chart tooltip) | `onMarkMissed`, `tooltip-mark-missed-*` | e2e `forecast-tooltip-mark-missed`, `forecastMissedActions` |
| Reschedule / move plan date / skip | `onSetNewDateFromBucket`, `onMoveSave`, `onSkipFromBucket` | `forecastReschedule.test.ts`, e2e `forecast-move-date` |
| Match all confident | `pickConfidentBankMatches` | e2e `forecast-bulk-match-confident` |
| Suggested match accepted with Enter | `InboxCardView` | e2e `forecast-enter-to-match` |
| Match-to select (ranked dropdown) | `dragging-plan-match-*`, `rankPlansForBank` | `forecastDropdownPlanFilter` |
| Probably-paid strip (confirm/partial/reject, confidence) | `ProbablyPaidStrip` | `forecastProbablyPaid` |
| Pinned inbox with pager, sticky, persisted collapse | `forecast.tsx` | e2e `forecast-pinned-inbox-*`, `forecast-inbox-pager` |
| Cash-freed banner on debt payoff | `CashFreedBanner` | `forecastInboxTransitions` |
| Budget pinned month and pinned line | `usePinBudgetMonth`, `usePinBudgetLine` | `budget.tsx` 455-487 |
| "Where did this come from" planned-source popover | `budget.tsx` ~1129 | `budget-popovers-and-mapping-edit` |
| Budget inline re-categorize with undo | `handleReassignTxn` | `budgetInlineCategorize`, e2e `budget-actuals-popover-reassign-undo` |
| Mapping rules "test a description" | `handleRunTest`, `useTestMappingRules` | testids `btn-run-test`, `test-result` |
| Reorder priority (drag and up/down) | `useReorderMappingRules`, `SortableRuleRow` | priority `(N - idx) * 10` |
| Bulk recategorize with preview and undo | `use-bulk-recategorize-prompt.tsx`, `rule-matches-preview-dialog.tsx` | e2e `transactions-bulk-recategorize-preview/undo`, `mapping-rules-*-recategorize-preview` |
| Settings duplicate merge | `useDedupeTransactions`, `useGetDuplicateTransactionCount` | `settingsDedupeTransactions` |
| Workbook import with sample xlsx | `settings.tsx` ~1288 `sample/Hubele_Family_Budget_v36.xlsx` | `settingsWorkbookImportToast` |
| Import cutoff date per bank | `useUpdatePlaidImportCutoffDate` | settings |
| Non-prod link cleanup (dev only) | `useCleanupNonProdPlaidItems` | `banner-non-prod-cleanup` |
| Sync history with request-id copy | `plaid-sync-history.tsx` | `plaidSyncHistory*` tests |
| Allowance purchase splitting | `SplitTransactionDialog` | `allowances.tsx` |
| Allowance 8-week variance, streak, praise | `allowances.tsx` | `allowance-variance-*`, `allowance-over-streak` |
| Reports compare-to-previous | `ReportsRangeControls` | Cash flow, Spending, Budget pages |
| Reports heatmap, streak board, radar, spend clock | `reportsAnalytics.ts` | `spendingHeatmap`, `noPurchaseStreak`, `personalityRadar`, `hourlySpendClock` |
| Days-since trackers (custom matchers) | `daysSinceTrackers.ts`, settings editor | `settingsTrackerValidation` |
| Weekly bucket labels (renamable Wk/Mo/UN) | `weeklyBuckets.ts`, settings | `useWeeklyBucketLabels` |
| Bank balance "why" explainer | `bank-balance-why.tsx`, route `bankBalanceExplain` | `bankBalanceWhy.test.tsx` |
| Bills health check | `bills-health-check.tsx` | none found |
| Add card to avalanche, sync minimums from bills | `add-card-to-avalanche.tsx`, `useSyncDebtMinimums` | avalanche tests |
| Post-link debt creation dialog and progress panel | `post-link-debt-dialog.tsx`, `post-link-progress.tsx` | `plaidPostLinkProgressPanel.test.tsx` |
| Owner bank-health sweep, owner invitations | `owner-bank-health-sweep.tsx`, `owner-invitations.tsx` | component tests |
| Chase hide-reviewed and clear-reviewed | `useChaseHideReviewed` | `chaseReviewed` |
| Recently-used row dimming for Amex ignored rows | `transactions.tsx` | e2e `transactions-amex-ignore-row-dim` |
| Tab ribbon and landing pointer glow | `tab-ribbon.tsx`, `landing.tsx` | none |

## 5. What the new app adds that classic lacks

| Feature | h2 files | API routes | Pure logic for `lib/` |
|---|---|---|---|
| Today briefing and "one thing" attention | `screens/today/{Today,lowerSections,attention,WeekSection,LimitSource}`, `data/todayData.ts` | `GET /spine`, `/money/position`, `/bills`, `/allowance-plans`, `/agent/actions` | `today/attention.ts` |
| Activity review queue | `activity/{ReviewView,RowSheet,CategoryPickerSheet,useFiling}`, `words.ts` | `GET /categorization/review`, `POST /categorization/*`, `GET /category-decisions`, `POST /category-decisions/:id/undo` | `activity/words.ts` (reviewWhy, reviewFlags) |
| Learned rules | `activity/RulesView.tsx` | `GET/PATCH/DELETE /learned-rules`, `POST /learned-rules/:id/apply-retroactively` | none |
| Agent trail and undo | `activity/AgentTrail.tsx`, `trailWords.ts`, `data/trailQuery.ts` | `GET /agent/actions`, `POST /agent/actions/:id/undo`, `GET /agent/findings`, `POST /agent/findings/:id/*`, `GET /agent/runs` | `trailWords.ts` |
| Transaction splits | `activity/SplitSheet.tsx`, `splitMath.ts` | `GET/POST/DELETE /transactions/:id/splits` | `splitMath.ts` (parseCents, splitState) |
| Automation and backlog run | `household/{Automation,automationApi,automationWords}` | `POST /categorization/run`, `GET/PUT /categorization/settings`, `/ops/jobs`, `/ops/jobs/:id/retry` | `automationWords.ts` |
| Afford | `afford/{AffordSheet,AffordLauncher,verdict}` | `POST /money/afford`, `POST /wishlist/:id/evaluate` | `verdict.ts` |
| Ways back | `today/WaysBackSheet.tsx` | `GET /money/ways-back`, `POST/DELETE /money/week-adjustments` | none |
| Ask (SSE chat) with conversations | `ask/{Ask,askData,askParts,askWords}`, `data/aiStream.ts` | `POST /ai/chat`, `/ai/conversations` | `aiStream.ts` parser |
| Proposals (agent suggestions) | `ask/{Proposals,ProposalCard}` | `GET /agent/proposals`, `POST .../approve`, `.../reject` | none |
| Memory | `ask/AskMemory.tsx` | `GET /memory`, `PUT /memory/:scope/:key`, `DELETE /memory/:id` | none |
| Wishlist and goals | `plan/PlanWishlist.tsx` | `/wishlist`, `/goals` | none |
| Recap (morning text) | `recap/Recap.tsx`, `recapWords.ts` | `/recap/settings`, `/verify/*`, `/test-send`, `/pause`, `/unsubscribe`, `/deliveries`, `/preview`, `/history`, `/generate-now` | `recapWords.ts` |
| AI cost and budget | `household/AiCost.tsx` | `GET /ai/usage/summary`, `PUT /ai/budget` | none |
| Members and invitations | `household/Members.tsx` | `/members`, `/invitations` | none |
| Money and date helpers in plain words | `lib/money.ts`, `lib/dates.ts`, `plan/format.ts` | n/a | all |

Design-only: `screens/design/*` (kit showcase, not product).

Note: pure logic that can move into shared `lib/`: `splitMath`, `verdict`, `attention`, `words`, `trailWords`, `format.ts`, `aiStream`. UI, hooks and sheets stay in their screens. Do not move `data/mutationInvalidation.ts` or `spineRecovery.ts` without diffing against the classic copies of the same name.

## 6. Client-side money helpers in classic that must survive

| File (lines) | Computes | Callers |
|---|---|---|
| `lib/accountBalance.ts` (124) | balance at end of a month or date from anchor | Chase, Amex, `BalanceTrendChart` |
| `lib/amexEndingBalance.ts` (346) | Amex debt/anchor resolution, end-of-month balance | `amex.tsx`, `reportsBalances` |
| `lib/amexBalanceWindow.ts` (197) | balance window with the May 2026 cutover | `amex.tsx` |
| `lib/chaseEndingBalance.ts` (175), `chaseScope.ts` (101) | Chase scope, dedupe, month totals, end balance | `transactions.tsx` |
| `lib/runningBalance.ts` (66) | per-row running balance, newest-first sort | Chase, Amex rows |
| `lib/effectiveSnapshot.ts` (164) | which bank snapshot is authoritative | forecast, Chase, command center |
| `lib/forecast.ts` (255) | expand recurring items, daily and monthly series | forecast, reports |
| `lib/forecastMatch.ts` (1045) | candidate matching, suggestions, confident and one-click picks, buckets, partial remainder | `forecast.tsx` |
| `lib/forecastReconcile.ts` (194) | bank vs plan reconcile (gap at close) | forecast month close |
| `lib/forecastPastDue.ts` (128), `forecastDebts.ts` (259) | dragging plans, debt-linked payoffs and transitions | forecast, bills, debts |
| `lib/reportsAnalytics.ts` (965) | all report series (see 2.5) | `reports/*` |
| `lib/reportsBalances.ts` (275) | revolving Amex, buffer status | reports tiles, Amex |
| `lib/debtBalance.ts` (81), `avalanche.ts` (26) | effective debt balance with pending payments, formatting | debts, avalanche, forecast |
| `lib/bucketSpend.ts` (87), `weeklyBuckets.ts` (59), `weeklyStreak.ts` (25), `discretionarySpend.ts` (140) | bucket spend in window, labels, splurge detection | budget, allowances, command center |
| `lib/uncategorizedSpend.ts` (65) | uncategorized spend filter | reports, spending banner |
| `lib/billsRowAmount.ts` (54) | bill row amount display | bills |
| `lib/householdDay.ts` (59), `timeRange.ts` (88) | household day and month start, week and range math (tz canary test) | everywhere |
| `lib/daysSinceTrackers.ts` (73) | matcher compile for trackers | settings, behavior |

All have unit tests in `src/lib`; port the test with the file.

## 7. Open questions for the owner

1. Restore classic as THE app at `/`, with h2 screens (Today, Ask, Recap, Afford) added as new areas, or keep h2's five-area shell and bring classic pages in under it?
2. Forecast: restore the full classic forecast page (matching, inbox, month close) unchanged first, then modernize?
3. Reports: keep all five report sub-pages and the compare toggle, or fold into Plan and Recap?
4. Is anything in classic safe to drop (landing tiles, Command center vs Today overlap, Debts vs Avalanche duplication)?
5. Mapping rules and Learned rules: merge into one list, or keep both?
6. Is workbook import still needed (the `v36` sample is dated)? Same for the days-since trackers and bucket labels.
7. Are CSV or print exports wanted? None were found in classic source.
8. Should the 13-week and forecast-never-tied rule from the KFI dashboard apply here? It appears to be KFI-only; confirm for Hubele-Budget.

### Lead's defaults (the owner may override)

1. Classic is THE app; the new app's screens are added under its areas (approved plan, 2026-10-08).
2. Yes: move the full forecast page first, unchanged in behaviour, then modernize the chart and layout around it.
3. Keep all five reports and the compare toggle.
4. The landing becomes the dashboard; the command center's figures move onto it; Debts and Avalanche both stay until the owner says otherwise.
5. One Rules screen with two lists: rules you wrote and rules learned from corrections.
6. Keep workbook import, trackers and bucket labels (nothing is dropped without the owner's word).
7. No exports exist today; none added unless asked.
8. No: that rule belongs to the KFI dashboard, not this app.

## 8. Report

Classic has 20 route pages (23 URLs with aliases), about 250 actions by handler and test id census, about 31 chart components, 141 unit/component test files and 88 e2e specs plus the walk journey. The new app preserves only Plaid OAuth; it weakens Activity/Plan/Household coverage and omits forecast, reports, Amex, mapping rules management and settings trackers. Not verified: exact action and chart counts (grep census, floor values), per-component line counts of the Settings Plaid components (estimated), whether any CSV export exists (none found by search), and runtime behavior (nothing was run).
