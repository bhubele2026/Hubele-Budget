# PR-B2: the hold-back needs proof (owner decision, 2026-09-15)

Branch `fix/holdback-proof-only`, cut from main `2731077`. It merges main `2e1949f` (round 1) and `b939039` (round 2). One
money rule changes: the forecast's hold-back. There is no UI, API spec, schema or codegen change. All figures are
synthetic test fixtures.

**Status after round 2:**

- Outflows (bills, debt minimums, the Avalanche extra) need tier-1/2 proof for the hold-back.
- Income keeps its arrival rule, exactly as on main.
- Two pre-existing income double counts are pinned as known issues, not fixed: a biweekly early paycheck (for PR9), and
  a nameless earlier deposit (open for the lead). See Round 2.

## The owner's decision, in plain words

Sometimes one bank row could belong to either of two months of the same bill. The forecast first asks whether the
earlier month is already paid; if it is not, the row is held back for it (it may be that month, paid late), and the later
month stays in the forecast.

Until now "already paid" could mean a pair that merely carried the payee's name. For a bill, it now needs proof: a
confirmed answer, a debt tag, or tier-2 obligation evidence. When the only thing pointing at the earlier month is a
suggestion, the earlier month stays unpaid, the later row is held back, and the later month stays in the forecast until
the owner answers the close call in Review.

The owner's principle: **the forecast may read low, never high.**

- For a bill, holding a row back keeps the bill on the curve, which can only read low.
- For income, it would keep a paycheck on the curve while its deposit is already in cash, which reads high. So income
  keeps its arrival rule (round 2).

## The model rule (plan section B, hold-back)

Section B grades every pair:

- **tier 1, explicit:** a matched or partial answer, or a debt tag equal to the plan's debt;
- **tier 2, obligation evidence:** the bill's sole category, a unique full name, a confirmed descriptor inside the
  confirmed range, or name evidence within max($1, 1%) and 5 days;
- **tier 3:** anything else paired, a suggestion only.

PR-B applied the tiers to overdue evidence and to `offCurve`. This PR applies them to the hold-back:

> A later occurrence of an item never leaves the curve on a row dated on or after an earlier, unpaid occurrence of the
> same item.
>
> - **Outflow** (`planAmount < 0`): the earlier occurrence counts as paid **only** when its own pair is tier 1 or 2.
> - **Income** (`planAmount > 0`): the earlier occurrence counts as received on main's rule. That means a tier 1 or 2
>   pair, or a named (confidence not "low"), non-ambiguous deposit, on a row not tagged to another debt.

An answered occurrence (matched, partial, missed, skipped) never enters the matcher, so it never holds anything back.

Unchanged: where the hold-back applies (a later plan due after the drag cutoff, or a weekly-cadence expense), the windows
(only earlier occurrences dated today − 45 days or later can hold anything back), the tiers themselves, overdue evidence,
the income-arrival rule, the card-payment rule, and both remainder drags.

## Every copy of the rule

| File | What it holds | Changed? |
|---|---|---|
| `artifacts/api-server/src/lib/forecastLedger.ts`, the `pairedKeys` filter (~line 945) | **The only executable copy.** On main it was: `tier ≤ 2`, OR (not ambiguous AND confidence ≠ "low" AND the row not tagged to another debt), for every plan. Now: `tier ≤ 2` → paid; otherwise an outflow (`planAmount < 0`) is unpaid; otherwise (income) main's condition. The two comments that describe the rule (~line 756 and ~line 930) are rewritten. | **Yes** |
| `lib/avalanche-core/src/planMatch.ts` | It grades pairs (`tier`, `confidence`, `ambiguous`, `offCurve`) and holds no earlier-occurrence logic. `matchPlansToRows` has one caller, the ledger. | No: nothing to change |
| `artifacts/h2budget/src/lib/forecastMatch.ts` | `buildLineRegister` copies the server's `matches` into `probablyPaid` (`tier`, `offCurve`, `remainderAmount`) and reads `offCurve` for the no-bank running balance. It has no hold-back of its own. | No |
| `artifacts/h2budget/src/lib/forecastReconcile.ts` | `computeBankReconcile` reads `offCurve` and `remainderAmount`. It has no hold-back of its own. | No |

**Parity.** The ledger demotes a held-back pair before it leaves the server (`tier: 3`, `evidence: null`,
`offCurve: false`). Both web files only read that result, so server and web cannot disagree, whether the plan is an
outflow or income.

**Search.** I also searched the whole repo for `confidence === "low"`, `confidence !== "low"` and `ambiguous ||`. The
only other hit is `scripts/src/detectSubscriptions.ts`, which detects subscriptions and is unrelated.
`lib/api-spec/openapi.yaml` has no hold-back wording. Its "any confidence, not ambiguous" line is the income-arrival rule
(`isEvidence`), which is unchanged.

**Other text touched:**

- the HOME DEPOT comment in `cashSignalProbablyPaid.integration.test.ts`. Its assertions are unchanged.
- a short "Closed by PR-B2" paragraph under the MEDIUM residual in `2026-09-11-match-evidence-tiers.md`.

---

## Round 1: tier-1/2 proof for the hold-back

### Tests

The tests use two fixtures:

- `cashSignalProbablyPaid.integration.test.ts`: balance 1,000.00 read on 05-01; today is 05-14.
- `cashSignalSeedHouseholdTiers.integration.test.ts`: the seed-shaped household; balance 10,000.00, buffer 500.

#### (a) The City Water meter fee (replaces round 4's residual pin)

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

#### (b) D3: July confirmed as `matched` (tier 1) frees August

D3 uses the D2 household (below) and reads it twice.

- **Before the answer:** August's pair is `tier: 3, offCurve: false`, and the ending balance is 15,955.20.
- **The answer:** a `matched` answer for July's 07-07 occurrence, on July's own $685.00 row.
- **After the answer:**
  - July's pair is gone from `matches`, because an answered occurrence never reaches the matcher.
  - August is `dayDelta: -3, tier: 2, offCurve: true`.
  - Lowest 8,528.00, max safe extra 8,028.00, ending **16,628.00**: D's figures.

#### (c) A tier-2 earlier pair still frees the later row (unchanged)

City Water is in its own category, the only bill there.

- **Rows.** The same meter fee on 04-15. April is paid on 04-20 by a nameless "ACH AUTOPAY 0420" −150 in that category
  (tier 2 by rule a, with `confidence: "low"`). May's "CITY WATER" −150 is on 05-12.
- **Results.** April pairs with the autopay at `tier: 2`: a pair that proves something ranks ahead of the fee. May is
  `tier: 2, offCurve: true`. The 05-20 balance is **850.00**.
- **Why nameless.** The earlier pair is deliberately nameless, because the rule reads the tier, not the name.

#### D2: updated to the owner's decision

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

### Fails before, passes after (round 1)

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
mutations of the round-1 filter, each reverted afterwards:

| Mutation | Tests failing in the two files |
|---|---|
| `tier ≤ 1` (only explicit proof counts) | 7, including (c); also D, F1, F2 and three PR5 cases |
| `tier ≤ 2 && confidence !== "low"` (proof must also be named) | 2: (c) and F1 |

### Golden and household scenario

No entry changed in either round, so nothing was re-recorded. `forecastLedger.golden.integration.test.ts` and
`householdScenario.integration.test.ts` pass under `CI=true` as committed (2 files: 21 passed, 7 todo), and the snapshot
file is untouched.

Neither fixture has a named tier-3 earlier pair, so the removed outflow branch never decided anything there:

- **Golden:** the rows are nameless ("golden <date> <amount>"), and the only pair is the Golden Card minimum (tier 2).
- **Household scenario:** it has no such pair either.

### Review still shows the close call (step 5)

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

### Known effect: bills can read low until a close call is confirmed

- **What reads low.** When an outflow's earlier occurrence has only a suggestion, the later occurrence keeps its **full**
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

### Round 1's OPEN finding: income read HIGH (resolved in round 2)

Round 1 applied the stricter rule to every plan. A temporary probe showed that for income it reads high. The same fixture
is now a committed test (Round 2, test R2-1).

- **Setup:** a $2,000 monthly paycheck with no category. April's deposit arrived $100 short (named, tier 3). May's exact
  deposit arrived a day early.
- **Result:** the 05-15 balance read 3,000.00 on `2731077` and **5,000.00** on round 1, because May was held back and
  counted twice.
- **The two rules disagreed:** the income-arrival rule still said April arrived; the hold-back said it had not.

---

## Round 2: outflows only; income keeps its arrival rule

### Why

The lead's direction: apply the strict hold-back to outflows only, and let income keep its arrival rule. **This carries
out the owner's stated principle ("the forecast may read low, never high"); it is not a new money decision.** For a bill,
holding a later row back can only read low. For income, it reads high: a held-back paycheck stays on the curve while its
deposit is already in cash.

### The change

`forecastLedger.ts`, the `pairedKeys` filter only:

```ts
if (m.tier <= 2) return true;
if (m.planAmount < 0) return false;                    // an outflow needs tier-1/2 proof
if (m.ambiguous || m.confidence === "low") return false; // income: main's rule
return !(rowDebt && planDebt && rowDebt !== planDebt);   // (main's tag check, kept for income)
```

- **Outflows:** round 1, unchanged.
- **Income:** byte-for-byte main's `2731077` condition, including its debt-tag check (the `rowDebtById` map comes back).
  It agrees with the income-arrival rule (`isEvidence`: not ambiguous) for any **named** deposit. For a nameless one
  they still disagree, as on main; see "Still open" below.
- **Other copies:** `planMatch.ts`, `forecastMatch.ts` and `forecastReconcile.ts` still have no copy of the rule.

### Tests: before and after

New tests (`cashSignalProbablyPaid.integration.test.ts`, describe "(PR-B2 round 2) the hold-back reads income by its
arrival rule"). Fixture: balance 1,000.00 read 05-01, today 05-14. "Acme Payroll" is +$2,000.

| Test | `2731077` | Round 1 (`24b9d0fe`) | Round 2 |
|---|---|---|---|
| **R2-1** monthly paycheck: April $1,900 (named, tier 3), May's $2,000 a day early | passes (05-15: 3,000.00) | **fails**: May's pair `tier: 3, offCurve: false`; 05-15 reads 5,000.00 | passes: May `tier: 2, offCurve: true`; 05-15 **3,000.00** |
| **R2-2** (KNOWN ISSUE, PR9) biweekly: 05-01 $1,900, 05-15's $2,000 a day early | passes, pinned at 5,000.00 | passes, 5,000.00 | passes, 5,000.00 (right answer 3,000.00) |
| **R2-3** (control) the same biweekly household, 05-01 exact | passes, 3,000.00 | passes | passes |
| **R2-4** (KNOWN ISSUE, open) monthly: April exact but nameless, May a day early by name | 5,000.00 (probe) | 5,000.00 | passes, pinned at 5,000.00 (right answer 3,000.00) |

R2-1 also asserts:

- April's pair is `confidence: "medium"`, not ambiguous, tier 3;
- April is absent from `incomeNotArrived`;
- bankToday is 3,000.00.

Tests round 2 leaves unchanged, re-run on the final tree. All are outflow plans, which keep round 1's rule:

| Test | Round 1 | Round 2 |
|---|---|---|
| (a) City Water meter fee | May `tier 3, offCurve false`; 05-20 700.00 | same |
| (c) tier-2 earlier pair | May `tier 2, offCurve true`; 05-20 850.00 | same |
| D2 | August `tier 3, offCurve false`; 8,528.00 / 8,028.00, ending 15,955.20 | same |
| D3 | ending 15,955.20 → 16,628.00 after July's `matched` answer | same |
| HOME DEPOT cases (round 3) | 05-20 700.00 / 2,850.00 | same |

### Fails before, passes after (round 2)

These runs used the round-2 tests.

| Source | The two hold-back files |
|---|---|
| Round 1 ledger (`24b9d0fe`) | 1 failed (R2-1), 34 passed |
| `2731077` ledger (`cashSignalProbablyPaid` file only) | 1 failed ((a), round 1's own fix), 24 passed. R2-1, R2-2 and R2-3 pass, which shows R2-2's 5,000.00 predates PR-B2 |
| Round 2 ledger | 35 passed |

R2-4 was added after those runs, from a temporary probe that read 5,000.00 on both the `2731077` and round-2 ledgers.
With it, the file has 36 tests on the final tree.

### The biweekly double count: pinned for PR9, not fixed

**Repro (R2-2).**

- A $2,000 paycheck every 14 days (04-17, 05-01, 05-15); the deposit on 04-17 is exact.
- 05-01's deposit is $1,900 (named, $100 short).
- 05-15's $2,000 arrives a day early, on 05-14.

**Mechanism: the matcher's `ambiguous` flag in `matchPlansToRows` (`planMatch.ts`), not the hold-back.**

1. The 05-14 deposit is 13 days after the 05-01 occurrence, inside its +14-day window, so it is a candidate for both 05-01
   and 05-15. It pairs with 05-15, the better score.
2. 05-01 then pairs with its own $1,900 deposit. That pair cannot be tier 2 ($100 short), so it ranks below the 05-14
   candidate for the same plan.
3. A pair is marked `ambiguous` whenever a same-or-better-ranked candidate for its plan (or row) scores within the margin
   **or better**. That candidate still counts even though its row already went to 05-15. So 05-01's pair is ambiguous.
4. The income-arrival rule and the hold-back both read that flag correctly. 05-01 is listed in `incomeNotArrived`, and it
   is not received for the hold-back. So 05-15's pair is held back, and +$2,000 stays on the curve while the deposit is
   already in cash.

R2-3 is the control: with 05-01 paid exactly, no pair is ambiguous and 05-15 counts once (3,000.00).

**Dollar effect on the fixture.** The forecast reads high by **$2,000**, one paycheck, from 05-15 to the end of the
horizon: 05-15 reads 5,000.00 instead of 3,000.00. Any low point, max safe extra or ending balance read after 05-15 can
read high by up to $2,000. `incomeNotArrived` also wrongly lists the 05-01 paycheck.

**When it happens:** all three of these together:

- a paycheck every 14 days or less;
- the previous deposit is not tier-2 evidence (for example, more than max($1, 1%) off, with no income category of its
  own);
- the next deposit arrives before its due date.

For a bill the same ambiguity only holds a later row back, which reads low.

**Workaround today.** Confirming the earlier paycheck in Review should clear it. That is the same path D3 proves for
bills (an answered occurrence never reaches the matcher); it is not separately tested for income.

**Why not fixed here.** The lead's bar was "the same hold-back or arrival mechanism, a small fix, and it reads lower".
This case misses it:

1. **The cause is the matcher's ambiguity flag, which bills share.** Ignoring a better candidate whose row another plan
   took would also un-flag bill pairs. An un-flagged bill pair can become tier 2 and leave the curve, so the forecast
   could read **higher**. That is a matcher rule change, not a small lower-only fix.
2. **A hold-back-only patch would read lower, but it breaks this round's rule.** Counting an ambiguous income pair as
   received would override the income rule round 2 restores. It would also leave `incomeNotArrived` listing a paycheck
   that arrived, so the two rules would disagree again. That would be a second money rule this round's direction didn't
   include.

**For PR9 (income states).** R2-2 pins today's wrong value and should flip to 3,000.00 there. One candidate for PR9 to
weigh, not decided here: for income pairs only, a better candidate whose row a higher-ranked pair already took should not
make a pair ambiguous.

### Still open: a nameless earlier paycheck (pinned; the lead's call)

**Repro (R2-4).**

- April's $2,000 arrives exactly on 04-15, as "DIRECT DEP 7781": nameless, so `confidence: "low"`, not ambiguous, tier 3.
- May's $2,000 arrives a day early, by name.

**Result.**

- The income-arrival rule (`isEvidence`: not ambiguous) counts April received, so `incomeNotArrived` is empty.
- Main's hold-back rule, which round 2 gives income back, leaves out low-confidence pairs. So May is held back and counts
  twice: 05-15 reads **5,000.00**, right answer 3,000.00, high by $2,000.
- This is the same on `2731077` and on round 2.

**Not changed.** Round 2's direction named main's condition for income. One option for the lead: use the arrival rule
itself (`!m.ambiguous`) for income in the hold-back.

- For income it can only read lower.
- The hold-back and the arrival rule would then agree for every deposit.
- The cost: a nameless coincidental deposit could count an unpaid paycheck as received, reading low by one paycheck.

### Gates (round 2, merged tree)

**Tree.** Round 2 is committed as `82e1633` and merged with origin/main `b939039` (R0, the five-destination navigation,
web only) as `c6d6166`. There were no conflicts and no overlap: the merged tree differs from `b939039` only in this PR's
five files. Every gate was run on the merge commit:

- `pnpm build` (runs `pnpm run typecheck` first): pass.
- **Web tests** (the counts are R0's; this PR adds no web code):
  - `TZ=UTC CI=true`: 140 files, 1,212 passed, 3 skipped.
  - `TZ=America/Chicago CI=true`: 140 files, 1,213 passed, 2 skipped.
- **Full API suite** (`CI=true`, own DB `h2budget_test_prb2`, `caffeinate -i`, serial): **145 files, 1,481 passed,
  7 todo.** That is round 1's merged 1,477 plus R2-1 through R2-4.
- `node scripts/check-entry-graph.mjs`: OK, 575.7 KB of 580.0 KB. The rise from 574.4 KB is R0's layout change; this PR
  changes no web file.
- **Codegen:** not needed. No file under `lib/api-spec`, `lib/api-zod`, `lib/api-client-react` or `lib/db` differs from
  origin/main.
- **e2e:** not run (no UI change in this PR).
- **Golden and household scenario:** part of the full suite above, unchanged, not re-recorded.

**A recovery before the commit.** During round 2, a local probe command overwrote `forecastLedger.ts` with `2731077`'s
version. A zsh glob matched nothing and aborted the backup step, but the file swap still ran. Nothing had been committed.
I restored the file from `24b9d0fe`, re-applied the two round-2 edits, and checked `git diff` against HEAD: it shows only
the round-2 change. Then I re-ran the two hold-back files, before this commit and before the gates above.

---

## Round 1 gates

### On the merged tree (`0b4015c`: round 1 plus main `2e1949f`, the seed-bills tool removal)

The branch was built on `2731077`, then origin/main `2e1949f` was merged in, with no conflicts and no overlap. Every gate
was re-run on the merge commit:

- `pnpm build` (runs `pnpm run typecheck` first): pass.
- Web tests: `TZ=UTC CI=true` 139 files, 1,148 passed, 3 skipped. `TZ=America/Chicago CI=true` 139 files, 1,149 passed,
  2 skipped.
- Full API suite (`CI=true`, own DB `h2budget_test_prb2`, `caffeinate -i`, serial): 145 files, 1,477 passed, 7 todo.
  The count is one higher than before the merge, because main's change adds a test to
  `seedDefaultsOnce.integration.test.ts`.
- `node scripts/check-entry-graph.mjs`: OK. The landing bundle is 574.4 KB of 580.0 KB (unchanged).
- Codegen: not needed; neither side touches `lib/api-spec`, `lib/api-zod` or `lib/api-client-react`.
- e2e: not run (no UI change).

### Before the merge (`dea25f7` on `2731077`)

- `pnpm run typecheck`: pass. Web: the same counts as above.
- Full API suite: 145 files, 1,476 passed, 7 todo. That is main's 1,474, minus the replaced residual pin, plus (a), (c)
  and D3. It was re-run on the exact committed tree after the temporary probes were deleted.
- `pnpm build` + `check-entry-graph`: OK, 574.4 KB.
