# PR-B2: the hold-back needs proof (owner decision, 2026-09-15)

Branch `fix/holdback-proof-only`, cut from main `2731077`. One money rule changes. There is no UI, API spec, schema or
codegen change. All figures below are synthetic test fixtures.

## The owner's decision, in plain words

Sometimes one bank row could belong to either of two months of the same bill. The forecast first asks whether the
earlier month is already paid; if it is not, the row is held back for it (it may be that month, paid late), and the later
month stays in the forecast.

Until now "already paid" could mean a pair that merely carried the payee's name. From today it needs proof: a confirmed
answer, a debt tag, or tier-2 obligation evidence. When the only thing pointing at the earlier month is a suggestion,
the earlier month stays unpaid, the later row is held back, and the later month stays in the forecast until the owner
answers the close call in Review.

The PR-B review note described two failure modes ("MEDIUM — disclosed, NOT fixed"). The owner chose the stricter one:

- the forecast **may read low**: a paid bill keeps dragging until the owner confirms the close call;
- it **must never read high**: an unpaid bill must not leave the curve.

## ⚠️ OPEN: for income, the stricter rule can read HIGH (the owner must answer this before merge)

The decision's aim is "may read low, never high". That holds for bills and debt minimums: a held-back expense stays on
the curve, which can only lower the forecast.

**For income it runs the other way.** A held-back paycheck stays on the curve while its deposit is already in cash, so
the paycheck counts twice.

**Repro.** I ran a temporary probe (not committed) against both sources.

- Setup: balance 1,000.00 read on 05-01; today is 05-14.
- "Acme Payroll" is +$2,000 monthly on the 15th, with no category.
- April's deposit "ACME PAYROLL" +1,900 posts on 04-15. It is named, 5% under, and not ambiguous: tier 3.
- May's exact +2,000 arrives a day early, on 05-14: tier 2.

| | `2731077` | This branch |
|---|---|---|
| April pair | tier 3, medium, not ambiguous | same |
| May pair | `tier: 2, offCurve: true` | `tier: 3, offCurve: false` (held back) |
| bankToday | 3,000.00 | 3,000.00 |
| 05-15 balance | 3,000.00 | **5,000.00**: May's $2,000 counted twice, reading high |
| `incomeNotArrived` | empty | empty |

**The last row shows the inconsistency.** PR6's income-arrival rule (`isEvidence`: a non-ambiguous deposit of any tier)
still says April's paycheck arrived. The hold-back now says it did not.

**Who is exposed.** An income item is exposed when two things are true:

- an earlier occurrence was paid by a named deposit that is not tier-2 evidence (for example, more than max($1, 1%)
  under the plan, with no income category of its own);
- the next deposit arrives before its due date.

In the seed-shaped household each paycheck has its own income category (rule a, ±10%), so F1 and F2 are unaffected. A
household with uncategorized or manual paycheck rows and a variable paycheck is exposed.

**Not changed here.** Any fix is a second financial rule, and the work order keeps that out of scope. Two examples:

- apply the stricter rule to expenses only;
- let an income occurrence count as paid for the hold-back on the same evidence that makes it "arrived".

**Owner question:** for income, which way should the hold-back fail?

**Pre-existing, not caused by this PR (seen while probing).** On a **biweekly** paycheck, an early deposit posts 13 days
after the previous occurrence, so it is also a candidate for that occurrence. When the previous deposit was off-amount,
the previous pair becomes ambiguous, and it already holds the early paycheck back on `2731077`. That is the same double
count: 5,000.00 on both sources in the probe. Any income fix should cover this case too.

## The model rule (plan section B, hold-back)

Section B grades every pair:

- **tier 1, explicit:** a matched or partial answer, or a debt tag equal to the plan's debt;
- **tier 2, obligation evidence:** the bill's sole category, a unique full name, a confirmed descriptor inside the
  confirmed range, or name evidence within max($1, 1%) and 5 days;
- **tier 3:** anything else paired, a suggestion only.

PR-B applied the tiers to overdue evidence and to `offCurve`. This PR applies them to the hold-back:

> A later occurrence of an item never leaves the curve on a row dated on or after an earlier, unpaid occurrence of the
> same item. An earlier occurrence counts as paid **only** when its own pair is tier 1 or 2.

An answered occurrence (matched, partial, missed, skipped) never enters the matcher, so it never holds anything back.

Unchanged: where the hold-back applies (a later plan due after the drag cutoff, or a weekly-cadence expense), the windows
(only earlier occurrences dated today − 45 days or later can hold anything back), the tiers themselves, overdue evidence,
the card-payment rule, and both remainder drags.

## Every copy of the rule

| File | What it holds | Changed? |
|---|---|---|
| `artifacts/api-server/src/lib/forecastLedger.ts`, the `pairedKeys` filter (~line 939) | **The only executable copy.** It was `tier ≤ 2`, OR (not ambiguous AND confidence ≠ "low" AND the row not tagged to another debt). It is now `tier ≤ 2`. The debt-tag check and its `rowDebtById` map are removed: `tierOf` already grades a row tagged to another debt as tier 3, so no tier ≤ 2 pair can carry one. The two comments that describe the rule (~line 756 and ~line 930) are rewritten. | **Yes** |
| `lib/avalanche-core/src/planMatch.ts` | It grades pairs (`tier`, `confidence`, `ambiguous`, `offCurve`) and holds no earlier-occurrence logic. `matchPlansToRows` has one caller, the ledger. | No: nothing to change |
| `artifacts/h2budget/src/lib/forecastMatch.ts` | `buildLineRegister` copies the server's `matches` into `probablyPaid` (`tier`, `offCurve`, `remainderAmount`) and reads `offCurve` for the no-bank running balance. It has no hold-back of its own. | No |
| `artifacts/h2budget/src/lib/forecastReconcile.ts` | `computeBankReconcile` reads `offCurve` and `remainderAmount`. It has no hold-back of its own. | No |

**Parity.** The ledger demotes a held-back pair before it leaves the server (`tier: 3`, `evidence: null`,
`offCurve: false`). Both web files only read that result, so server and web cannot disagree.

**Search.** I also searched the whole repo for `confidence === "low"`, `confidence !== "low"` and `ambiguous ||`. The
only other hit is `scripts/src/detectSubscriptions.ts`, which detects subscriptions and is unrelated.
`lib/api-spec/openapi.yaml` has no hold-back wording. Its "any confidence, not ambiguous" line is the income-arrival rule
(`isEvidence`), which is unchanged.

**Other text touched:**

- the HOME DEPOT comment in `cashSignalProbablyPaid.integration.test.ts`. Its assertions are unchanged: a nameless tier-3
  pair reads the same under both rules.
- a short "Closed by PR-B2" paragraph under the MEDIUM residual in `2026-09-11-match-evidence-tiers.md`.

## Tests

The tests use two fixtures:

- `cashSignalProbablyPaid.integration.test.ts`: balance 1,000.00 read on 05-01; today is 05-14.
- `cashSignalSeedHouseholdTiers.integration.test.ts`: the seed-shaped household; balance 10,000.00, buffer 500.

### (a) The City Water meter fee (replaces round 4's residual pin)

"City Water" is $150 a month, due on the 20th. The rows are "CITY WATER METER FEE" −140 on 04-15 and "CITY WATER" −150 on
05-12.

- **April's suggestion is still offered.** April pairs with the fee: `confidence: "medium"`, not ambiguous, `tier: 3`,
  `offCurve: false`.
- **April stays unpaid.** It is listed in `overdueOutsideForecast` and absent from `overdueAssumedPaid`.
- **The late row is held back for April.** The 05-12 row is 22 days after April's due date, past April's +14-day window,
  so it can only pair with May. That pair is held back: `tier: 3`, `offCurve: false`.
- **In cash terms the row is April's late payment.** It leaves the bank once (bankToday 850.00) and is not credited to
  May.
- **May stays on the curve.** The 05-20 balance is **700.00**.

The replaced assertion is round 4's residual pin, "known — not fixed". It had May at `tier: 2, offCurve: true` and a 05-20
balance of 850.00, which is the forecast reading high by $150.

### (b) D3: July confirmed as `matched` (tier 1) frees August

D3 uses the D2 household (below) and reads it twice.

- **Before the answer:** August's pair is `tier: 3, offCurve: false`, and the ending balance is 15,955.20.
- **The answer:** a `matched` answer for July's 07-07 occurrence, on July's own $685.00 row.
- **After the answer:**
  - July's pair is gone from `matches`, because an answered occurrence never reaches the matcher.
  - August is `dayDelta: -3, tier: 2, offCurve: true`.
  - Lowest 8,528.00, max safe extra 8,028.00, ending **16,628.00**: D's figures.

### (c) A tier-2 earlier pair still frees the later row (unchanged)

City Water is in its own category, the only bill there.

- **Rows.** The same meter fee on 04-15. April is paid on 04-20 by a nameless "ACH AUTOPAY 0420" −150 in that category
  (tier 2 by rule a, with `confidence: "low"`). May's "CITY WATER" −150 is on 05-12.
- **Results.** April pairs with the autopay at `tier: 2`: a pair that proves something ranks ahead of the fee. May is
  `tier: 2, offCurve: true`. The 05-20 balance is **850.00**.
- **Why nameless.** The earlier pair is deliberately nameless, because the new rule reads the tier, not the name.

### D2: updated to the owner's decision

D2 is "08-05, July Toyota paid $685.00 (a late fee: tier 3)". July's $685.00 row on 07-13 pairs with July's $672.80 plan
at $12.20 over: named, not ambiguous, tier 3. August's exact $672.80 posts on 08-04.

| | Before (`2731077`) | After |
|---|---|---|
| August pair | `tier: 2, offCurve: true` | `tier: 3, offCurve: false` (held back) |
| July pair | `difference 12.20, ambiguous false, tier 3` | same, plus `offCurve: false` asserted |
| lowest / max safe extra | 8,528.00 / 8,028.00 | 8,528.00 / 8,028.00 |
| ending balance (08-07) | 16,628.00 | **15,955.20** |

Hand-worked figures:

- 08-06 = 10,000 − 200 − 440.45 − 180.00 − 651.55 = 8,528.00 (unchanged).
- 08-07 = 8,528.00 + 8,100.00 − 672.80 = 15,955.20.

The low point does not move, because Toyota lands on 08-07, the same day as the $8,100 paycheck.

**This replaces round 3's D2 assertion. It is the owner's 2026-09-15 decision, taken in the stricter direction:** a paid
bill drags until confirmed, rather than an unpaid bill leaving the curve. D3 shows the way out. `earlyAugust()` now
returns July's row id for D3; case D is otherwise unchanged. No other test was changed or weakened.

### Fails before, passes after

I ran the two files with the new tests in place, first on the `2731077` source (before the `forecastLedger.ts` change),
then after it.

| Test | On `2731077` | After |
|---|---|---|
| (a) meter fee | **fails**: May's pair came back `tier: 2, offCurve: true` | passes |
| D2 (updated) | **fails**: ending came back 16628.00, expected 15955.20 | passes |
| (b) D3 | **fails** at its before-answer step: ending came back 16628.00, expected 15955.20 | passes |
| (c) tier-2 earlier pair | passes, by design (unchanged behaviour) | passes |
| Both files | 3 failed, 29 passed | 32 passed |

(b)'s confirmed half passes on both sources, because a `matched` July never entered the hold-back before either. The
test fails first because it proves August drags **until** the answer, then clears.

(c) cannot fail on `2731077`, because it guards behaviour the owner kept. To show it is load-bearing, I ran two throwaway
mutations of the new filter, each reverted afterwards:

| Mutation | Tests failing in the two files |
|---|---|
| `tier ≤ 1` (only explicit proof counts) | 7, including (c); also D, F1, F2 and three PR5 cases |
| `tier ≤ 2 && confidence !== "low"` (proof must also be named) | 2: (c) and F1 |

## Golden and household scenario

No entry changed, so nothing was re-recorded. `forecastLedger.golden.integration.test.ts` and
`householdScenario.integration.test.ts` pass under `CI=true` as committed (2 files: 21 passed, 7 todo), and the snapshot
file is untouched.

Neither fixture has a named tier-3 earlier pair, so the removed branch never decided anything there:

- **Golden:** the rows are nameless ("golden <date> <amount>"), and the only pair is the Golden Card minimum (tier 2).
- **Household scenario:** it has no such pair either.

## Review still shows the close call (step 5)

No UI was added. What I checked:

1. **Server.** The earlier occurrence's tier-3 pair stays in `CashSignal.matches` as a suggestion, and so does the
   held-back later pair. This is asserted in (a) (April's fee pair and May's pair), D2 (July's and August's pairs) and
   D3 (before the answer).
2. **Web register.** A temporary vitest (TZ=America/Chicago, 2/2 passed; not committed, deleted after the run) fed
   `buildLineRegister` the D2 and meter-fee pairs. The pairs were hand-built to match what the server tests assert; they
   were not captured from a live response. It set `lingerPastDuePlans: true`, which is what the Review page uses
   (`forecast.tsx`, `mode === "review"`):
   - the past-due earlier plan (July, April) stays on the register as `pending_plan`, with
     `probablyPaid { tier: 3, offCurve: false }` for its row;
   - the later plan (August, May) is `future`, carrying its held-back pair;
   - each bank row carries `suggestedPlan`;
   - the forward view drops the past-due July plan, as before.
3. **Rendering.** The existing test in `forecastProbablyPaid.test.tsx`, "(decision 13) … a tier-3 pair is a suggestion
   that keeps Move and Mark missed", shows a tier-3 pair as "Suggested" and "Still in forecast", with Confirm and Not
   this. It is unchanged and passing.
4. **Badge.** `computeReviewCount` counts unresolved checking rows in the current month, so a held-back row in the
   current month (05-12, 08-04) stays counted until it is answered.

## Known effect: the forecast can read low until a close call is confirmed

This section covers bills and debt minimums. For income, see the OPEN section above.

- **What reads low.** When an earlier occurrence's only pair is a suggestion, the later occurrence keeps its **full**
  planned amount on the curve, even if the later row really paid it. In D2 the ending balance reads $672.80 low
  (15,955.20 against 16,628.00) until July is answered. Any figure read off the curve in that window (low point, max safe
  extra, ending balance) can read low by up to that bill's amount.
- **How it clears.** Confirm (matched) or Partial on the earlier occurrence frees the later row. Mark missed or Skip also
  takes the earlier occurrence out of the matcher. "Not this" on the earlier pair leaves the earlier occurrence unpaid,
  so the later row stays held back; that is correct when the suggestion really wasn't that month's payment.
- **How far it reaches.** Only earlier occurrences dated today − 45 days or later hold anything back. They only hold back
  plans the curve reads by `offCurve`: plans due after the drag cutoff, and weekly-cadence expenses.
- **What is closed.** The opposite failure (round 4's MEDIUM residual, reading high by a whole bill) is closed. With it
  goes round 4's follow-on note for this shape: the later pair is now tier 3, so it no longer drives
  `remainder_assumed_unpaid` either.

## Gates

- `pnpm run typecheck`: pass.
- Web tests: `TZ=UTC CI=true` 139 files, 1,148 passed, 3 skipped. `TZ=America/Chicago CI=true` 139 files, 1,149 passed,
  2 skipped.
- Full API suite (`CI=true`, own DB `h2budget_test_prb2`, `caffeinate -i`, serial): **145 files, 1,476 passed, 7 todo.**
  That is main's 1,474, minus the replaced residual pin, plus (a), (c) and D3.
- `pnpm build` then `node scripts/check-entry-graph.mjs`: OK. The landing bundle is 574.4 KB of 580.0 KB (unchanged).
- Codegen: not run; `lib/api-spec` is untouched.
- e2e: not run (no UI change).
