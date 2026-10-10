# WP4b — a $0.00 anchor never drops money (lane 1)

Branch `fin/wp4b-zero-anchor`, from `origin/fin/integration` (70bff5d5). Not merged. Not deployed. This is the owner's decision: one population for every figure, and % paid is allowed to move for population fixes.

## The rule
- **Population:** every figure counts every active debt. That covers "$X left" and the names it lists, the Avalanche rows and their Totals, "% paid" and the milestones. An archived debt is in none of them. This is `inPayoffPopulation`.
- **% paid:** each debt is measured against the larger of its anchor and what it owes now, netted (`payoffBasisOf`). A debt anchored at $0.00 therefore counts as 0% paid of what it owes. `payoffPct` and `milestonesFor` both use this measure.
- **Stored anchors are not rewritten.**

## Root cause
- `inPayoffPopulation` (WP4) also required `originalBalance > 0`.
- The anchor is written only while it is null (`debtLiabilityApply.ts:120`, `routes/plaid.ts:262/334`, `debts.ts:311`). A card put on the plan while it read $0 keeps "0.00" after Plaid raises its balance.
- After lane 2 put `remainingDebtTotal` / `remainingDebtScope` on the predicate, that card dropped out of "$X left" and its names. The Accounts row, the Avalanche table and Reports still counted it, so the Avalanche Totals no longer matched its rows. On its own, the tile read "No balance left on any active debt."

## Fixture before → after
Scenario: `normal+offplan`, with Blue ••1001 ($684.12, on the plan) set to anchor 0.00 in the local fixture DB.

| Figure | Before (70bff5d5) | After |
|---|---|---|
| "$X left" / Avalanche Totals | $24,700.00 (HELOC and Upstart) | $25,384.12 (HELOC, Upstart personal loan and American Express ••1001) |
| Avalanche rows, summed | $25,384.12 (≠ Totals) | $25,384.12 (= Totals) |
| % paid (spine) | 27.35% | 26.81% (Blue at 0% of $684.12) |
| next milestone | Amex ••1001 paid off 2028-08 | unchanged |

Every unmodified scenario is unchanged: no fixture debt is anchored at $0.

## Tests
- `debtProgress.test`: the table now shows the pre-WP4, WP4 and WP4b figures per case: a $0.00 anchor, no anchor, a balance above its anchor, archived, netted. Also `inPayoffPopulation` and `payoffBasisOf`.
- `debtPlan.test`: a $0.00 anchor gives the same milestones as anchoring the debt at its balance; leaving it out does not.
- `spineParity`: a zero-anchored card is seeded. The spine reads 39.86%; WP4's rule would read 41.47%. `/dashboard` total is $10,634.52 across 3 active debts.
- `debtBalanceParity`: Avalanche Totals equals the sum of its rows. The dashboard's amount and names include the zero-anchored debt.
- `dashboard.test`: the old pin is flipped, and a new case covers a zero-anchored debt on its own.
- Lane 2's `lib/debtBalance.test` pin is flipped (770, names include "bare").
- The printer (`payoffPctBeforeAfter.test`) prints all three rules.
- All 7 new tests fail when the anchor clause is put back.

## Gates (one run each)
- typecheck clean.
- API: 247 files, 2,678 passed.
- Web, both TZs: one file failed, lane 2's `debtBalance.test`, which pinned the WP4 rule. I flipped it and re-ran that file alone: 5 passed. All other web files passed (1,984 UTC / 1,985 Chicago).
- build and entry graph: 619.2 KB.
- audit: 1 high, ignored.
