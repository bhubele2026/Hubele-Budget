# PR8r (server) — the everyday reserve hooks and the three views (owner decisions 7 and 12; plan section A)

- **Branch:** `feat/everyday-reserve-hooks`, from `main` at `f96afb1` (PR-H). Merged forward to `bce4bf7` (PR-B2) and
  `59cbbda` (follow-ups batch 2) before any ledger code was written, so the hooks build on PR-B2's `isEvidence`,
  hold-back and `usedRows`.
- **Owner decisions implemented:** decision 7 (the Allowances settings own the everyday amount; the Weekly Spend and
  Monthly Spend bills become Amex payoff DATE hooks), decision 12 (a confirmed match establishes coverage), answer 1
  of 2026-09-15 (one spending rule; a reimbursable charge is its own row), and the 2026-09-15 principle "the forecast
  may read low, never high".
- **Not pre-empted:** the open owner question on the bank-noise substrings ("autopay", "epay", "web id:", "ach pmt").
  No flagged row is newly dropped by a description in any figure this PR adds.
- **Web:** none, apart from what codegen regenerates (types only; the landing bundle is unchanged, see Verification).

## 1. Rules implemented

### 1.1 Linking — `preferences.everydayHooks {weeklyItemId, monthlyItemId}`

- jsonb in `settings.preferences`, no DDL. In the OpenAPI `SettingsPreferences` schema, with codegen.
- **Server-validated** (`routes/settings.ts`, `everydayHooksProblem`): every id a PUT **sets or changes** must be one of
  this household's **active** recurring items; otherwise 400 `everydayHooks.<key> must be one of this household's
  active recurring items`, and nothing is written. Null unlinks. A malformed id is a 400, never a 500.
- **An id already stored is not re-checked.** The web saves preferences as `{...prev, ...patch}`, so every save sends
  the hook back; a bill paused after it was linked must not make an unrelated save (an allowance override) fail.
- **At read time** (`everydayHooks.ts`, `resolveHookLinks`) an id that is not an active item of the household reads
  `invalid` and is no hook: the curve is exactly the unlinked one (pinned).

### 1.2 The payoffs — pure rules in `lib/avalanche-core/src/everydayReserve.ts`, read by `everydayHooks.ts`

| Hook | Period | Paid on | While the period is open | Once it has closed, unpaid |
|---|---|---|---|---|
| Weekly | Sunday–Saturday week | its Saturday | owed charges on the weekly cards + max(0, plan − covered everyday spend) | owed charges only, next business day, `amex_payoff_not_posted` |
| Monthly | calendar month | the 1st of the next month | the monthly card's charges for the month + max(0, month plan − covered everyday spend) | the same |

- **The plan** is `everydayPlan`: `weeklyAllowanceAmount` or that week's override; `monthlyAllowanceAmount`.
- **The owed figure** is `computeWeeklyPayoff`'s own (`combinedWeekCharges` for a week; the monthly cards'
  `weekCharges` for a month, asked for with a Sunday inside the month), called once per period that has begun. The
  five Amex-owed calculations are **not** changed or restated.
- **Covered everyday spend** is the everyday spend the forecast already sees leave:
  - a checking row, which is already cash ("checking purchases shrink the remaining plan");
  - a card row **inside a linked hook's owed figure** — a card the hooks pay (no linked debt), whose cadence's hook is
    linked, counted by the owed figure's own row rule.
  - Everyday spend the forecast cannot see leave does **not** shrink a payoff. That covers a card the hooks do not pay,
    a Blue charge while the monthly hook is unlinked, and a charge the owed figure leaves out (it counts categorized
    charges only). The forecast reads low there, never high. Remaining still shows it, because remaining is spend
    against the plan from any account (the scenario's rule).
- **Due today and still open** (a Saturday): the next business day, `due_today_not_posted`. Day 0 still equals the bank,
  the convention every plan follows.
- **The overdue floor:** a closed, unpaid period whose payoff date is more than 14 days back is off the curve, exactly
  like an overdue bill.
- **One payoff per period.** A Saturday or Sunday never takes a payoff twice (pinned both days, and with a Saturday
  snapshot that already holds the payment).

### 1.3 Which plan a row uses up — `everydayRowFacts`

- **A flagged row** keeps **today's allowance screens** (transfer, card-payment flag, reimbursable, debt tag — the
  four `aggregateBudgetMonth` applies), never the one spending rule's description or category rules. So "PLANET FITNESS
  AUTOPAY" flagged weekly still uses up the weekly plan (owner question open; pinned). Then decision 12: a
  **confirmed** match (`matched`/`partial`, carried pending → posted) uses up no plan. Otherwise its flag,
  unplanned > monthly > weekly; unplanned sits on top and never shrinks the plan.
- **An unflagged row** follows `classifyMovement`. Only `needs_classification` uses up a plan (the weekly one,
  provisionally). A reimbursable row, a confirmed match, a **tier-2 pair**, a transfer, a card payment and a debt
  payment use up none.
- **A pending row its posted row replaced** counts nowhere; the posted row counts under the filing it inherits. That
  is case (vi): spending 48, never 88.
- **Allowance spend excludes bill-matched rows, and the overage is shown** (`everyday.billMatched`: the row, its plan
  key and amount, the overage, and the conflict). A weekly or monthly flag on a confirmed match is ignored with a
  visible note (`flag_ignored_matched`); an unplanned flag on one is a conflict for Review (`unplanned_on_matched`).
  A suggested (tier-3) match never overrides a flag, and a tier-2 pair only covers a row with no flag.

### 1.4 The Amex payment that removes a payoff (tier 1)

- **Eligible:** a checking cash row (the cash rule, no anchor, so a payment the snapshot already holds still counts)
  that is an outflow, not tagged to a debt, naming Amex ("amex" or "american express" as whole words), and reading as a
  card payment. That means the user's flag, Plaid's card-payment category, an issuer phrase ("AMERICAN EXPRESS ACH",
  "AMEX EPAYMENT") or ACH payment boilerplate ("AMEX DES:ACH PMT"). "AMERICAN EXPRESS TRAVEL" is a purchase.
- **Settles a period** when within max($1, 1%) of its owed figure, dated from the period's first day to 14 days after
  its payoff date. Oldest payoff date first; one payment settles one period; a row an answer already holds is never a
  candidate.
- **Effect:** a closed period's payoff leaves the curve. While the period is still open, only the owed part leaves:
  charges after the payment, up to the plan, are still to pay. That is stricter than "removes the payoff plan", and
  reads low.
- **The payment is claimed** before any bill is matched, so one payment never pays both a bill and a payoff. With a
  legacy "American Express" bill beside the hook, the bill stays unpaid (it reads low) instead of the payment counting
  twice (pinned: unlinked the payment pays the bill; linked it settles the payoff and the bill drags).
- **Explicit answers on a payoff** (resolution key `<hook item id>|<payoff date>`, the key the web already sends for an
  event) win over the automatic match. `matched`, `skipped`, `missed` and `dismissed` take it off. `partial` leaves the
  rest, and nothing at $1 or less. `rescheduled` moves it.
- **Not handled:** one payment per card (two weekly cards paid separately) does not match the combined figure. The
  payoff stays on the curve (reads low) until the user confirms it. PR-G1 can match per card.

### 1.5 Before a hook is linked

- **The curve is unchanged.** Golden byte-identical, and no field other than the new ones differs (pinned below).
- **The discrepancy flag** (`everyday.weekly|monthly.discrepancy`, with `billAmount` and `allowanceAmount`) compares the
  linked bill, or before linking the household's one active bill named "Weekly Spend" / "Monthly Spend", with the
  Allowances standing amount. PR8r-web shows the banner.

### 1.6 What PR-H deferred

- **Timing "via an Amex payoff on date Y":** `MovementTiming` gains `{kind: "amex_payoff", accountId, date, payoffDate}`
  for a card row on a card the hooks pay (`ctx.amexPayoffCadence`). A weekly card's row is paid on its week's Saturday;
  a monthly card's on the 1st of the next month. Any other card row keeps `card`.
- **The tier-2 set:** the ledger hands `loadMoneyContext` the transactions of every tier-1/2 pair on an outflow plan
  (after PR-B2's hold-back, so a demoted pair is not in it).

### 1.7 Answer 1 — reimbursable before the flags

`classifyMovement`: step-1 exclusions → confirmed match (or a tier-2 pair on an unflagged row) → **reimbursable** →
unplanned → monthly → weekly → needs_classification. PR-H's forward-only class `reimbursable_flagged` is gone. Those
units must now be equal in forward mode, and the generator still reaches them (≥ 20). No displayed figure moves,
because today's Spending and Budget rules already screen a reimbursable row first and the parity helpers are not wired.

### 1.8 The three views (plan section A)

- `expected` **is** `balance`: overdue unpaid bills (≤ 14 days) drag to the next business day, as today.
- `scheduled`: every plan on its own due date. A bill overdue before today is listed (its event keeps its assumption),
  not dragged; a bill due today stays on today; income due today that has not arrived counts today.
- `conservative`: `expected` with every planned income moved one business day later.
- The payoffs are identical in all three: linking moves each view by exactly the same amount (pinned).
- Overdue income is on no curve, and cash today never includes expected income.

### 1.9 Output

- `daily[].scheduled/expected/conservative`, `everyday {weekly, monthly, billMatched}` and `incomeExpectedToday` — on
  `GET /forecast/cash-signal` only (`computeCashSignal(..., { views: true })`). The spine, the Forecast bundle, the
  Avalanche scheduler and "Why this number?" keep the exact pre-PR8r shape. OpenAPI schemas `CashSignalEveryday*`,
  with codegen.
- **Spine law:** no owed, payoff, reserve or plan figure goes on `/spine`. The new test collects every key the spine
  returns with hooks linked and refuses each of them. `debt.payoffPct` is the payoff percentage the landing law allows.
  The spine's low point equals the route's.

## 2. ⚠️ Spec conflict, decided the reading-low way: income due today

The brief says Expected counts income due today in today's end-of-day figure, marked "Expected today", and that
`balance` equals `expected`. It also says the curve is unchanged before a hook is linked, and that the forecast may read
low, never high. On a payday these cannot all hold. Counting an income occurrence that has not arrived raises
`balance` on that day for every household, linked or not. It would read high whenever the deposit lands late, lands on
another account, or pairs ambiguously. It would also flip an existing hand-worked pin:
`cashSignalSeedHouseholdTiers` test A0 pins a paycheck due today "off the curve", and counting it raises that test's low
point by the whole paycheck.

**What this PR does:** `balance` = `expected` keep today's rule (income due today is off the curve). Income due today
that has not arrived (the arrival rule `incomeNotArrived` already uses) is **listed** as `incomeExpectedToday` — the
"Expected today" marker — and **`scheduled` counts it today**.

**The figure it would move** (synthetic views household, Fri 9/11, a $1,000 paycheck due today with no deposit): Expected
end of 9/11 stays 1,960.00 here; counting it would read 2,960.00, and every later day $1,000 higher until the deposit
posts. **Switch:** one line in `forecastLedger.ts` (push the listed occurrence as a plan on today). The plan puts "Expected
today" and its test impact under PR9 (section E), which is the natural place. **Needs the lead's call.**

## 3. The worked numbers

"Fails on main" means the test file run against `main`'s versions of the eight changed source files, with the new
modules left in place and unused by `main`'s code (`scratchpad/pr8r/fails-before.mjs`). 52 tests fail there, and all
pass on the branch.

| Case | Asserted | Fails on main | Passes |
|---|---|---|---|
| (i) $120 of Amex groceries | remaining 330, owed 120, payoff 450 on Sat 9/12; end of 9/11 2,000, end of 9/12 1,550 | `TypeError: Cannot read properties of undefined (reading 'weekly')` (no `everyday`) | ✓ |
| (ii) + $40 checking purchase | cash 1,960; spent 160, remaining 290, payoff 410; end of 9/12 1,550 | same | ✓ |
| (iii) + $60 unplanned Amex | remaining 290, unplanned 60, owed 180, payoff 470; end of 9/12 1,490 | same | ✓ |
| 330/290/290 and 450/410/470 | one household, step by step | same | ✓ |
| (iv) $120 bill paid $145, flagged weekly | weekly spent 120 before and after; the bill's occurrence off the curve; `billMatched` overage 25.00, `flag_ignored_matched` | same | ✓ |
| (vi) $40 pending posts at $48 | spent 48, owed 48, remaining 402, payoff 450 | same | ✓ |
| Mon 9/14, last week unpaid | owed only −120 on Tue 9/15, `amex_payoff_not_posted`; this week −450 on 9/19 | the Weekly Spend bill drags −450 to 9/15 (`expected [ { date: '2026-09-15', … } ] to deeply equal …`) | ✓ |
| −$120 payment posts Tue 9/15 | cash 1,880 once; no payoff for 9/6–9/12; 9/18 1,880, 9/19 1,430 | the bill still drags to 9/16 (`expected [ { date: '2026-09-16', … } ] to deeply equal []`) | ✓ |
| A Saturday | exactly one payoff for the week, −410 on Mon 9/14 `due_today_not_posted`; next week −450 separately; 9/14 1,590 | the bill's −450 (`expected [ [ '2026-09-12', … ] … ] to deeply equal …`) | ✓ |
| A Sunday | −120 owed only on Mon 9/14 `amex_payoff_not_posted`; next week −450 | same shape mismatch | ✓ |
| Saturday snapshot holding the payment | on Sunday no payoff for the week; cash 1,880; Mon 9/14 1,880 | `expected [ { date: '2026-09-14', … } ] to deeply equal []` | ✓ |
| $450 bill vs $400 allowance | unlinked: `discrepancy` true, `payoff` null, 9/12 1,550, `daily` equal to the plain signal's; linked: 9/12 1,600 | `TypeError … 'weekly'` | ✓ |
| Monthly hook (Blue) | August $200 owed only on Mon 9/14; Oct 1 −400 (50 + 350); remaining 350 | `expected [ Array(1) ] to deeply equal …` | ✓ |
| Tier-2 set supplied | an unflagged "CITY WATER UTIL" −89.99 paired tier 2: spent 120, needs classification 0, payoff 450 | `TypeError … 'weekly'` | ✓ |
| Payment claimed | unlinked: the payment pays the "American Express" bill; linked: it settles the payoff and the bill drags to 9/16 | `expected [ { date: '2026-09-16', … } ] to deeply equal []` | ✓ |
| Uncategorized Amex charge | spent 150, remaining 300, owed 120, payoff 450 (not 420) | `TypeError … 'weekly'` | ✓ |
| Weekly-flagged Blue charge | weekly only: payoff 450; both hooks: weekly payoff 400, monthly owed 50, monthly payoff 450 | `TypeError … 'weekly'` | ✓ |
| Paused hook | `invalid`; `daily` and `events` equal the unlinked signal's | `TypeError … 'weekly'` | ✓ |

The pure form of each (`everydayReserve.test.ts`, "the worked numbers and the edges") pins the same amounts, plus the
tolerance boundary (30,300 / 29,700 match an owed 30,000; 30,301 / 29,699 do not), the 14-day window, the
oldest-first rule, a payment during the open week, a future snapshot day, every explicit answer, and the floor.

## 4. Property tests

### 4.1 The hooks never read high — `everydayReserve.test.ts` (pure, 2,500 generated households)

- **Generator:** every weekday as today, across two month ends. A snapshot dated today, or 1–2 days later. Both hooks, or
  the weekly one only. Charges on the weekly and monthly cards (15% outside the owed figure), checking and other-card
  spend. Payments within and beyond tolerance, and inside and outside the window. Explicit answers.
- **Oracle:** an independent per-period simulation of what leaves checking:
  - the card's whole balance for the period, less a payment that settled it;
  - plus, while the period is open, the rest of the plan less the everyday spend the forecast can see leave, spent in
    the worst case on the hook's card;
  - paid on the payoff date, or on the next business day once due.
- **Assertion, every day of the next 45:** forecast outflow ≥ true outflow − what the spec lets the forecast leave out.
  That allowance is: charges the existing owed figure does not count (PR-G1), what a payment within max($1, 1%) left on
  the card, a partial answer's remainder of $1 or less, and a period past the 14-day floor. **When none applies, the two
  are equal, day by day** (371 households). Invariants: one outcome per period, a payment settles one period, never on
  or before today, a moved payoff never on a weekend.
- **Hits (all ≥ 25 asserted):** open periods 18,075; closed 10,272; settled by payment while closed 1,643, while open 407;
  payment outside tolerance 1,173; due while open 560; closed and not posted 5,481; past the floor 4,692; closing
  answers 1,601; partial 415; rescheduled 408; uncounted charges 2,088; clean households 371; snapshot after today 533;
  monthly hook unlinked 732; today on each weekday 344–366.

### 4.2 The classifier — `householdMoney.test.ts` (6,000 seeded rows)

The spec model now puts reimbursable before the flags (answer 1) and computes the payoff date independently (Date.UTC
arithmetic). New asserted paths: `timing:amex_payoff`, `step3:reimbursable-over-flag`, `step4:unplanned-over-other-flag`,
`step5:monthly-over-weekly`. The rest of PR-H's paths are unchanged.

### 4.3 Through the real ledger — `everydayReserveViews.integration.test.ts` (12 generated households)

- **Generator:** random today (Sun 9/6 – Sat 9/19), random charges and flags on both cards, uncategorized charges,
  checking purchases. An Amex payment, 80% of the time exactly last week's owed figure. Half the time a legacy
  "American Express" bill it could pay.
- **Assertion, every day of 30:** balance + the hook items' own outflows is never higher linked than unlinked — linking
  never raises the rest of the curve. Cash today never moves.
- **Not vacuous:** the payoffs replaced the bills in at least 10 households (on `main`, 0: `expected 0 to be greater
  than or equal to 10`); a legacy bill in at least one.

## 5. PR-H reviewer leftovers

| Item | Change | Proof |
|---|---|---|
| **L1** settings read twice | `readSettingsRow` runs the select once (`.then((rows) => …)`), and both consumers share that Promise. Callers can hand in the row, the checking account and the tier-2 pairs. | Pool-spy test: exactly **one** `from "settings"` select reaches `pool.query`. On main: `expected [ …(2) ] to have a length of 1 but got 2`. A handed-in row gives zero selects. Mutation "read the row a second time" is caught. |
| **L2** match carried to the wrong posted row | No code change needed: `confirmedMatchIds` already carried only from the replaced pending row. | New test: two pending → posted pairs on one account, one pending row matched; only its posted row reads matched. Passes on main (it pins existing behaviour). Mutation "carry to any replaced pending row" is caught. |
| **N1** null override | The server keeps treating a null override as absent (the standing amount): the "reads low" choice, since a $0 plan would shrink the reserve. `allowances.tsx` reads `Number(null)` as $0. | Documented here for PR8r-web, which aligns the web. |
| **N2** unknown `mode` | `classifierHouseholdSpend` and `classifierAllowanceRows` throw on any mode but "today" or "forward". | Tests for "future", "" and "TODAY". On main: `"future": expected [Function] to throw an error`. Mutations N2a and N2b are caught. |

## 6. What moves a displayed figure

**With no hook linked, nothing.**
- `forecastLedger.golden.integration.test.ts` and its snapshot are untouched and pass.
- With the views on, every other field of the cash signal is deep-equal to the plain signal, and `expected === balance`
  on every day (pinned on a household with an overdue bill, a bill due today, a paycheck due today and a future income).
- The spine, the Forecast bundle, the Avalanche scheduler and "Why this number?" call `computeCashSignal` without views.
- `/forecast/cash-signal` gains fields only.

**When the owner links a hook (PR8r-web's toggle),** the curve and every figure read off it move: `balance`, `lowestProjected`/`lowestDate`,
`status`, `maxSafeExtra`, `endingBalance`, `projectedExpenses`, the spine's `forecast.lowPoint`, `runwayDays` and
`status`, and `events[]` for the hook item. Synthetic before → after, all from the pinned fixtures:

| Situation | Unlinked (the bill) | Linked (the payoff) |
|---|---|---|
| Fri 9/11, $120 Amex + $40 checking spent, bill $450 | end of 9/12 1,510.00; 9/19 235.00 | 1,550.00; 275.00 (this week's reserve already paid $40 from checking) |
| Bill $450, Allowances $400 | end of 9/12 1,550.00 | 1,600.00 |
| Mon 9/14, last week unpaid, $120 owed | the 9/12 bill drags −450.00 to 9/15 (`dragged_past_due`) | −120.00 on 9/15 (`amex_payoff_not_posted`) |
| Tue 9/15, the −$120 payment posted | the bill still drags −450.00 to 9/16 on top of the payment | nothing for that week |
| Blue: $200 in August, unpaid | nothing in September (Monthly Spend dated Oct 1) | −200.00 on Mon 9/14 |
| A legacy "American Express" bill paid by the payment | paid by the payment (off the curve) | drags (the payment settled the payoff), reads low |

**Also moving:**
- **The classifier's answer 1:** no displayed figure (see 1.7).
- **PUT /settings:** a new 400 when a request sets or changes `everydayHooks` to an id that is not an active item of
  the household.

### Classes that would move under the owner question (not switched here)

The everyday spend for flagged rows uses today's screens, so none of PR-H's seven one-rule classes moves in this PR:
`non_outflow`, `excluded_category`, `bank_noise_description`, `income_category`, `debt_category`,
`card_payment_description`, `plaid_card_payment`. `bill_matched_flagged` does move, into the reserve arithmetic
(decision 12). PR10 meets the seven when it switches the Budget allowance card; the bank-noise one waits for the owner.

## 7. Golden and scenario files

- **Golden:** no diff (`git diff --stat origin/main -- '*golden*' '*.snap'` is empty); the golden tests pass.
- **Household scenario:** `remainingWeek` is **switched on**, asserted at S1–S10 from `/forecast/cash-signal`'s
  `everyday.weekly.remaining`. Every expected value is unchanged (300.00, 158.40, 158.40, 113.40, 111.00 × 6).
  - The fixture gains a settings row: Allowances $300 weekly and $400 monthly, and the two bills linked. The scenario
    already modelled the hooks; decision 7 moves the amount into settings.
  - Cash, spent this week and the review count read neither, and are unchanged.
  - The document's household table, rules and a "PR8r delivery" section say the same.
- **The expected on 10/16 column under the hooks model** (checked, not switched on; the column is "PR8 + PR9"):
  `/forecast/cash-signal`'s end-of-day balance on Fri 10/16 **equals the hand-worked contract at all ten steps**:
  3,485.00 · 3,485.00 · 3,200.00 · 3,200.00 · 3,200.00 · 3,200.00 · 3,175.00 · 3,175.00 · 3,175.00 · 3,025.00.
  - S1–S2: last week's $180 owed only, on the next business day.
  - S3: the $180 payment settles it; this week's payoff is 385 (226.60 owed + 158.40).
  - S4: 340 (the Chase gas already left checking).
  - S9: Paycheck A matched away by its deposit.
  - Checked with a throwaway copy of the scenario test, deleted after the run.
  - PR9 can switch the column on; its lowest-before-payday column still differs at S10 (section 9).

## 8. Mutation results

Each mutation applied alone, its tests run, then reverted (`scratchpad/pr8r/mutate.mjs`). The find string must match
exactly once. **41 of 41 caught.**

Two survived the first run: W8 and V5. Neither was a code bug; each lacked a test. Adding "the week's plan is that
week's override" and "a Saturday: the payoff moved to Monday stays on Monday in Scheduled" caught both on re-run.

| Mutation | Result | Caught by (one of the failing tests) |
|---|---|---|
| P1 reserve dropped while the period is open | caught | pure (i): payoff 450 on its Saturday |
| P2 reserve kept after the period closes | caught | pure: closed and unpaid (Mon 9/14), owed only |
| P3 uncovered spend shrinks the payoff | caught | `periodSpend`: the covered part |
| P4 an open period's matched payment removes the reserve too | caught | pure: a payment while the week is still open; property |
| P5 due today and open lands on today | caught | pure: a Saturday; a snapshot dated after today |
| P6 closed and unpaid stays on its past payoff date | caught | pure: Mon 9/14; a Sunday |
| P7 no overdue floor | caught | pure: past the floor, `outsideForecast` |
| P8 payment tolerance $10 | caught | the tolerance boundary; property |
| P9 an explicit answer does not block the automatic match | caught | explicit answers; property |
| P10 one payment settles several periods | caught | one payment settles one period; property |
| P11 settles the newest period first | caught | the oldest first; property |
| P12 no business-day roll | caught | the next business day skips the weekend; a Saturday |
| R1 a flagged row drops a bank-noise description | caught | owner question open: never newly dropped |
| R2 decision 12 off | caught | (iv) through the ledger; decision 12 unit |
| R3 needs classification uses up no plan | caught | an unflagged row |
| R4 today's reimbursable screen dropped for a flagged row | caught | today's allowance screens |
| R5 the Amex name rule loosened to a substring | caught | never a purchase, a deposit, … ("CAMEX SUPPLY ACH PMT") |
| C1 answer 1 reverted (unplanned before reimbursable) | caught | answer 1 unit; the 20,000-unit comparison |
| C2 payoff timing is the row's own date | caught | a weekly card's charge is paid on its Saturday |
| C3 payoff timing on any card-ledger row | caught | "an Amex ledger row is 'card'"; the monthly timing |
| L1 the settings row read a second time | caught | the pool spy: one settings select |
| L2 a match carried to any replaced pending row | caught | the L2 test |
| N2a spending: an unknown mode does not throw | caught | any other mode throws (spending) |
| N2b allowance: an unknown mode does not throw | caught | only 'today' and 'forward' are modes |
| W1 the tier-2 set not supplied | caught | a tier-2 pair keeps an unflagged bill payment out |
| W2 a settled payment is not claimed | caught | the payment is claimed (linked vs unlinked) |
| W3 a linked bill's own occurrences stay on the curve | caught | (i), (ii) |
| W4 only today's payments are candidates | caught | the Saturday snapshot holding the payment |
| W5 an uncategorized card charge counts as covered | caught | the uncategorized Amex charge |
| W6 a card whose hook is unlinked counts as covered | caught | a weekly-flagged charge on the monthly card |
| W7 a paused hook reads as linked | caught | a hook naming a paused bill reads invalid |
| W8 the week's plan ignores the override | caught (after its test was added) | the week's plan is that week's override |
| W9 remaining counts unplanned spend | caught | (iii): unplanned 60, remaining still 290 |
| V1 Scheduled drags an overdue bill | caught | Scheduled: plans on their own dates |
| V2 Conservative moves no income | caught | Conservative: Friday 9/18 lands Monday 9/21 |
| V3 Scheduled leaves out income due today | caught | Scheduled: plans on their own dates |
| V4 Scheduled drags a bill due today | caught | Scheduled: plans on their own dates |
| V5 Scheduled moves the payoffs | caught (after its test was added) | a Saturday: the payoff stays on Monday in Scheduled |
| S1 an invalid hook id is stored | caught | another household's item, a paused item, … → 400 |
| S2 a stored id is re-checked | caught | an id already stored is not re-checked |
| S3 another household's item accepted | caught | another household's item → 400 |

The fails-before run (section 3) is the proof for the rules no mutation targets: the `everyday` block, the views, the
settings validation and the scenario column.

## 9. What comes next

**PR8r-web**
- The Bills "Everyday hook" toggle: PUT `preferences.everydayHooks`. A 400 names the key.
- The discrepancy banner, from `everyday.weekly|monthly` (`status`, `itemId`, `billAmount`, `allowanceAmount`,
  `discrepancy`).
- Allowances reads a null override as absent (N1).
- The `billMatched` overage and its note; `unplanned_on_matched` in Review (with R1).
- "Expected today" from `incomeExpectedToday`.
- Copy for `amex_payoff_not_posted`.
- The Forecast register (the `/forecast` bundle's web-side expansion) still lists a linked bill's own occurrences.
  Hide them for a linked hook, or show the payoff events instead.

**PR10**
- The server half of answer 1: Budget actuals, the allowance sums and `budgetFacts.ts`, on `classifyMovement`
  (reimbursable is already first), or on `everydayRowFacts` for the week and month figures.
- Wait for the owner's bank-noise answer.
- Spine week fields.
- `keepsPreSnapshotRule` can go once no Weekly Spend bill stays unlinked; until then it still guards an unlinked one.

**PR9**
- Income states (Received = tier 1 or 2) and the "Expected today" decision (section 2).
- `balance-on` over the three views.
- The scenario's lowest-before-payday puts a Saturday payoff on Saturday itself (S10: "10/10 3,585"), while this PR
  keeps due-today plans on the next business day. PR9 settles that column's convention.

**PR-G1**
- One Amex owed figure, uncategorized charges included. The "covered" rule then follows it with no change here: it
  already asks the owed figure's own row rule.
- Per-card payment matching.

**R1**
- List closed, unpaid periods older than the floor (today they are off the curve and not listed — only in the payoff
  outcomes).
- Show the payoff answers.

**Performance note**
- With a hook linked, a ledger build adds `computeWeeklyPayoff` once per period that has begun (usually 3), one
  money-context load and two range reads.
- The spine pays this too, because its low point must include the payoffs. With no hook linked it costs one settings
  select.

## 10. Coordination with PR-I (not on `main` when this branch was pushed)

PR-I (`feat/bank-removed-review-carry`) adds a rule: a confirmed match on a bank-removed row must not close its bill or
count as coverage, except a removed pending row that a live posted row replaced. Its helpers are `loadBankRemovedIds`
and `notBankRemovedSql`. PR-I had not merged when this branch was pushed, so the filter is left as four marked
`TODO(PR-I)` comments, for the lead to apply at whichever merge lands second:

- `moneyContext.ts` `loadConfirmedMatchRows`: coverage (decision 12, `billMatched`);
- `everydayHooks.ts` `prepareEverydayHooks`: the Amex payment candidates (a removed payment must not settle a payoff);
- `everydayHooks.ts` `finishEverydayHooks`: the everyday rows (a removed row counts nowhere);
- `forecastLedger.ts`, the tier-2 set: check PR-I's candidate-row filter reaches the matches it is built from.

## 11. Verification

On the branch tree (`main` at `59cbbda` merged in; `main` had not moved when this was pushed):

- **Typecheck:** `pnpm run typecheck` is clean.
- **Web tests** (`CI=true pnpm --filter h2budget exec vitest run`, no web source changed):
  - `TZ=UTC`: 141 files, 1,249 passed, 3 skipped;
  - `TZ=America/Chicago`: 141 files, 1,250 passed, 2 skipped.
- **API tests:** the full suite against `h2budget_test_pr8r` under `caffeinate -i` (`CI=true TZ=UTC`) — 156 files, 1,686
  passed, 6 todo (90.6 s).
- **Build and bundle:** `pnpm run build && node scripts/check-entry-graph.mjs`.
  - The landing route is **575.7 KB raw** (173.5 KB gz; `main` 575.7 KB raw), against a budget of 580 KB.
  - No recharts on the open path; react-dom stays in `vendor-react-*`.
  - The generated additions are types (`api.schemas.ts`), erased at build; `useGetForecastCashSignal` is unchanged.
- **Codegen:** `pnpm --filter @workspace/api-spec run codegen`, output committed, and `git status` is clean after a second
  run.
- **Golden:** `git diff --stat origin/main -- '*golden*' '*.snap'` is empty; the golden tests pass.
- **Fails-before:** 52 of the new or changed tests fail against `main`'s sources (section 3).
- **Mutations:** 41 of 41 caught (section 8).
- **Property tests:** 2,500 generated households (pure), 6,000 classifier rows, and 12 households through the real
  ledger (section 4).
