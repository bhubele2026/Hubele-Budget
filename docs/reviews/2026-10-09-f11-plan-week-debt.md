# F11 — Plan › Week on Allowances, Plan › Debt range on Avalanche (2026-10-09)

Branch `restore/f11-plan-week-debt`, base `71555b94`. The "also in h2" one-liners under the F1-F10 table. No server change; every figure is the server's.

## Panels
- **Allowances › Weekly plan** (`components/plan/WeekPlanPanel.tsx`, span-12 under the cards): the shared weekly limit with its source word ("set by you" / "set by <owner>" / "suggested") and the monthly figure; the server's suggestion as a seven-line ledger (take-home, less bills, debt minimums, extra, goals, left to spend, a week rounded down to $5); "Use the suggestion" (owner, hidden when it already matches to the cent); "Set your own" (owner; dollars above $0); per-member allowances, one row per member plan saved by its own plan id; a member only reads. Writes: `PUT /allowance-plans/{id}`; the 403/409 get words. It says it is the server's plan (it drives the dashboard's weekly position) and the cards above keep their per-week figures.
- **Avalanche › When it ends** (`components/plan/DebtRangePanel.tsx`, span-12 under the schedule card): the server's range ("Debt-free around Feb 2029 to Aug 2029", "or later" when open-ended), the projected-interest range, the "What this assumes" disclosure, avalanche against snowball (months, debt-free month, interest, first one cleared; the chosen plan marked), and milestones (achieved, next). Read-only: strategy and extra are set elsewhere on the page. Never one date and never a balance (the plan's per-debt detail is not shown).
- Ported (with tests) into `lib/planWords.ts`: `monthWords`, `parsePositiveDollars`, `plainDollars`, `planErrorWords`, `planFor`, `latestMemberPlans`, `matchesSuggestion`. Nothing imported from h2.

## One deviation, flagged: two hooks come from the main client module
`getDebtPlan` and `updateAllowancePlan` are not yet tagged `features` in the spec (only `listAllowancePlans` is), so `useGetDebtPlan` and `useUpdateAllowancePlan` are imported from `@workspace/api-client-react`. `useListAllowancePlans` comes from `/features`. The guard test passes (these two are not in the features module).
- Cost: landing JS 563.3 to 564.2 KB (the two hooks now count as used in the entry chunk).
- To finish as asked: tag both operations `features` in `lib/api-spec/openapi.yaml` (line 2407 and 2575), run the CI-style codegen (remove `lib/api-client-react/dist` and the tsbuildinfo, `pnpm --filter @workspace/api-spec run codegen`), commit the regenerated output, and change the two imports to `/features`. I tried to do this in this branch and the sandbox denied the command (it included deleting the generated `dist`), so I stopped there rather than work around it. It is a few minutes of work for whoever has that permission, or I can do it if you allow it.

## Tests
`lib/planWords.test.ts` (6), `components/plan/planPanels.test.tsx` (11: ledger, suggestion write and hidden-when-matching, own limit validation and write, member write by id, member read-only, derived word, range line and open-ended, comparison with chosen plan, milestones, nothing to project). Eight existing page tests (`allowancesKitRestyle`, `avalanche*`, `debtBalanceParity`) now mock the two panels away, since they are not about them.

## Gates
typecheck clean; vitest UTC 1,541 passed / 4 skipped, America/Chicago 1,543 passed / 2 skipped; build OK, landing JS 564.2 KB of 580 KB, no recharts on open; audit 1 high, already ignored.
