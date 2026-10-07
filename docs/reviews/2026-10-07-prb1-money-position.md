# PR-B1 — the money position: available until payday, the weekly cap, allowance plans, the spine's `position`

- **Branch:** `reinvent/prb1-money-position`, cut from `main` at `8148f2a1`.
- **Package:** PR-B1 of the 2026-10-07 reinvention plan (backend money lane). Deterministic code only: no model
  call anywhere in this package.
- **All figures below are synthetic test fixtures.**

## The owner's decision

The plan's "Primary purpose", which takes precedence over everything else in it:

> control spending and get out of debt. Main screen: discretionary money until payday, within plan?, today's
> decision, debt actually paid down, next milestone. Realistic weekly limit; […] agent never silently raises
> budgets.

and its money layer, as approved:

> `computePosition(inputs)` → `{ safeToSpendNow, remainingWeek, availableUntilPayday, paydayDate, horizon,
> withinPlan, confidence, estimates[], assumptions[], degraded }`. Payday = first future income plan ≥ 25% of
> the largest income; `availableUntilPayday = max(0, min projected balance before payday − cashBuffer −
> reservesHeld)`; `remainingWeek = cap − spentWeek` using `householdMoney.ts classifyMovement` (PR-H core
> finally wired); `safeToSpendNow = min` of the two. Credit never appears (law test). Stale bank →
> `degraded: true`, never a false zero.

> `deriveWeeklyLimit` (take-home − committed − minimums − extra − goals → per week, floored to $5) with the
> derivation returned; `allowance_plans` table (shared pool + per member); owner override only, no job may
> write it.

The household-scenario contract (`2026-09-11-household-scenario.md`) the position must satisfy:

> **Lowest before payday:** the lowest end-of-day expected balance from today until the day before the next
> income that hasn't already been matched away.

And the standing law from PR-B2 (`2026-09-15-holdback-proof-only.md`): **the forecast may read low, never
high.**

## The model rule, in plain words

**Payday.** The first paycheck still on the forecast curve after today. It must be at least a quarter of the
household's largest active income plan, so a small reimbursement never ends the window early. A paycheck a
bank row already matched away is not on the curve, so the next one is payday. With no paycheck in the next
45 days, the window runs through this week's Saturday instead (`horizon.kind = "week_end"`).

**Lowest before payday.** The lowest end-of-day balance the curve expects from today up to the day before
payday (through Saturday, with no payday). It is read straight off `computeCashSignal().daily`, the same
curve the Forecast page and the spine's low point use, so every bill, debt minimum and payoff the curve
holds is in it.

**Available until payday** = lowest before payday − the cash buffer − money held for goals (none until goals
ship), never below zero. **Null with no bank data, or no curve: never a false zero.**

**Committed until payday** = the planned outflows landing in the window (shown, not subtracted again: the
curve already holds them).

**This week** (Sunday to Saturday, household calendar). Every row of the week runs through PR-H's
`classifyMovement`, with the ledger's tier-2 bill pairs handed in:

- **counts against the cap:** weekly-allowance spend, and spend nobody has filed yet
  (`needs_classification`). Deliberate: an unfiled purchase is still a purchase, and leaving it out would
  let the cap read high. Filing it unplanned, or matching it to a bill, gives the room back;
- **beside the cap, shown on its own:** unplanned spend, and monthly-allowance spend;
- **not spending at all:** bill-matched rows (confirmed or tier-2), transfers, card payments, debt payments,
  reimbursables, income.

**Remaining this week** = this week's cap − what counts against it (negative when over). **Pace allowed
today** = the cap × days elapsed, today included ÷ 7. **Within plan:** `over` when spent is above the cap;
`tight` when what is left is less than an even share of the cap for the days left (today included); else
`yes`. No cap set: all three are null.

**Safe to spend now** = the smaller of remaining this week and available until payday, never below zero;
null when available until payday is null.

**Confidence** is `estimated` when any plan in the window comes from a recurring item whose amount is marked
an estimate, and those plans are listed. **Assumptions** list the ledger's own tags on events in the window
(`overdue_assumed_unpaid`, …), then "available credit is not counted", "bank data from <day>", and, when they
apply, the 45-day fallback and "spending not yet filed counts against the weekly cap". **Degraded** is the
bank's own stale verdict (`computeBankFreshness`): every figure is still computed from the last snapshot.

**The weekly cap** comes from `allowance_plans`: the household pool's newest plan that has started by the end
of the week, or that week's override (`preferences.weeklyAllowanceOverrides`, parsed as `everydayPlan`
parses it). No plan and no override: no cap.

**The suggested cap** (`GET /allowance-plans`) = (take-home − committed bills − debt minimums − Avalanche extra
− goals) per month × 12/52, rounded down to whole $5, never negative. Committed bills leave out the Weekly
Spend / Monthly Spend items (they fund the allowance) and any bill linked to a debt (its minimum stands for
it). A suggestion only: nothing writes it.

## What changed

| Area | Change |
|---|---|
| `lib/avalanche-core/src/ledgerWalk.ts` | **A move.** `rollForwardBalance` and `walkLedger` are `computeCashSignal`'s two loops, line for line; `computeCashSignal` calls them. |
| `lib/avalanche-core/src/availableToSpend.ts` | `computePosition`, `selectPayday`. Pure, whole cents. |
| `lib/avalanche-core/src/weeklyLimit.ts` | `deriveWeeklyLimit`, `monthlyCentsOf`, `isEverydayFundingItem`. |
| `lib/avalanche-core/src/householdMoney.ts` | `everydayPlanFromRows` and `allowancePlanInEffect` beside `everydayPlan` (unchanged). |
| `lib/db` schema + `lib/db/migrations/0040_allowance_plans.sql`, `0041_recurring_amount_kind.sql` | `allowance_plans` (CHECKs on period, source, `created_by_kind = 'user'`; unique on household, coalesced member, period, start) with a backfill from `settings`; `recurring_items.amount_kind` (`fixed` / `estimate`, CHECK). Idempotent; constraint names match drizzle's so a later push sees the same table. |
| `artifacts/api-server/src/lib/cashSignal.ts` | `computeCashSignalDetailed` returns the signal and the ledger it walked; `computeCashSignal` returns `.signal`, byte for byte as before. |
| `artifacts/api-server/src/lib/forecastLedger.ts` | Each plan on the curve carries its item's `amountKind` (internal; not in any response). |
| `artifacts/api-server/src/lib/moneyContext.ts` | `loadMoneyContext` takes the caller's `tier2PairedTxnIds`; `loadMovementRows` (the PR-H test helper's row loader, moved unchanged). First production caller: the money position. |
| `artifacts/api-server/src/lib/moneyPosition.ts` | `buildMoneyPosition`: one read of the curve (no re-walk), the week, the cap and freshness; `computePosition` does every sum. |
| `artifacts/api-server/src/lib/allowancePlans.ts`, `allowancePlanWriter.ts` | Reads and the suggestion; **the one writer** of `allowance_plans`. |
| `artifacts/api-server/src/routes/money.ts` | `GET /money/position`, `GET /allowance-plans`, `PUT /allowance-plans/:id` (the household's owner only, `source = 'owner'`). |
| `artifacts/api-server/src/routes/spine.ts` | `position: { safeToSpendNow, remainingWeek, availableUntilPayday, paydayDate, horizonKind, withinPlan, confidence, degraded }` from the same `buildMoneyPosition` call, handed the spine's own cash-signal, freshness and pending-pair reads (one ledger per request). |
| `lib/api-spec/openapi.yaml` + generated clients | `MoneyPosition`, `SpinePosition`, `AllowancePlan(s)`, `AllowancePlanUpdate`, `WeeklyLimitDerivation`; `Spine.position`; `RecurringItem.amountKind` (+ input). Codegen committed. |
| Household scenario (fixture, test, contract doc) | A $300 weekly cap; the position's columns switched on (below). |

## Figures that move — new fields only

Nothing that existed before moves. Every figure below is a **new** field: before this branch it did not exist.

**`GET /money/position`, household A of `moneyPosition.integration.test.ts`** (pinned Wed 2026-10-07; worked by
hand in the test file's header):

| Field | Before | After |
|---|---|---|
| `paydayDate` / `horizon` | — | 2026-10-09 / payday, last day 10/08 (the $150 reimbursement on 10/8 is under 25% of $2,000) |
| `lowestUntilPayday` | — | 2,624.50 on 10/08 (2,814.50 + 150 − 340) |
| `committedUntilPayday` | — | 340.00 |
| `availableUntilPayday` | — | 2,124.50 |
| `weekCap` / `spentWeekDiscretionary` | — | 250.00 / 105.50 (80.00 weekly + 25.50 unfiled; the 60.00 City Water row is the bill, tier 2) |
| `unplannedWeek` / `monthlyWeek` | — | 40.00 / 30.00 |
| `remainingWeek` / `paceAllowedToday` / `withinPlan` | — | 144.50 / 142.86 / yes (1,011.50 ≥ 1,000) |
| `safeToSpendNow` | — | 144.50 |
| `confidence` / `estimates` | — | estimated / Electric −340.00 on 10/08 |
| `degraded` | — | false; true (`refresh_failed`) with a failed sync attempt, every other field identical |

**The household scenario** (`2026-09-11-household-scenario.md`, now asserted):

| Step | Remaining | Unplanned | Needs class. | Safe to spend now | Lowest before payday / available |
|---|---|---|---|---|---|
| S1 | 300.00 | 0.00 | 0.00 | 300.00 | pending (today's ledger: 2,105.00 / 1,605.00) |
| S2 | 158.40 | 0.00 | 0.00 | 158.40 | pending (2,105.00 / 1,605.00) |
| S3 | 158.40 | 85.00 | 0.00 | 158.40 | pending (1,725.00 / 1,225.00) |
| S4 | 113.40 | 85.00 | 0.00 | 113.40 | pending (1,680.00 / 1,180.00) |
| S5 | 111.00 | 85.00 | 0.00 | 111.00 | pending (2,072.60 / 1,572.60) |
| S6–S8 | 111.00 | 85.00 | 0.00 | 111.00 | **2,072.60 Thu 10/8 / 1,572.60** |
| S9 | 111.00 | 85.00 | 0.00 | 111.00 | pending (1,412.60 / 912.60) |
| S10 | 111.00 | 85.00 | 0.00 | 111.00 | pending (1,262.60 / 762.60) |

The pending cells are `it.todo`, one line each: S1–S4, S9, S10 need the funding-bill hooks (today's ledger
drags the $300 Weekly Spend bill where the contract has the Amex payoff); S5 needs an owner decision (a bill
due today lands on the next business day — see Residual 3).

**`GET /allowance-plans`, household H1 of `allowancePlans.integration.test.ts`:** suggested weekly — → 430.00
(take-home 4,333.33 − committed 1,815.99 − minimums 395.00 − extra 250.00 = 1,872.34 a month → 432.08 a week).

**`recurring_items.amountKind`:** — → `"fixed"` on every existing plan (`/recurring-items`, and each
`/bills/summary` row's `item`).

### Proof nothing existing moved

- **Golden:** `forecastLedger.golden.integration.test.ts` passes under `CI=true` (Vitest never writes a
  snapshot under CI); `git diff --stat 8148f2a1 -- '*__snapshots__*'` is empty. The walk extraction is held to
  a verbatim copy of the old loops on 2,000 seeded random ledgers (`ledgerWalk.test.ts`).
- **Spine parity:** the 13 assertions that existed pass unchanged on this branch (and on the parent: see the
  fails-before table); 3 new assertions were added, none loosened.
- **Before / after dump (scratch harness, not committed):** the household scenario's ten steps and the spine
  parity fixture were read through `/spine` (minus `position` and `asOf`), `/forecast/cash-signal`,
  `/bills/summary`, `/recurring-items` (minus `amountKind`), `/reports/spending-facts`, `/debts`,
  `/forecast/review-count` and `/forecast/bank-balance-explain`, first on `8148f2a1`, then on this branch.
  After dropping each run's synthetic user id and `debts.updatedAt` (run identities, not figures) the two are
  **identical** — every bank, spend, bill, forecast, review and debt figure, at every step.

## Must not change (held)

`bankToday`, `spentWeek` / `spentMonth`, `reviewCount`, `nextBill`, the forecast curve, every bill pair tier,
`payoffPct`, the golden snapshot, every existing endpoint's existing fields. `everydayPlan(settings)` is
untouched and still used by nothing new. No existing read path gained a side effect; the three new routes'
reads write nothing (`GET /allowance-plans` is asserted to leave the table as it found it).

## Tests

New or extended (API suite):

| File | Tests | What |
|---|---|---|
| `src/lib/ledgerWalk.test.ts` | 4 | oracle equivalence on 2,000 seeded ledgers (sorted and unsorted, DST windows, non-cent amounts), boundaries |
| `src/lib/availableToSpend.test.ts` | 28 | payday (25% rule, active-only, today, 45-day fallback), lowest before payday, null on no data, buffer + reserves, committed, unfiled counts, tight/over boundaries to the cent, pace, min, estimates, assumptions, degraded, the credit/debt law |
| `src/lib/weeklyLimit.test.ts` | 15 | monthly normalisation, exclusions, floor to $5, never negative |
| `src/lib/everydayPlanFromRows.test.ts` | 7 | parity with `everydayPlan` through the backfill on 1,000 seeded households × 64 weeks; plan in effect; members; overrides |
| `src/__tests__/moneyPosition.integration.test.ts` | 4 | the route to the cent, the curve it sits on (tier-2 pair proven), degraded, household scoping |
| `src/__tests__/allowancePlans.integration.test.ts` | 12 | the real 0040/0041 SQL run three times, parity on real rows, CHECK, GET, PUT owner-only / 404 / 400 / 409, the jobs/ai scan |
| `src/__tests__/recurringAmountKind.integration.test.ts` | 2 | `amountKind` through POST / PATCH / GET; bad value refused |
| `src/__tests__/spineParity.integration.test.ts` | +3 | position = `/money/position` field for field; on the spine's own curve, week and buffer; the law extended |
| `src/__tests__/householdScenario.integration.test.ts` | 10 (+3 todo) | the position's columns at every step, as above |

### Fails before (the branch's test files run on the parent `8148f2a1`)

| File | On `8148f2a1` | Reason |
|---|---|---|
| `ledgerWalk.test.ts` | 4 of 4 fail | `rollForwardBalance` / `walkLedger` do not exist |
| `availableToSpend.test.ts` | 28 of 28 fail | `computePosition` does not exist |
| `weeklyLimit.test.ts` | 15 of 15 fail | `deriveWeeklyLimit` does not exist |
| `everydayPlanFromRows.test.ts` | 7 of 7 fail | `everydayPlanFromRows` does not exist |
| `recurringAmountKind.integration.test.ts` | 2 of 2 fail | `amountKind` is `undefined`; "roughly" is accepted (201, not 400) |
| `moneyPosition.integration.test.ts`, `allowancePlans.integration.test.ts` | whole file fails | no `routes/money`, no `allowance_plans` table |
| `spineParity.integration.test.ts` | 3 fail, **13 pass** | `GET /money/position` → 404 (run with the cap seed guarded, since the parent has no table). The 13 old assertions pass on both. |
| `householdScenario.integration.test.ts` | 10 of 10 steps fail | `GET /money/position` → 404 (same guard) |

### Mutants — 26 of 26 caught

Each mutant applied alone, its test files run, reverted (scratch runner; the worktree was clean afterwards).

| # | Mutant | Caught by (one of the failing tests) |
|---|---|---|
| M1 | payday off by one: a paycheck dated today is payday | "a paycheck dated today is not payday" |
| M2 | payday's own day counted inside the window | "is the lowest … up to the day BEFORE payday"; position route to the cent |
| M3 | cash buffer not subtracted | scenario S6–S8; route to the cent |
| M4 | reserves not subtracted | "subtracts the buffer AND the reserves" |
| M5 | unplanned counted against the cap too (twice) | scenario S3–S10; "weekly-allowance spend and UNFILED spend count" |
| M6 | unfiled spend not counted against the cap | route to the cent; spine "on the spine's own curve, week and buffer" |
| M7 | the 25% payday rule dropped | "the 25% rule …"; route to the cent |
| M8 | 45-day bound off by one | "no paycheck within 45 days …" |
| M9 | tight boundary inclusive | "tight and over — the boundaries, to the cent" |
| M10 | exactly at the cap reads over | "tight and over — the boundaries" |
| M11 | safe to spend takes the larger ceiling | scenario S1–S10; "safe to spend now = the smaller ceiling" |
| M12 | no bank data reads a false zero | "is null — never a false zero"; household scoping |
| M13 | the ledger's tier-2 pairs not handed to the classifier | route to the cent (City Water would read as $60 unfiled) |
| M14 | `amountKind` not carried onto the curve | route to the cent (confidence) |
| M15 | spine `remainingWeek` read from the wrong figure | spine position parity; scenario |
| M16 | `walkLedger` applies a day's items a day late | golden (all 11 entries); oracle |
| M17 | `rollForwardBalance` swallows the window's first day | golden; oracle |
| M18 | the walk stops rounding each step to the cent | oracle (2,000 ledgers) |
| M19 | funding items counted as committed | `deriveWeeklyLimit` exclusions; GET suggestion |
| M20 | suggestion rounded to the nearest $5 | "rounded DOWN to whole $5" |
| M21 | a week's override ignored by `everydayPlanFromRows` | 1,000-household parity; real-row parity |
| M22 | a member's own plan read as the household cap | "a member's own plan is never the household's cap" |
| M23 | backfill writes a $0 plan | "one weekly and one monthly row per non-zero amount …" |
| M24 | PUT no longer owner-only | "a member of the household is refused" |
| M25 | the writer keeps the old source | "the owner sets the amount: source 'owner' …" |
| M26 | estimate tagging ignores the window | "fixed plans, and estimates outside the window, leave it firm" |

## Gates

Run on the branch head, Node 24.18, pnpm 10.34.3, local Postgres (`h2budget_test_prb`).

| Gate | Result |
|---|---|
| `pnpm run typecheck` | clean |
| `pnpm --filter @workspace/api-spec run codegen` | no drift (generated output committed) |
| `CI=true pnpm --filter ./artifacts/h2budget exec vitest run` | 141 files (140 passed, 1 skipped); 1,248 passed, 4 skipped |
| API suite, serial, `CI=true`, `h2budget_test_prb` | 158 files; 1,681 passed, 10 todo (parent: 151 / 1,606 / 7 — +7 files, +75 tests, +3 todo) |
| Parent `8148f2a1`, same suite, scratch DB | 151 files; 1,606 passed, 7 todo |
| Golden under `CI=true` | passes; snapshot files unchanged |
| `pnpm run build` + `node scripts/check-entry-graph.mjs` | build OK; landing route 575.7 KB raw (173.4 KB gz), budget 580 KB — unchanged; no recharts on open |
| `pnpm audit --prod` | ⚠️ **3 (1 critical, 2 high) — the same 3 on `main` at `8148f2a1`**, none introduced here (no dependency or lockfile change): `proxy-addr` < 2.0.8 via `express`, `compression` < 1.8.2, `braces` ≤ 3.0.3 via `http-proxy-middleware` (no patched release). Needs a security-pin change on `main` (Residual 1). |

## Residuals

1. **`pnpm audit --prod` is not 0 on `main` itself.** Three advisories published against packages already in
   the tree (`proxy-addr`, `compression`, `braces`) fail the audit gate on `8148f2a1` exactly as on this
   branch. Fixing them is a dependency change (overrides / upgrades, and `braces` has no patched release, so
   its path through `http-proxy-middleware` must go) that belongs in one security-pin PR on `main`, not in a
   money package. Flagged to the lead.
2. **⚠️ Deploy order: the SQL must run before this code serves.** Drizzle reads full `recurring_items` rows in
   the forecast, bills and spine, so once this code is live every one of those reads names `amount_kind`; and
   the spine reads `allowance_plans`. Production gets both only from `0040`/`0041` through PR-0's migration
   runner (`preDeployCommand`). This branch must merge after PR-0, and the runner must apply `lib/db/migrations`
   in name order. Without them the forecast, Bills and the spine fail.
3. **⚠️ Reads high by a bill due today when the next business day is payday.** The ledger lands an unposted
   bill due today (and an overdue one) on the next business day, so day 0 equals the bank (PR6). When that
   day is payday the bill falls outside the window, and available until payday reads high by it for that
   day (scenario S5: the $95 phone; 1,572.60 where the contract says 1,477.60). The formula follows the
   specification exactly; counting a due-but-dragged outflow that lands ON payday inside the window would
   restore "low, never high" and match the contract at S5 once the hooks land. Not changed here: it is a
   money rule (Question 1).
4. **The cap reads `allowance_plans`; the classic Allowances page still writes `settings`.** Until settings is
   retired, an edit on the classic page does not move the position's cap (the backfill ran once). The
   overrides are still read from `settings.preferences`, as `everydayPlan` reads them (Question 4).
5. **Funding-bill hooks are the next package.** Until then the Weekly Spend bill is a plain weekly bill on the
   curve, so lowest before payday and available until payday read lower than the contract at S1–S4, S9, S10
   (low, not high).
6. **Bank freshness reads `old` at scenario S3–S7.** The 48-hour quiet-feed rule post-dates the contract's
   "Stale" column, which says fresh; the position reports `degraded: true` there. The column stays pending for
   its owner.
7. **Spine cost.** The spine now also runs the position's reads: the household's income plans and allowance
   plans, `loadMoneyContext` (owner, settings, confirmed matches, ledger accounts, Amex cards, categories) and
   the week's rows. The ledger, freshness and pending pairs are shared, not re-read. Not measured against
   production data.
8. `drizzle-kit push` re-creates the expression unique index on every push (dev and tests only; production
   runs the SQL file, which is idempotent). A known drizzle-kit limit with expression indexes.
9. `committedUntilPayday` sums planned outflows only; a future-dated real checking row lowers the curve (and
   so the low) but is not listed as committed.
10. The position classifies the week with `classifyMovement` as specified, so a row that is both reimbursable
   and weekly-flagged counts against the cap (PR-H's open question), while `spentWeek` excludes it.

## Questions for the owner

1. **A bill due today with payday tomorrow** (Residual 3): should a bill that is already due but dragged onto
   payday count inside "until payday"? Yes reads safe (low); no is today's formula (high by that bill for a
   day).
2. **No allowance set means no cap.** The backfill writes no plan for a $0 setting, so such a household sees
   "no weekly cap" rather than "over a $0 cap". Right?
3. **A cap changed mid-week governs the whole week** (the newest plan that has started by Saturday). Or
   should it start the following Sunday?
4. **Classic Allowances page vs. `allowance_plans`** (Residual 4): mirror the classic page's writes into the
   plan until it is retired, or leave the classic page reading its own setting?
5. **Unfiled spending counts against the weekly cap until it is filed.** Confirm.
6. **Reimbursable + weekly-flagged** (Residual 10): count it against the cap (the classifier's order today) or
   leave it out (the 2026-09-15 rule)?
