# F — Spending › This week: the Amex line reconciles; Breakdown opens the Amex reconciliation (Task 5)

Branch `cons/f-amex-recon` from `consistency/integration` b4dce378 (= live 2633ce96). Local commit only: not pushed, not deployed.
Synthetic fixtures only. No classification, no stored record, no figure changed.

## Root cause
- The line printed `purchases`, `householdContribution.weeklyKnown` and `weeklyUnresolved` and called the last two "counted" / "not counted"; the same answer's `monthlyKnown` (purchases filed to the monthly allowance) and every purchase outside the two plans (bills, unplanned, reimbursable) were never on it.
- No figure was wrong: the line was incomplete, and "not counted" named only the unconfirmed part.

## What changed
### Server (additive, `features` tag, off the landing path)
- `AmexSummary.reconciliation`: `{ purchases, refunds, net, unresolved, ties, groups[9] }`.
- Groups, always all nine, in order: `weekly_known` · `weekly_unresolved` · `monthly_known` · `monthly_unresolved` · `bills` · `unplanned` · `reimbursable` · `not_counted` · `no_bucket`.
- Each group: `key`, `label`, `amount`, `count`, `rows` (≤ `rowsPerGroup`, largest first), `truncated`.
- Each row: `id`, `date`, `displayName`, `amount`, `pending`, `card {accountId, name, mask}`, `notes` (`not_filed` · `no_category` · `pending`).
- The partition is of `purchaseRows`, the rows `purchases` already counts. No rule of its own:
  - coverage = the household window's `classifyMovement` placement (via the row's `allowanceRowOf`);
  - the two plans' coverages = `breakdownCountedCoverages("week" | "month")`;
  - known vs unresolved = `isUnresolvedInPool`, the test `evidenceSplitCents` splits with, on the row's own evidence class.
- `ties` = Σ groups (amount and count) = purchases. `unresolved` = the two unresolved groups ("awaiting a decision"). `net` = purchases − refunds.
- Refunds are beside the groups, never in them.
- New pure module `lib/amexReconciliation.ts`; `lib/amexSummary.ts` adds one block and one field. OpenAPI + codegen.

### Web
- Line (`AmexWeekLine.tsx`): "Amex purchases $X · this week's plan $Y · monthly allowance $Z · Breakdown".
  - Only groups that hold a purchase, at most three inline, in the server's order; the rest in Breakdown.
  - "awaiting a decision $W" when the server's `unresolved` holds a purchase.
  - Empty week: "No Amex purchases this week" ("that week" on another week). No answer: nothing (never "$0.00").
- Breakdown (new lazy chunk `AmexWeekBreakdown.tsx`), opened in place:
  - "All Amex cards · Oct 11 – Oct 17";
  - one line per group: label · amount · count, each opening its rows: date · merchant · amount · card ••mask · notes;
  - each row opens the Amex page on that row (`txnRoute`, the one route rule);
  - "and N more → open in Amex" when a group is cut;
  - "Refunds −$R · credits, not in the total" when there are refunds.
- Open state lives in the page's `?open=` (`amex`, `amex:<key>`): Back from the Amex row lands on the same week with the same groups open. Another week clears it.
- `PeriodView.tsx`: passes the week, `?open=` and the row route. The household categories panel and its heading are untouched.

## The reconciliation on the purpose-built week (`amexReconciliation.integration.test.ts`)
Today Mon 2026-10-19; the week Sun 10/11 – Sat 10/17; all cards. Every name and amount is made up.

| group | amount | count | rows |
|---|---|---|---|
| This week's plan (weekly_known) | 110.50 | 3 | PANTRY MART 48.00 (weekly) · CORNER HARDWARE 22.50 (not filed yet) · FUEL STOP 40.00 (posted; its pending twin replaced) |
| This week's plan, awaiting a decision | 35.00 | 1 | PAYLATER INC (Plaid: loan payment; not filed yet · no category) |
| Monthly allowance (monthly_known) | 48.00 | 2 | BOOK NOOK 30.00 · GARDEN CENTER 18.00 (pending) |
| Monthly allowance, awaiting a decision | 0.00 | 0 | — |
| Bills | 15.99 | 1 | STREAMFLIX (confirmed bill match) |
| Unplanned | 90.00 | 1 | CONCERT TIX |
| Reimbursable | 64.00 | 1 | OFFICE DEPOT |
| Not counted | 25.00 | 1 | PRESENT SHOP (posted row carrying its pending row's "Ignore") |
| Not placed (no_bucket) | 0.00 | 0 | — |
| **Σ groups** | **388.49** | **10** | **= purchases 388.49 / 10 · `ties: true`** |
| Refunds (beside) | 12.00 | 1 | PANTRY MART +12.00 · net 376.49 |

- In no group: BALANCE TRANSFER 50.00 (other charge) · ONLINE PAYMENT 200.00 · the refund · both replaced pending rows · HOTEL HOLD 100.00 (expired hold) · AIRPORT LOUNGE 75.00 ("not mine") · CITY MARKET (checking).
- `no_bucket`: unreachable through the reads (the window and the summary read the same rows with the same pending rule); covered by the pure test.

## Against `householdContribution` (the brief: "must equal")
| plan figure | group | householdContribution | equal |
|---|---|---|---|
| weekly known | 110.50 | 173.50 | no — the plan holds two rows that are not purchases |
| weekly unresolved | 35.00 | 35.00 | yes |
| monthly known | 48.00 | 48.00 | yes |
| monthly unresolved | 0.00 | 0.00 | yes |

- The two rows, found by the test from the card's own period breakdown (pool rows that are in no group):
  - AIRPORT LOUNGE +75.00: marked "not mine". The payoff and `purchases` leave it out; the allowance window does not read "not mine", so the weekly plan counts it.
  - PANTRY MART refund −12.00: B6 nets a card refund into the plan it belongs to; refunds are outside the partition.
  - 110.50 + 75.00 − 12.00 = 173.50. Nothing adjusted.
- The week before (purchases only): all four equal, each card and every card (35.00 · 9.00 · 11.00 · 0.00).
- The existing S5 fixture, Platinum week: weekly_known 250.00 vs weeklyKnown 535.00 = + AIRLINE TICKET 300.00 (not mine) − WHOLE FOODS refund 15.00; the other three equal (test added).
- rich2 (preview), this week: weekly_known 261.70 vs weeklyKnown 238.71 = − ONLINE MARKETPLACE refund 22.99 (unflagged: nets "not filed yet" in the weekly plan); the other three equal. rich2 last week: all four equal.

## rich2 preview, this week (all cards, Sun Oct 11 – Sat Oct 17)
| group | amount | count |
|---|---|---|
| This week's plan | 261.70 | 6 |
| Monthly allowance | 154.90 | 3 |
| Unplanned | 38.75 | 1 |
| Reimbursable | 38.00 | 1 |
| **Σ** | **493.35** | **11** = purchases, `ties: true` |
| Refunds (beside) | 22.99 | 1 |

## Totals verified not changed (item 4)
- Before (b4dce378, fixture API from a temporary detached worktree, removed after) vs after (this branch), rich2:
  3 Amex summaries (this week, last week, month to date), 2 period breakdowns (week, month) and `/spine` — 0 differences outside the fixture's random ids.
- Dashboard Amex tile "Amex purchases · this week": $493.35 = `purchases.amount`, before and after.
- Amex page summary purchases: all cards month to date 932.65 / 17; per card this week 402.45 / 9 and 90.90 / 2 — same.
- Week tile / Spending "Counts toward plan": $596.32 = the money position's `knownWeek`, before and after.
  - Household-wide (checking rows too): it exceeds the Amex weekly_known (261.70) by design. Test: the household week's known = the cards' weeklyKnown + the checking row.
- S5 hand-worked figures: every existing assertion unchanged and passing.

## On screen (rich2, this week)
- Before: "Amex purchases $493.35 · counted $238.71 · not counted $0.00" + Breakdown (scrolled to the categories panel).
- After: "Amex purchases $493.35 · this week's plan $261.70 · monthly allowance $154.90 · unplanned $38.75" + Breakdown (opens the Amex reconciliation in place; Reimbursable $38.00 and "Refunds −$22.99 · credits, not in the total" inside).

## Tests added / changed
- API `lib/amexReconciliation.test.ts` (5, pure): each coverage's group; Σ = purchases; refunds beside; `ties` false when handed other purchases; rows bounded, ordered, notes; empty period; `no_bucket`.
- API `amexReconciliation.integration.test.ts` (9, own household): the table above; schema; each group's exact rows; excluded kinds in no group; posted row once; notes; the contribution comparison with the two rows found; the purchases-only week (all four equal, per card and all); the month; `rowsPerGroup`; household "Counts toward plan" ≥ the Amex group.
- API `amexSummary.integration.test.ts` +1: S5 ties; the gap = not mine − refund.
- Web `AmexWeekLine.test.tsx` (9, replaces E's 2): weekly + monthly · weekly only · unresolved · empty (this / that week) · refunds · at most three inline · Breakdown toggles the address · no answer · own words for not counted / not placed.
- Web `AmexWeekBreakdown.test.tsx` (5): scope line; groups (label · amount · count), none at $0.00; group token; rows and links; a row with no known ledger opens nowhere; "and N more"; refunds line.
- Web `spendingPeriod.test.tsx` +2: Breakdown and a group join `?open=` while `?start=` stays; row href; remount lands open; the arrows clear it; no line on an account's view.

## Gates
- `pnpm run typecheck`: pass.
- API, own DB `h2budget_test_f`: amexSummary, amexReconciliation (+ pure), amexCheckingScenario, periodBreakdown, periodBreakdownUsual, spineParity, moneyPosition, forecastLedger.golden, f2Classification — 10 files, 138 tests pass under TZ=America/Chicago and TZ=UTC.
- Full API suite (Chicago): 295 files pass, 2 skipped; 3417 tests pass, 2 skipped, 7 todo.
- Web vitest, all: Chicago 285 files, 2934 pass, 2 skipped; UTC 285 files, 2933 pass, 3 skipped.
- `pnpm run build && node scripts/check-entry-graph.mjs`: OK, landing 622,000 bytes = 622.0 KB (base 622,000: +0). Spending route chunk 36,225 → 37,521 bytes; new lazy `AmexWeekBreakdown` 3,732 bytes.
- Codegen: run; a second run leaves the generated diff byte-identical (drift 0). `lib/db/dist` key-order noise reverted.
- Headless (`scratchpad/preview/journeys-f.mjs`, rich2): 8 pass / 0 fail — chromium + webkit × 1280 + 390 × two journeys:
  1. Dashboard → This week → Breakdown → group → row → Amex row pinned (`data-focused`, in view) → Back on `/spending/week` with the groups open;
  2. another week (`?start=2026-10-04`) → the same → Back keeps `?start=`. Scroll drift after Back: 0 px. Shots: `scratchpad/preview/shots/f/`.
- Real-value rescan of the diff: none of the owner's live figures appear.

## Deviations from the brief
- Row link: `/amex?card=<card>&month=<YYYY-MM-01>&tx=<id>` from `txnRoute`, not `/amex?account=&tx=&month=<YYYY-MM>`: the Amex page reads `card` (or the old `accountId`) and only a `YYYY-MM-01` month; the plan's link would open All cards on the current month.
- The disclosures are `<details>` whose open state is the page's `?open=` (a summary click writes the address), so Back from the Amex row returns with them open.
- Added `reconciliation.unresolved` (the "awaiting a decision" total), so the browser adds nothing up.
- Notes are codes (`not_filed`, `no_category`, `pending`); the web words them "Not filed yet", "No category", "Pending". Group labels come from the server.
- The four plan groups equal `householdContribution` only while the plan holds nothing but purchases; the tests assert equality there and the exact two-row gap otherwise (above).
- Scope line reads "All Amex cards · Oct 11 – Oct 17" (brief-f's form).
- `journeys-e.mjs` journey 3 still expects the old line words and the scroll to the categories panel; it is superseded by `journeys-f.mjs` (not edited).

## Doubts for the owner
- A row marked "not mine" still counts in the household's weekly plan (the allowance window does not read "not mine"); the Amex purchases and payoff leave it out. Should "not mine" leave the plan too? Not changed here (classification).
- A refund nets the plan it belongs to, so "this week's plan $Y" (purchases) can sit above the plan's own Amex share by the refunds; the refunds line shows the difference.
- A posted row carrying its pending row's "Ignore" filing is an Amex purchase (the payoff reads the raw row) but the household does not count it: it shows under "Not counted". The same carry could make the Reimbursable group differ from `purchases.reimbursable` (raw flag).
- The label "This week's plan" also shows on another week's page.
- At most three groups inline: a fourth (Reimbursable on rich2) is only inside Breakdown.

## Not done
- firefox; axe; "before" screenshots.
- `journeys-e.mjs` journey 3 not updated.
