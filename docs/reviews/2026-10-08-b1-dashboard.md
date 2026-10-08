# B1 — the dashboard preview at `/next/dashboard` (2026-10-08)

Branch `restore/b1-dashboard`, base `8d07020b` (B0). UI only: no API, spec or money-maths change. Every figure is read from an existing hook, and each panel loads on its own (skeleton, then content or a per-panel error). Layout is `PageGrid` (12 / 6 / 1 columns); the order below is the phone order. Panels fade up on the existing `tile-in` dial with `--stagger`; the reduced-motion kill already covers `.tile-in`. The meters are `CssFillMeter`, which sweeps once. The chart uses `CHART_ANIM` through `ProjectedBalanceChart`.

Files: `pages/next/Dashboard.tsx`, `pages/next/dashboard/*` (panels, `queries.ts`, `shared.tsx`, `dashboard.test.tsx`), `lib/attention.ts` (+ test). B0's files are untouched.

## Panel → source of every figure
| Panel (span) | Figure | Source |
|---|---|---|
| Today (12) | recap text + badge | `usePreviewRecap` (POST `/recap/preview`), asked once on mount. Text is `model.text` if present, else `template.text`. Badge: Demo (model.demo), Draft (model), Template |
| | the one next action | `lib/attention.ts` `attentionItems` over `useSpine` (bank, position.withinPlan, remainingWeek, reviewCount) and `useGetBillsSummary` (due today/tomorrow). First match wins |
| Accounts (12) | account list, identity, mask | `useListPlaidItems` → `identityOf` + `cardOrderOf` (B0) |
| | checking balance | `spine.bank.balance`, only on the account that matches the cash signal's account (mask) |
| | card / loan balance | `useListDebts` row whose `plaidAccountId` is that account |
| | statement balance | `useGetAmexWeeklyPayoff` card with that `plaidAccountId` |
| | minimum, due day | the same debt row: `minPayment` (blank if 0), `dueDay` ("The 22nd") |
| | data through, state | `item.lastSyncedAt` (household day). Words: Up to date, Out of date (>36 h), Needs reconnecting (`isPlaidReauthCode`, with `plaidReauthReason`), Last sync failed, Not synced yet |
| | Sync | `usePlaidSync().runSync({ itemId })` per bank (free sync) |
| Cash position (4) | bank today, freshness, why | `spine.bank`, `FreshnessLine`, `BankBalanceWhy` |
| | Room in the plan | `spine.position.safeToSpendNow`; caption "Until payday · date" or "This week's limit" from `horizonKind` |
| | low point, date, buffer | `spine.forecast.lowPoint/lowPointDate/cashBuffer`; "under the buffer by $X" is buffer minus low point, shown only when under; low is a dash when status is `no_data` / `not_yet` |
| Spending (4) | this week vs limit | `useGetMoneyPosition` `spentWeekDiscretionary` vs `weekCap` |
| | this month vs budget | `useGetBudgetMonth(monthStart).summary.expenses.{actual,budget}` |
| | allowances used | `bucketSpendInWindow` (command-center's helper) over the bounded transaction pull; caps from `useGetSettings` (weekly override respected) |
| | biggest charges | `isSplurge` + recurring screen (command-center's rules) → `CssBars` |
| Upcoming 14 days (4) | income / bills / card / debt payments | `useGetForecastCashSignal({horizonDays:90}).events` inside today..+14. Card vs debt: event `itemId` → `useListRecurringItems.debtId` → `useListDebts.type` (contains "credit" = card). Rows are not summed |
| | next bill | `spine.nextBill` |
| | account chip | the cash signal's resolved account ("Paid from") |
| Cash-flow forecast (8) | line, buffer, low point | `useGetForecastCashSignal({horizonDays: 30/90/180})`, built the same way as `pages/forecast.tsx`; `ProjectedBalanceChart` is `lazy()` |
| Debt (4) | total balance | sum of `useListDebts` balances, archived excluded (shown here, an account panel) |
| | % paid, paid down, new charges, milestone | `spine.debt.*` |
| Recent activity (8) | last 12 | `useListTransactions({from: today-30, to: today, limit: 12})`; category names from `useListCategories` |
| Needs review (4) | forecast review, categories, duplicates | `spine.reviewCount`, `useListCategorizationReview({limit:1}).total`, `useGetDuplicateTransactionCount` |

## Links
- Accounts: each card → `/next/accounts/:plaidAccountId` (B3). Activity rows → the same, or `/transactions` for a manual row. "All accounts" → `/next/accounts`.
- Cash: `/banking`. Spending: `/budget`, `/allowances`. Upcoming: `/bills`, `/forecast`. Forecast: `/next/forecast`. Debt: `/avalanche`, `/reports/debt`. Review: `/review` (x2), `/transactions` (duplicates).
- Action card: Reconnect and Sync → `/settings`, bills → `/bills`, review → `/review`, over the limit → `/allowances`.

## Not shown, and why
- Statement balance, minimum and due day for an account with no linked debt row (or an Amex statement we have no card for): a dash. There is no such field on `PlaidAccount`. Never zero, never estimated.
- Balance for savings or any non-checking, non-debt account: a dash. No endpoint reports a per-account balance except the checking roll-forward and the debt rows.
- Low point when the forecast status is `no_data` / `not_yet`: a dash.
- No "mark missed" or drag on the chart tooltip: the dashboard strips the dragged flag; those actions live on `/forecast`.
- Big-bill markers on the dashboard chart: left off (empty list); they stay on the full forecast.
- The spending window is a bounded pull (`limit` 100, week-or-month start to today). When it fills, the panel says "Showing the most recent 100 transactions." The allowances and biggest charges read that window.
- The weekly-allowance pager and the biggest-charges "month" selector from `/banking` are not reproduced; the panel links there.

## Bundle
- Landing JS: **578.1 KB** against 580 KB (base 576.7, +1.4 KB). Cause: the generated client lives in the entry chunk, and `usePreviewRecap` (`previewRecap`) is the only generated function this page adds that no other page used. I kept the generated hook (CLAUDE.md: never hand-write client hooks). Headroom is now 1.9 KB, so B2/B3 should not add new generated hooks without room being made.
- Recharts stays in `vendor-charts` (443 KB), not preloaded. `ProjectedBalanceChart` becomes its own 5 KB chunk, loaded when the forecast panel mounts. `Dashboard` is a 31 KB lazy chunk.

## Gates
- `pnpm run typecheck`: clean.
- h2budget vitest, UTC: 1296 passed, 4 skipped. `TZ=America/Chicago`: 1298 passed, 2 skipped. 30 new tests (panels, blanks, stale/reauth, the action cases, loading/error).
- `pnpm run build` OK; `check-entry-graph`: OK, no recharts on open.
- `pnpm audit --prod`: 1 high, already ignored (not new).
