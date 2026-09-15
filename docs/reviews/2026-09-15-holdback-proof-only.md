# PR-B2: the hold-back needs proof (owner decision, 2026-09-15)

Branch `fix/holdback-proof-only`, cut from main `2731077`. It merges main `2e1949f` (round 1), `b939039` (round 2),
`9aad763` (round 3) and `f96afb1` (round 4). Round 4 adds the review's fixes. One money rule changes, the forecast's hold-back, plus a guard so a
held-back row pays nothing else. There is no UI, API spec, schema or codegen change in this PR. All figures are synthetic
test fixtures.

**Status after round 4:**

- **Outflows** (bills, debt minimums, the Avalanche extra) need tier-1/2 proof for the hold-back.
- **Income** uses the arrival rule itself. An earlier paycheck counts as received for the hold-back exactly when it counts
  as arrived (`isEvidence`: a tier-1 tagged deposit, or a pair that is not ambiguous). One definition serves both.
- **A held-back row is used up.** It can no longer pay another plan through the listing pass or the card-payment rule
  (round 4, review HIGH).
- **One pre-existing income double count stays pinned for PR9:** a biweekly early paycheck after an off-amount one. Its
  cause is the matcher's ambiguity flag.

## The owner's decision, in plain words

Sometimes one bank row could belong to either of two months of the same bill. The forecast first asks whether the
earlier month is already paid; if it is not, the row is held back for it (it may be that month, paid late), and the later
month stays in the forecast.

Until now "already paid" could mean a pair that merely carried the payee's name. For a bill, it now needs proof: a
confirmed answer, a debt tag, or tier-2 obligation evidence. When the only thing pointing at the earlier month is a
suggestion, the earlier month stays unpaid, the later row is held back, and the later month stays in the forecast until
the owner answers the close call in Review.

The owner's principle: **the forecast may read low, never high.**

- For a bill, holding a row back keeps the bill on the curve, which can only read low, as long as the held-back row pays
  nothing else (round 4).
- For income, holding a row back would keep a paycheck on the curve while its deposit is already in cash, which reads
  high. So income counts an earlier paycheck as received whenever it counts as arrived (rounds 2 to 4).

## The model rule (plan section B, hold-back)

Section B grades every pair:

- **tier 1, explicit:** a matched or partial answer, or a debt tag equal to the plan's debt;
- **tier 2, obligation evidence:** the bill's sole category, a unique full name, a confirmed descriptor inside the
  confirmed range, or name evidence within max($1, 1%) and 5 days;
- **tier 3:** anything else paired, a suggestion only.

PR-B applied the tiers to overdue evidence and to `offCurve`. This PR applies them to the hold-back:

> A later occurrence of an item never leaves the curve on a row dated on or after an earlier, unpaid occurrence of the
> same item. An earlier occurrence counts as paid exactly when its own pair is evidence it was paid (`isEvidence`):
>
> - **Outflow** (`planAmount < 0`): the pair is tier 1 or 2.
> - **Income** (`planAmount > 0`): the pair is tier 1 (a deposit tagged to the item's debt), or it is not ambiguous,
>   named or not. That is PR6's arrival rule, the same test that keeps a paycheck out of `incomeNotArrived`.
>
> A held-back pair's row is used up: it pays no other plan.

An answered occurrence (matched, partial, missed, skipped) never enters the matcher, so it never holds anything back.

**Unchanged:**

- where the hold-back applies (a later plan due after the drag cutoff, or a weekly-cadence expense);
- the windows (only earlier occurrences dated today − 45 days or later can hold anything back);
- the tiers themselves, overdue evidence, and both remainder drags;
- the income-arrival rule, except that a tier-1 tagged deposit now counts even when ambiguous (round 4).

**The card-payment rule itself is unchanged, but it no longer reads a held-back row.** Before round 4 it could, and did:
see Round 4, HIGH.

## Every copy of the rule

| File | What it holds | Changed? |
|---|---|---|
| `artifacts/api-server/src/lib/forecastLedger.ts`, the hold-back (~line 930) | **The only executable copy.** On main the `pairedKeys` filter was: `tier ≤ 2`, OR (not ambiguous AND confidence ≠ "low" AND the row not tagged to another debt), for every plan. Now it is `matches.filter(isEvidence)`. `isEvidence` moved up from below the hold-back and reads income `tier === 1 \|\| !ambiguous`, outflow `tier ≤ 2`. The rows the hold-back demotes (`heldBackTxnIds`) join `usedRows` before the listing pass and the card-payment rule. The comments that describe the rule (~line 756 and ~line 930) are rewritten. | **Yes** |
| `lib/avalanche-core/src/planMatch.ts` | It grades pairs (`tier`, `confidence`, `ambiguous`, `offCurve`) and runs the card-payment rule (`plansPaidInFullByName`) on the rows the ledger passes in. It holds no earlier-occurrence logic. | No: nothing to change (PR9's biweekly fix belongs here) |
| `artifacts/h2budget/src/lib/forecastMatch.ts` | `buildLineRegister` copies the server's `matches` into `probablyPaid` (`tier`, `offCurve`, `remainderAmount`) and reads `offCurve` for the no-bank running balance. It has no hold-back of its own. | No |
| `artifacts/h2budget/src/lib/forecastReconcile.ts` | `computeBankReconcile` reads `offCurve` and `remainderAmount`. It has no hold-back of its own. | No |

**No debt-tag guard.** `isEvidence` has no check for a row tagged to another debt.

- **Outflows don't need one.** `tierOf` grades such a pair tier 3, so it is never evidence.
- **Income:** a non-ambiguous deposit on a row tagged to another debt still counts as arrived, exactly as main's arrival
  rule already counted it. Since round 3 it also counts as received for the hold-back. For income that can only read
  lower.
- **Tier 1** is by definition a row tagged to the plan's own debt.

**Parity.** The ledger demotes a held-back pair before it leaves the server (`tier: 3`, `evidence: null`,
`offCurve: false`). Both web files only read that result, so server and web cannot disagree.

**Search.** I also searched the whole repo for `confidence === "low"`, `confidence !== "low"` and `ambiguous ||`. The
only other hit is `scripts/src/detectSubscriptions.ts`, which detects subscriptions and is unrelated.
`lib/api-spec/openapi.yaml` has no hold-back wording.

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
- **Why nameless.** The earlier pair is deliberately nameless, because for outflows the rule reads the tier, not the
  name.

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

No entry changed in any round, so nothing was re-recorded. `forecastLedger.golden.integration.test.ts` and
`householdScenario.integration.test.ts` pass under `CI=true` as committed; the snapshot file is main's (PR-K added
`account` to it).

Neither fixture has a pair whose treatment changed:

- **Golden:** the rows are nameless ("golden <date> <amount>"), the only pair is the Golden Card minimum (tier 2), and no
  deposit pairs with its paychecks.
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
  `remainder_assumed_unpaid` either. Round 1 left a second path to reading high, through the card-payment rule, which
  round 4 of this PR closes.

### Round 1's OPEN finding: income read HIGH (resolved in rounds 2–4)

Round 1 applied the stricter rule to every plan. A temporary probe showed that for income it reads high.

- **Setup:** a $2,000 monthly paycheck. April's deposit arrived $100 short (named, tier 3). May's exact deposit arrived a
  day early.
- **Result:** the 05-15 balance read 3,000.00 on `2731077` and **5,000.00** on round 1, because May was held back and
  counted twice.

That fixture is now committed as R2-1.

---

## Round 2: outflows only; income keeps its arrival rule

### Why

The lead's direction: apply the strict hold-back to outflows only, and let income keep its arrival rule. **This carries
out the owner's stated principle ("the forecast may read low, never high"); it is not a new money decision.** For a bill,
holding a later row back can only read low. For income, it reads high: a held-back paycheck stays on the curve while its
deposit is already in cash.

### What round 2 built (the income condition is superseded by rounds 3 and 4)

- **Outflows:** round 1's rule.
- **Income:** round 2 used main's named condition (tier ≤ 2, or confidence ≠ "low" and not ambiguous, plus main's
  debt-tag check). Round 3 replaced it with the arrival rule itself; round 4 added tier 1 to that rule.
- **Recovery before the commit.** During round 2, a local probe command overwrote `forecastLedger.ts` with `2731077`'s
  version. A zsh glob matched nothing and aborted the backup step, but the file swap still ran. Nothing had been
  committed. I restored the file from `24b9d0fe`, re-applied the round-2 edits, and checked `git diff` against HEAD
  (round-2 change only). The two hold-back files were re-run before the commit and before the gates. Since then, every
  file swap has used a commit as its backup and been verified clean with `git diff --quiet` afterwards.

### Tests added in round 2

These tests are in `cashSignalProbablyPaid.integration.test.ts`, in the describe now titled "(PR-B2 rounds 2–3)".

- **Fixture:** balance 1,000.00 read on 05-01; today is 05-14.
- **Paycheck:** "Acme Payroll", +$2,000.

| Test | `2731077` | Round 1 (`24b9d0fe`) | Round 2 (`3d56068c`) |
|---|---|---|---|
| **R2-1** monthly: April $1,900 (named, tier 3), May's $2,000 a day early | passes (05-15: 3,000.00) | **fails**: May's pair `tier: 3, offCurve: false`; 05-15 reads 5,000.00 | passes: May `tier: 2, offCurve: true`; 05-15 **3,000.00** |
| **R2-2** (KNOWN ISSUE, PR9) biweekly: 05-01 $1,900, 05-15's $2,000 a day early | 5,000.00 | 5,000.00 | pinned at 5,000.00 (right answer 3,000.00) |
| **R2-3** (control) the same biweekly household, 05-01 exact | 3,000.00 | 3,000.00 | 3,000.00 |
| R2-4 (KNOWN ISSUE, open) monthly: April exact but nameless, May a day early | 5,000.00 | 5,000.00 | pinned at 5,000.00; **replaced in round 3 by R3-1** |

**Fails before, passes after (round 2).**

- **On the round-1 ledger:** 1 failed (R2-1), 34 passed.
- **On `2731077`'s ledger** (probably-paid file only): R2-1, R2-2 and R2-3 passed. The one failure was (a), round 1's own
  fix. So R2-2's 5,000.00 predates PR-B2.
- **On the round-2 ledger:** 35 passed.

R2-4 was added afterwards from a probe that read 5,000.00 on both the `2731077` and round-2 ledgers.

---

## Round 3: income uses the arrival rule itself

### Why

The lead's direction: for income, the hold-back uses the arrival rule itself (`!m.ambiguous`), not main's named
condition. Round 2's wording ("as on main") was imprecise; this is the intent. **It carries out the owner's principle;
it is not a new money decision:**

- For income, counting more earlier paychecks as received only takes later paychecks off the curve, so it can only read
  lower.
- It makes the hold-back and the arrival rule agree fully. That removes round 2's nameless-paycheck double count
  (5,000.00 → 3,000.00).

### The change

`forecastLedger.ts` only:

```ts
const isEvidence = (m: PlanRowMatch): boolean => (m.planAmount > 0 ? !m.ambiguous : m.tier <= 2); // moved up (round 4 adds tier 1)
const pairedKeys = new Set(matches.filter(isEvidence).map((m) => m.planKey));
```

- **Income:** character for character the arrival rule, because it is the same function.
- **Outflows:** `tier ≤ 2`, unchanged.
- **Removed:** round 2's named condition, and its debt-tag check with the `rowDebtById` map.
- **Nothing else moves:** `isEvidence`'s other readers (used rows, listing pairs, due debt minimums, `paidByKey`) run
  after the hold-back exactly as before.

### Every test whose expected value changed in round 3

| Test | Round 2 (`3d56068c`) | Round 3 |
|---|---|---|
| **R3-1** (was R2-4): April's $2,000 exact but nameless ("DIRECT DEP 7781"), May's a day early by name | KNOWN ISSUE pin: May `tier: 3, offCurve: false`; 05-15 **5,000.00** | a normal passing test: May `tier: 2, offCurve: true`; 05-15 **3,000.00**. April's pair is still `confidence: "low"`, not ambiguous, tier 3; April is absent from `incomeNotArrived` |
| **R3-2** (new, the cost): a nameless $2,000 "MOBILE CHECK DEP 0415" on April's date; April's real paycheck arrives late on 05-14 | not present (on `3d56068c` it reads May `tier: 3`, 05-15 5,000.00) | before an answer: May `tier: 2, offCurve: true`, 05-15 **3,000.00**, where the truth is 5,000.00 (one paycheck low). After "Not this" on April's pair: April has no pair, May is `tier: 3, offCurve: false`, 05-15 **5,000.00**, the truth |

Comment-only edits in round 3: the describe title and header ("rounds 2–3") and R2-2's comment (the round-3 note, the
PR9 fix direction and its constraint).

**Fails before, passes after (round 3).** The two hold-back files, with the round-3 tests in place:

| Source | Result |
|---|---|
| Round 2 ledger (`3d56068c`) | 2 failed, 35 passed. R3-1 failed with May's pair `tier: 3, offCurve: false`; R3-2 failed at its before-answer step, same pair |
| Round 3 ledger (`83c915d`) | 37 passed |

### The stated cost: one paycheck low, never high

**Why it happens.** The ledger cannot tell a nameless deposit that *is* the paycheck (R3-1) from one that isn't (R3-2):
the rows have the same shape. A nameless deposit pairs with a paycheck only within max($1, 1%) of it and within 3 days of
its date. When such a coincidence lands on an unpaid paycheck's date, and the real paycheck then arrives late inside the
next paycheck's window, the next paycheck leaves the curve early.

**Size.** The forecast reads one paycheck low (R3-2: 3,000.00 against 5,000.00) until the owner answers "Not this" on the
earlier suggestion. The answered read is exactly the truth, and no read is above it.

### The biweekly double count: pinned for PR9, not fixed

**Repro (R2-2).**

- A $2,000 paycheck every 14 days (04-17, 05-01, 05-15). 04-17's deposit is exact.
- 05-01's deposit is $1,900: named, $100 short.
- 05-15's $2,000 arrives a day early, on 05-14.
- R2-3 is the control: the same household with 05-01 exact.

**Dollar effect.** The forecast reads high by **$2,000**, one paycheck, from 05-15 to the end of the horizon: 05-15
reads 5,000.00, right answer 3,000.00. Any low point, max safe extra or ending balance read after 05-15 can read high by
up to $2,000. `incomeNotArrived` also wrongly lists the 05-01 paycheck.

**When it happens:** all three of these together:

- a paycheck every 14 days or less;
- the previous deposit is not tier-2 evidence (for example, more than max($1, 1%) off, with no income category of its
  own);
- the next deposit arrives before its due date.

**Exact mechanism, for PR9: `matchPlansToRows` in `lib/avalanche-core/src/planMatch.ts`.**

1. **Candidates.** Every plan × row combination inside the pairing window becomes a candidate with a `rank` and a
   `score`.
   - `rank` = 0 if the pair could be tier 1/2 (ignoring ambiguity), else 2, plus 1 for a manual row.
   - `score` = |amount gap in cents| + 100 × |days apart| − 5,000 when named.
2. **The greedy pass.** Candidates are sorted by rank, then score, and taken greedily when both the plan and the row
   are still free.
3. **The flag.** For each pair taken, `ambiguous` is true when any other candidate for the same plan or row has
   `rank ≤` this pair's rank and `score − this score ≤ max(100, 10% of |this score|)`. **A candidate that scored better
   always passes that test, even when its row was already taken by another plan earlier in the pass.**
4. **The fixture, by that formula:**

   | Candidate | Rank | Score | What happens |
   |---|---|---|---|
   | 05-15 plan ↔ 05-14 row | 0 | −4,900 | taken first |
   | 05-01 plan ↔ 05-14 row (13 days late, inside the +14 window) | 0 | −3,700 | skipped: its row is gone |
   | 05-01 plan ↔ $1,900 row ($100 short, not tier-2-capable) | 2 | 5,000 | taken |

   The skipped candidate has rank 0 ≤ 2 and scores better, so it marks the 05-01 pair `ambiguous: true`.
5. **What reads the flag.** The pair is ambiguous and tier 3, so `isEvidence` is false. 05-01 is therefore listed in
   `incomeNotArrived` and not received for the hold-back. 05-15's pair is held back, and +$2,000 stays on the curve while
   the deposit is already in cash.

**The fix PR9 should make.** In the matcher's ambiguity flag: a better-scoring candidate whose row (or plan) a
higher-ranked pair already took must not make a pair ambiguous.

**⚠️ The fix must not let any bill pair leave the curve.** `tierOf` returns a suggestion for an ambiguous pair, so
un-flagging a bill pair can make it tier 2. Tier 2 sets `offCurve` and takes the bill off the curve, which reads high.
PR9 must either limit the change to income pairs, or show with tests that no outflow pair's tier or `offCurve` changes.
R2-2 should then flip to 3,000.00; the round-4 guard (below) keeps checking the rule after it does.

**Why not fixed here.** The cause is in the shared matcher, and a hold-back-only patch would make the hold-back and the
arrival rule disagree. **Workaround today:** confirming the earlier paycheck in Review should clear it. That is the same
path D3 proves for bills; it is not separately tested for income.

---

## Round 4: the review's fixes (1 HIGH, 2 LOW)

The reviewer returned REQUEST CHANGES on `3d56068` and `319f8d9`. The reviewer's throwaway patch and probes guided the
fix; the change and the tests here are written for this branch. The fix was committed on main `9aad763` as `b70801c`.
Main then moved to `f96afb1` (PR-H) and was merged in as `18cf0f7` before the final gates.

### HIGH: a held-back row paid a different card's overdue minimum, reading high

**Mechanism.** The hold-back demotes a later pair to tier 3 but, before round 4, left its row out of `usedRows`. The
listing pass and the card-payment rule (`plansPaidInFullByName`) read only rows not in `usedRows`. So the card-payment
rule could spend a row that was being held for one card's earlier minimum on another card's overdue minimum. PR-B2 made
this reachable for every tier-3 earlier outflow pair. With a nameless earlier pair it already existed on main.

**Fix.** The hold-back records the transaction ids it demotes (`heldBackTxnIds`), and they join `usedRows` before the
listing pass and the card-payment rule run.

**Other reach of the fix.** A held-back row can no longer serve as listing evidence for an occurrence older than
today − 45 days. Such occurrences are never on the curve, so only which list they appear in can change, never a balance.

**Repro (R4-1 named, R4-2 nameless).**

- Today is 05-14; balance 1,000.00 read 05-01; buffer 0.
- "Capital One Platinum": minimum $300 due the 17th. "Capital One Quicksilver": minimum $40 due the 8th.
- A +$2,000 paycheck on the 16th.
- April's Platinum row: "CAPITAL ONE MOBILE PYMT" −280 on 04-25 (R4-1, named, tier 3), or "ACH DEBIT 7781" −300 on 04-18
  (R4-2, nameless, tier 3).
- The row both tests share: "CAPITAL ONE MOBILE PYMT" −300 on 05-12.

| Test | `2731077` (reviewer's measurement) | Round 3 `319f8d9` | Round 4 |
|---|---|---|---|
| **R4-1** named | 660.00 | **fails**: 05-15 came back **700.00**. The 05-12 row is held for Platinum's April and also paid Quicksilver's 05-08 minimum | 05-15 **660.00**; 05-17 2,360.00; low point and max safe extra 660.00; no `overdueAssumedPaid` entry uses the 05-12 row |
| **R4-2** nameless | 700.00 (the same bug, already on main) | **fails**: 05-15 came back **700.00** | 05-15 **660.00**; low point and max safe extra 660.00 |

Hand-worked figures (both forms):

- 05-14: bankToday 700.00 (the $300 on 05-12).
- 05-15: Quicksilver's $40 is 6 days overdue and unpaid, so it drags: 660.00.
- 05-16: +$2,000: 2,660.00.
- 05-17: Platinum's $300 is held back, so it stays on the curve: 2,360.00.

### LOW (round 3): an ambiguous tier-1 income pair no longer counted as received, reading high

**Reachable.** `routes/recurring.ts` accepts any owned `debtId` on an item of any kind, on create and on update.

**Mechanism.** Round 3 set income `isEvidence` to `!ambiguous`. A deposit tagged to the item's debt is tier 1 even when
a second tagged deposit makes the pair ambiguous: `tierOf` checks explicit evidence before ambiguity. Round 3 didn't
count that pair. April stayed "not arrived" and unpaid for the hold-back, so May's tagged deposit was held back and May's
$50 counted twice.

**Fix, one definition.** For income, `isEvidence = tier === 1 || !ambiguous`. It applies to the arrival rule and the
hold-back alike. A tier-1 outflow pair already ignored ambiguity.

**The one expected value outside the hold-back.** A tagged but ambiguous April deposit now leaves `incomeNotArrived`.
Main listed it, because main's `isEvidence` was the same `!ambiguous`. That list is not on the curve.

**Repro (R4-3).**

- "Sapphire Rewards" is +$50 monthly on the 15th, linked to a debt with a $0 minimum (so the debt adds no minimum plans).
- The Plaid checking rows tagged to that debt: +50 on 04-15, +50 on 04-16, +50 on 05-12.
- Balance 1,000.00 read 05-01; horizon 20 days.

| Test | `2731077` / `3d56068` (reviewer's measurement) | Round 3 `319f8d9` | Round 4 |
|---|---|---|---|
| **R4-3** tagged income | 1,050.00 | **fails**: 05-15 came back **1,100.00**; April listed in `incomeNotArrived`; May `tier: 3, offCurve: false` | 05-15 and ending **1,050.00**; April `tier: 1, ambiguous: true` and not listed; May `tier: 1, offCurve: true` |

### LOW: test gaps, the direct guard and the mutants

**Guard (R4-G, five tests).** For income, April is listed in `incomeNotArrived` exactly when May's early deposit is held
back. The guard checks this across five shapes of April's deposit:

| Shape of April's deposit | Arrived / May held back | On `319f8d9` | Round 4 |
|---|---|---|---|
| named, exact (tier 2) | arrived / not held back | passes | passes |
| named, $100 short (tier 3) | arrived / not held back | passes | passes |
| nameless, exact (tier 3, low) | arrived / not held back | passes | passes |
| two nameless exact deposits a day apart (ambiguous, tier 3) | not arrived / held back | passes | passes |
| two tagged deposits a day apart (tier 1, ambiguous) | arrived / not held back | **fails** (listed as not arrived) | passes |

The ambiguous shape is a real ambiguity (two equally plausible deposits), not the matcher quirk PR9 fixes. So it keeps
guarding the rule after PR9 flips the biweekly pin.

**Mutants.** Each mutant of the round-4 ledger (`b70801c`) was written from `git show HEAD:` and swapped in. It was run
against the two hold-back files (45 tests), then restored with `git checkout HEAD --` and verified clean.

| Mutant | Tests failing |
|---|---|
| **A:** the reviewer's `tier <= 2 \|\| isEvidence(m)` | **none.** It is equivalent on round 4; see below |
| **B:** the hold-back keeps round 3's income rule (`!ambiguous`) while arrival includes tier 1 | R4-3; guard: tagged shape |
| **C:** income always counted as received (the reviewer's R3-M7) | guard: ambiguous shape; also the PR9 pin |
| **D:** held-back rows not reserved | R4-1, R4-2 |
| **E:** `isEvidence` without the tier-1 clause | R4-3; guard: tagged shape |
| **The reviewer's R3-M6 file:** round 3's ledger with `tier <= 2 \|\| isEvidence(m)` | R4-3; guard: tagged shape (both non-pin tests); also R4-1 and R4-2, because round 3 has no reservation |

**Why mutant A cannot fail on round 4.** `tierOf` returns a suggestion for an ambiguous pair unless it is tier-1
explicit, so no raw pair is both tier 2 and ambiguous. With income `isEvidence` now `tier === 1 || !ambiguous`,
`tier <= 2 || isEvidence(m)` selects exactly the pairs `isEvidence(m)` selects, for income and outflows alike.

On round 3's `isEvidence` the mutant was not equivalent: it differed on ambiguous tier-1 income pairs. The new non-pin
tests (R4-3 and the guard's tagged shape) kill it there (last row). The reviewer's requirement holds where the mutant can
be told apart, and on round 4 the two rules share one definition by construction.

**Reviewer's own verification (not re-run here):** their combined patch never read higher than main or round 3 across
2,200 fuzzed households.

### Every expected value that changed in round 4

- **New tests only:** R4-1, R4-2, R4-3 and the five guard tests. No existing test's expected value changed.
- **The only behaviour change outside the hold-back:** a tagged, ambiguous income deposit no longer appears in
  `incomeNotArrived` (asserted in R4-3).

### Fails before, passes after (round 4)

The two hold-back files, with the round-4 tests in place:

| Source | Result |
|---|---|
| Round 3 ledger (`319f8d9`, unchanged in the tree, no file swap) | 4 failed, 41 passed. R4-1: 05-15 700.00, expected 660.00. R4-2: 700.00, expected 660.00. R4-3: 05-15 1,100.00, expected 1,050.00. Guard, tagged shape: not arrived, expected arrived |
| Round 4 ledger (`b70801c`) | 45 passed |

### Gates (round 4, merged tree)

**Tree.** Round 4 is committed as `b70801c` and merged with origin/main `f96afb1` (PR-H, the household money model) as
`18cf0f7`. There were no conflicts and no overlap: the merged tree differs from `f96afb1` only in this PR's five files.

**PR-H holds no copy of the rule.** None of its files (`householdMoney.ts`, `moneyContext.ts`, `amexCardCadence.ts`,
`spendingFacts.ts`, `budgetActuals.ts`) mentions `ambiguous`, `offCurve`, `isEvidence`, `usedRows`, `matchPlansToRows` or
`plansPaidInFullByName`. `householdMoney.ts` and `moneyContext.ts` don't read the ledger or the cash signal.

Every gate was run on the merge commit:

- `pnpm build` (runs `pnpm run typecheck` first): pass.
- **Web tests** (this PR changes no web file):
  - `TZ=UTC CI=true`: 141 files, 1,235 passed, 3 skipped.
  - `TZ=America/Chicago CI=true`: 141 files, 1,236 passed, 2 skipped.
- **Full API suite** (`CI=true`, own DB `h2budget_test_prb2`, `caffeinate -i`, serial): **151 files, 1,606 passed,
  7 todo.** That is 1,494 on round 4 before the merge (round 3's 1,486 plus the 8 round-4 tests), plus PR-H's 112 tests in
  6 new files.
- `node scripts/check-entry-graph.mjs`: OK, 575.7 KB of 580.0 KB.
- **Codegen:** not needed. No file under `lib/api-spec`, `lib/api-zod`, `lib/api-client-react` or `lib/db` differs from
  origin/main.
- **e2e:** not run (no UI change in this PR).
- **Golden and household scenario:** part of the full suite above, unchanged, not re-recorded.

**Before the merge** (`b70801c`, on `9aad763`): build and typecheck passed; web 1,235 / 1,236; API 145 files, 1,494
passed, 7 todo; entry graph 575.7 KB.

### Earlier rounds' gates (for the record)

| Round | Tree | Main merged in | API suite | Web (UTC / Chicago) | Entry graph |
|---|---|---|---|---|---|
| Round 3 | `7325a9e` | `9aad763` | 145 files, 1,486 passed, 7 todo | 1,235 / 1,236 | 575.7 KB |
| Round 2 | `c6d6166` | `b939039` | 145 files, 1,481 passed, 7 todo | 1,212 / 1,213 | 575.7 KB |
| Round 1 | `0b4015c` | `2e1949f` | 145 files, 1,477 passed, 7 todo | 1,148 / 1,149 | 574.4 KB |
| Round 1, pre-merge | `dea25f7` on `2731077` | none | 145 files, 1,476 passed, 7 todo | same as round 1 | 574.4 KB |

Build and typecheck passed at every round. Round 3 also ran codegen after merging PR-K's spec change: no drift.
