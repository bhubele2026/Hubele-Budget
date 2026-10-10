# WP4 (population half) — % paid measures the debts on the plan (lane 1)

Branch `fin/wp4-debt-population`, from `origin/fin/integration` (0251e5a3) with the fixed WP2 (e8d1d279) merged in. Not merged. Not deployed. This is approved number move (b). Labels are lane 2's half.

## The rule
"% paid" counts a debt only if it is active and has an anchor (`originalBalance > 0`). Its balance is netted of pending payments. That is the population "$X left" sums (`remainingDebtTotal`). One predicate, `inPayoffPopulation` (`@workspace/avalanche-core/pendingDebt`), drives both `payoffPct` and `milestonesFor`.

## Root cause
- `avalanche-core/index.ts:839-841` (`payoffPct`) and `avalanche-core/debtPlan.ts:294-296` (`milestonesFor`) filtered `status !== "paid_off"`.
- The server writes only `active` or `archived`. A debt that auto-archives at $0, is killed by a payment, or is archived by hand is never `paid_off`.
- So every archived debt kept its full anchor in the denominator and its balance in the numerator, and % paid read high.

## Fixture before → after (`/api/spine`, `/api/debts`)

| Scenario | Figure | Before | After |
|---|---|---|---|
| normal | % paid / milestone | 26% · 50% paid 2032-11 | unchanged |
| +archived (Platinum archived, $0 of $4,200) | % paid (spine) | 36.64% (tile 37%) | 26.00% (tile 26%) |
| +archived | next milestone "Halfway: 50% paid" | 2031-01 | 2032-11 |
| +archived | "$X left" | $18,500.00 | $18,500.00 (already active-only) |

## For Brad's real numbers (read-only)
Save `GET /api/debts` to a file, then run:

`DEBTS_JSON=<file> pnpm --filter ./artifacts/api-server exec vitest run src/lib/payoffPctBeforeAfter.test.ts --silent=false`

It prints each debt (counted or out) and % paid before and after. It makes no database or network call.

## Tests
- `spineParity`: an archived debt is now seeded. The existing 41.47% assertions fail on the old code. A new case pins the old population at 52.62% against the spine's 41.47%.
- `debtProgress.test`: a table, one row per case (archived at $0, archived with a balance, `paid_off`, no anchor, netted, over its anchor, archived only → null), each with its before figure.
- `debtPlan.test`: an archived debt does not move the milestones.
- `payoffPctBeforeAfter.test`: the printer above.

## Gates
- typecheck clean
- API: 246 files, 2,669 passed
- web: 1,916 passed (UTC) and 1,917 (Chicago)
- build and entry graph: 618.5 KB
- audit: 1 high, ignored

## For lane 2
Web `remainingDebtTotal` (`lib/debtBalance.ts`) filters `status === "active"`. `inPayoffPopulation` treats a missing status as active (the server always sends one). Lane 2 can adopt the predicate so that the web and the server share one population rule.

## Unverified
Brad's live before/after needs his `/api/debts` payload, run through the printer.
