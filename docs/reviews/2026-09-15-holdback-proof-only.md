# PR-B2: the hold-back needs proof (owner decision, 2026-09-15)

Branch `fix/holdback-proof-only`, cut from main `2731077`. It merges main `2e1949f` (round 1), `b939039` (round 2) and
`9aad763` (round 3). One money rule changes: the forecast's hold-back. There is no UI, API spec, schema or codegen change
in this PR. All figures are synthetic test fixtures.

**Status after round 3:**

- **Outflows** (bills, debt minimums, the Avalanche extra) need tier-1/2 proof for the hold-back.
- **Income** uses the arrival rule itself. An earlier paycheck counts as received for the hold-back exactly when it counts
  as arrived (`isEvidence`: its pair is not ambiguous, named or not). The two share one definition, so they cannot
  disagree.
- **Round 2's nameless-paycheck known issue** is fixed in round 3.
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

- For a bill, holding a row back keeps the bill on the curve, which can only read low.
- For income, holding a row back would keep a paycheck on the curve while its deposit is already in cash, which reads
  high. So income counts an earlier paycheck as received whenever it counts as arrived (rounds 2 and 3).

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
> - **Income** (`planAmount > 0`): the pair is not ambiguous, named or not. That is PR6's arrival rule, the same test
>   that keeps a paycheck out of `incomeNotArrived`.

An answered occurrence (matched, partial, missed, skipped) never enters the matcher, so it never holds anything back.

Unchanged: where the hold-back applies (a later plan due after the drag cutoff, or a weekly-cadence expense), the windows
(only earlier occurrences dated today − 45 days or later can hold anything back), the tiers themselves, overdue evidence,
the income-arrival rule, the card-payment rule, and both remainder drags.

## Every copy of the rule

| File | What it holds | Changed? |
|---|---|---|
| `artifacts/api-server/src/lib/forecastLedger.ts`, the hold-back (~line 930) | **The only executable copy.** On main the `pairedKeys` filter was: `tier ≤ 2`, OR (not ambiguous AND confidence ≠ "low" AND the row not tagged to another debt), for every plan. Now it is `matches.filter(isEvidence)`. `isEvidence` (income: `!m.ambiguous`; outflow: `tier ≤ 2`) moved up from below the hold-back, so overdue evidence, `incomeNotArrived` and the hold-back use one definition. The comments that describe the rule (~line 756 and ~line 930) are rewritten. | **Yes** |
| `lib/avalanche-core/src/planMatch.ts` | It grades pairs (`tier`, `confidence`, `ambiguous`, `offCurve`) and holds no earlier-occurrence logic. `matchPlansToRows` has one caller, the ledger. | No: nothing to change (PR9's biweekly fix belongs here) |
| `artifacts/h2budget/src/lib/forecastMatch.ts` | `buildLineRegister` copies the server's `matches` into `probablyPaid` (`tier`, `offCurve`, `remainderAmount`) and reads `offCurve` for the no-bank running balance. It has no hold-back of its own. | No |
| `artifacts/h2budget/src/lib/forecastReconcile.ts` | `computeBankReconcile` reads `offCurve` and `remainderAmount`. It has no hold-back of its own. | No |

**No debt-tag check.** The arrival rule has none: for income, `paidByKey` is built only from `isEvidence` pairs, and the
card-payment rule covers debt minimums only. A tier ≤ 2 pair is never on a row tagged to another debt (`tierOf`), so the
outflow side needs none either.

**Parity.** The ledger demotes a held-back pair before it leaves the server (`tier: 3`, `evidence: null`,
`offCurve: false`). Both web files only read that result, so server and web cannot disagree.

**Search.** I also searched the whole repo for `confidence === "low"`, `confidence !== "low"` and `ambiguous ||`. The
only other hit is `scripts/src/detectSubscriptions.ts`, which detects subscriptions and is unrelated.
`lib/api-spec/openapi.yaml` has no hold-back wording. Its "any confidence, not ambiguous" line is the income-arrival rule,
which this PR now shares.

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

Neither fixture has a tier-3 earlier pair whose treatment changed:

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
  `remainder_assumed_unpaid` either.

### Round 1's OPEN finding: income read HIGH (resolved in rounds 2–3)

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

### What round 2 built (the income condition is superseded by round 3)

- **Outflows:** round 1's rule.
- **Income:** round 2 used main's named condition (tier ≤ 2, or confidence ≠ "low" and not ambiguous, plus main's
  debt-tag check). Round 3 replaced it with the arrival rule itself.
- **Recovery before the commit.** During round 2, a local probe command overwrote `forecastLedger.ts` with `2731077`'s
  version. A zsh glob matched nothing and aborted the backup step, but the file swap still ran. Nothing had been
  committed. I restored the file from `24b9d0fe`, re-applied the round-2 edits, and checked `git diff` against HEAD
  (round-2 change only). The two hold-back files were re-run before the commit and before the gates.

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
const isEvidence = (m: PlanRowMatch): boolean => (m.planAmount > 0 ? !m.ambiguous : m.tier <= 2); // moved up
const pairedKeys = new Set(matches.filter(isEvidence).map((m) => m.planKey));
```

- **Income:** `!m.ambiguous`, character for character the arrival rule, because it is the same function.
- **Outflows:** `tier ≤ 2`, unchanged.
- **Removed:** round 2's named condition, and its debt-tag check with the `rowDebtById` map. The arrival rule has no tag
  check, and the two must match exactly.
- **Nothing else moves:** `isEvidence` itself is unchanged, and its other readers (used rows, listing pairs, due debt
  minimums, `paidByKey`) run after the hold-back exactly as before.

### Every test whose expected value changed in round 3

| Test | Round 2 (`3d56068c`) | Round 3 |
|---|---|---|
| **R3-1** (was R2-4): April's $2,000 exact but nameless ("DIRECT DEP 7781"), May's a day early by name | KNOWN ISSUE pin: May `tier: 3, offCurve: false`; 05-15 **5,000.00** | a normal passing test: May `tier: 2, offCurve: true`; 05-15 **3,000.00**. April's pair is still `confidence: "low"`, not ambiguous, tier 3; April is absent from `incomeNotArrived` |
| **R3-2** (new, the cost): a nameless $2,000 "MOBILE CHECK DEP 0415" on April's date; April's real paycheck arrives late on 05-14 | not present (on `3d56068c` it reads May `tier: 3`, 05-15 5,000.00) | before an answer: May `tier: 2, offCurve: true`, 05-15 **3,000.00**, where the truth is 5,000.00 (one paycheck low). After "Not this" on April's pair: April has no pair, May is `tier: 3, offCurve: false`, 05-15 **5,000.00**, the truth |

Comment-only edits in round 3: the describe title and header ("rounds 2–3") and R2-2's comment (the round-3 note, the
PR9 fix direction and its constraint).

Unchanged in round 3, re-run on the final tree:

- R2-1 (3,000.00), R2-2 (pinned at 5,000.00), R2-3 (3,000.00).
- (a) (700.00), (c) (850.00).
- D2 (8,528.00 / 8,028.00, ending 15,955.20), D3 (15,955.20 → 16,628.00).
- The HOME DEPOT cases (700.00 / 2,850.00).
- The golden and household-scenario files.

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
5. **What reads the flag.** Ambiguous means `isEvidence` is false. So 05-01 is listed in `incomeNotArrived`, it is not
   received for the hold-back, and 05-15's pair is held back: +$2,000 stays on the curve while the deposit is already in
   cash.

**The fix PR9 should make.** In the matcher's ambiguity flag: a better-scoring candidate whose row (or plan) a
higher-ranked pair already took must not make a pair ambiguous.

**⚠️ The fix must not let any bill pair leave the curve.** `tierOf` returns a suggestion for an ambiguous pair, so
un-flagging a bill pair can make it tier 2. Tier 2 sets `offCurve` and takes the bill off the curve, which reads high.
PR9 must either limit the change to income pairs, or show with tests that no outflow pair's tier or `offCurve` changes.
R2-2 should then flip to 3,000.00.

**Why not fixed here.** The cause is in the shared matcher, and a hold-back-only patch would make the hold-back and the
arrival rule disagree. **Workaround today:** confirming the earlier paycheck in Review should clear it. That is the same
path D3 proves for bills; it is not separately tested for income.

### Gates (round 3, merged tree)

**Tree.** Round 3 is committed as `83c915d` and merged with origin/main `9aad763` as `7325a9e`. main `9aad763` is PR-K:
the Cash flow card uses the cash signal, and `CashSignal.account` is added, with its spec and codegen.

- PR-K touches `forecastLedger.ts` only at the import, the `ForecastLedger` type and the return. That is away from the
  hold-back.
- The merge had no conflicts. The merged tree differs from `9aad763` only in this PR's five files.

Every gate was run on the merge commit:

- `pnpm --filter @workspace/api-spec run codegen`: no drift (the tree was clean afterwards). This PR touches no spec
  file.
- `pnpm build` (runs `pnpm run typecheck` first): pass. The tree was clean afterwards.
- **Web tests** (the counts include R0's and PR-K's tests; this PR adds no web code):
  - `TZ=UTC CI=true`: 141 files, 1,235 passed, 3 skipped.
  - `TZ=America/Chicago CI=true`: 141 files, 1,236 passed, 2 skipped.
- **Full API suite** (`CI=true`, own DB `h2budget_test_prb2`, `caffeinate -i`, serial): **145 files, 1,486 passed,
  7 todo.**
  - That is `9aad763`'s 1,479 (PR-K added 4) plus this branch's net 7 tests.
  - This branch added 9 `it(` blocks: (a), (c), the new D2, D3, R2-1, R2-2, R2-3, R3-1 and R3-2.
  - It removed 2: round 4's residual pin and the old D2.
- `node scripts/check-entry-graph.mjs`: OK, 575.7 KB of 580.0 KB. This PR changes no web file.
- **e2e:** not run (no UI change in this PR).

### Earlier rounds' gates (for the record)

| Round | Merge commit | Main merged in | API suite | Web (UTC / Chicago) | Entry graph |
|---|---|---|---|---|---|
| Round 2 | `c6d6166` | `b939039` | 145 files, 1,481 passed, 7 todo | 1,212 / 1,213 | 575.7 KB |
| Round 1 | `0b4015c` | `2e1949f` | 145 files, 1,477 passed, 7 todo | 1,148 / 1,149 | 574.4 KB |
| Round 1, pre-merge | `dea25f7` on `2731077` | none | 145 files, 1,476 passed, 7 todo | same as round 1 | 574.4 KB |

Build and typecheck passed at every round.
