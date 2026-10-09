# C6 — Avalanche on the panel kit (2026-10-09)

Branch `restore/c6-avalanche`, base `ed8c0303`. Parity doc §2.9 and §8 C6. Composition and tokens only: no query, handler, simulation or money change.

## What changed
- `pages/avalanche.tsx`: `h1` "Debt" (the e2e heading) + reauth banner + `PageGrid`.
  - Paid-off banner span-12. Hero span-8 (same ids, `.bar-sweep` bar). The four stats are `StatBlock`s in one span-4 panel (2x2).
  - Payoff-order bars span-6 + This month span-6 (the survivor takes span-12 if the other is absent). Extra span-6 + Strategy span-6.
  - Your next 3 moves span-6 (still a `.space-y-3` holding a `.grid` of card `div`s, now one column) + schedule card span-6. Amex card config span-12. Tabs span-12 (Debts table, Projection, Chart, Archived are panels as before).
  - Cards on the page are `.panel` with `panel-head`. The drill-down dialog still uses the classic `Stat`.
- `avalanche-card-config`, `avalanche-schedule-card`: `.panel`.
- `add-card-to-avalanche`, `debt-plaid-link` (menu, picker, banner, shared with /debts): off-kit tokens (`text-muted-foreground`, `text-destructive`, `card-border`, `bg-primary`...) swapped for the kit's (`text-neutral-500`, `text-bad`, `border-brand-line`, `bg-brand-navy`...). No markup, test id or behaviour change.

## Capability ids (all kept)
AV-01..23: same hooks, handlers, dialogs and test ids; only wrappers and tokens changed. Existing suites pass unchanged: `avalancheHeroPayoff` (`.bar-sweep`), `avalanchePagePlan` (`.space-y-3` / `.grid > div`), `avalancheDebtsTable` (cell indexes, row order), `debtReauthBanner`, `debtPlaidReconnect`, `debtPlaidPickerInstitutionMatch`, `debtBalanceParity`.
- AV-15 now has coverage (`components/avalancheCardConfig.test.tsx`): states (In avalanche / Not linked / add button), tier writes tier + cadence into preferences keeping existing ones, Add to Avalanche creates the debt then sets APR percent to decimal and the minimum, and shows the server's reason on failure.
- New placement test in `avalanchePagePlan.test.tsx` (hero span-8 in the grid, next-3 column span-6).
- AV-22 chart tab: unchanged (not moved to `ChartPanel`; it is already inside a panel and its `LineTrend` height is fixed).

## e2e repaired in this PR
- `bills-avalanche-locked-row`: the focus ring is `ring-brand-navy`, not `ring-primary`.
- `bills-debt-payoff-celebratory-row`: opens edit through the row's `button-debt-actions-<id>` then `button-debt-edit-<id>` (the old last-button click is the menu trigger now).
- The e2e project typechecks; the specs were not run (need Clerk and a DB).

## Gates
typecheck (incl. e2e) clean; vitest UTC 1,429 passed / 4 skipped, America/Chicago 1,431 passed / 2 skipped; build OK, landing JS 562.5 KB of 580 KB, no recharts on open; audit 1 high, already ignored.
