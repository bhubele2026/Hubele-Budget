# PR-B: match evidence tiers (owner decision 13)

- **Base:** `main` = `df2adda`.
- **Branch:** `feat/match-evidence-tiers`.
- **Scope:** what a plan↔row pair proves.
  - **Touched:** the matcher (`lib/avalanche-core/src/planMatch.ts`), the forecast ledger, `CashSignal.matches`
    (spec + codegen), and one web type.
  - **Not touched:** DDL, stored data, UI copy, and dependencies.

| Commit | What it does |
|---|---|
| `50a39b76` | Evidence tiers in the matcher and ledger, `tier` on `CashSignal.matches`, tests, golden re-record |
| docs commit | This note |

## Owner decision implemented

> "A different charge from the same company must not hide an unpaid bill. Merchant similarity alone is insufficient
> proof of payment. Use an explicit match, a reliable payment reference, or a tightly defined combination of account,
> amount, date, and obligation. Otherwise present a suggestion. Fix the HELOC specifically; don't weaken matching for
> every bill. Neither knowingly overstating nor understating cash is acceptable."

## What changed

**Pairing is unchanged.** Candidates, the one-to-one pass, `ambiguous` and `confidence` are the same. Each chosen pair
now also carries a `tier`:

| Tier | Rule (`tierOf` in `planMatch.ts`) |
|---|---|
| 1 explicit | A Plaid row on the checking account, tagged to the plan's debt, paying ≥ plan − max($1, 1%). Matched/partial resolutions never reach the matcher. **Hook:** `explicitEvidence()` is where a payment link and an Amex payoff event plug in (later PRs). |
| 2 obligation evidence | ALL of: not ambiguous; `onChecking`; −10…+14 days (the pairing window); plan − max($1, 1%) ≤ paid ≤ plan + max($25, 10%); AND ONE of **(a)** `category`: row category = plan category, and that category is on exactly one active expense bill (this one); **(b)** `full_name`: the plan's full name, and no other active item of the same direction has its full name in the row; **(c)** `name_exact`: some of the name, within max($1, 1%) and ≤ 5 days. |
| 3 suggestion | Everything else, including a row tagged to another debt. |

**Ledger (`forecastLedger.ts`):**

- **Inputs:** plans carry `categoryId` and `debtId`. Rows carry `categoryId` and `onChecking`, which means
  `plaidAccountId` equals the configured checking account.
- **Active items:** `matchItems` lists every active recurring item plus each expanded debt minimum and the Avalanche
  extra. Tier 2 judges "only bill in the category" and "no other full name" against this list.
- **Future plans:** `offCurve` = `tier ≤ 2`. The PR5 earlier-unpaid rule still holds a later occurrence back, and a
  pair it holds back drops to tier 3.
- **Overdue expenses:** paid only on a tier-1/2 pair, or on PR7's `plansPaidInFullByName`, which is unchanged. Its
  `debt_tag` is tier 1 and its `card_payment` is the tier-2 "payment reference". A tier-3 pair drags and stays in
  `matches` as a suggestion.
- **Tag conflicts** moved from the ledger into the matcher. Such pairs are tier 3, with identical behavior.
- **Income** keeps PR6's rule for `incomeNotArrived`: a non-ambiguous deposit arrived.

**API:** `CashSignal.matches[].tier` is 1, 2 or 3 and required. `confidence`, `ambiguous` and `offCurve` are kept.

**Web:**

- `forecastMatch.ts` passes `tier` through, defaulting to 3. The UI is unchanged.
- An unconfirmed tier-2 pair still shows "Suggested" / "Out of forecast" with Confirm / Not this.
- A tier-3 pair shows "Still in forecast" and keeps Move / Mark missed.
- A new test pins both.

## Figures that move (measured; before = `df2adda`)

| Case (test) | Before | After |
|---|---|---|
| R1 rent $1,500 by nameless Zelle | max safe extra 2,500 | **1,000**: −1,500 drags onto 05-06; April listed |
| R2 rent by check, 2 days late | 2,500 | **1,000** |
| R3 mortgage "LOAN PMT" + HELOC "FIGURE LENDING", **no category** | low 6,000 / 5,500 | **2,784.21 / 2,284.21** |
| R5 Avalanche extra $500, "ONLINE PAYMENT THANK YOU" | 2,500 | **2,000**. The Sapphire minimum stays paid (tier 2 c) |
| R7 whole household, nameless rows | low 6,500 / 6,000 | **3,408.43 / 2,908.43**. Card minimums stay paid |
| $150 water, named row −120 (`OverdueEvidence`) | 05-06 2,970, −30 remainder drags | **2,850**, −150 drags (outside band) |
| Water $60 onetime, nameless −60 (`cashSignalOverdue`) | 05-15 1,000, listed as paid | **940**, drags, tier-3 suggestion |
| Overdue "Verizon Fios" $120 (Utilities on 3 bills), "VERIZON WIRELESS" −98 | 05-06 2,978 (−22 remainder), max 2,478 | **2,880**, −120 drags, max **2,380** |
| Overdue HELOC, category on a 2nd active bill | 05-06 6,000, max 5,500 | **4,870**, max **4,370** |
| Overdue HELOC, category on this bill only | 6,000 / 5,500, paid | unchanged, now **tier 2**, `difference` +55.19 |
| **Future** HELOC 05-10 paid 05-04 −1,185.19, unique category | 05-10 **4,870** (stayed on curve: understated $1,130) | **6,000** (tier 2, off the curve) |
| $150 plan paid $173, full name unique (Codex acceptance) | −173 once, +23 | **unchanged**, tier 2 |

The tables in `cashSignalOverdueEvidence` (R1–R7 header) record every column.

### Golden (`forecastLedger.golden.integration.test.ts`): 6 of 11 entries changed, same edit in each

- **Entries:** the five "full household" entries and "PR4b snapshot rule".
- **The pair:** the Golden Card minimum ($38, due 04-25) paired with the row "golden 2026-05-09 -20". In PR4b the row
  is "golden 2026-05-08 -35".
- **Why it's tier 3:** "golden" is the card's full name, but the row pays $18 (PR4b: $3) under the plan, outside plan
  − max($1, 1%). Before, a non-ambiguous pair paid it, with an $18 (PR4b: $3) remainder listed.
- **Diff per entry:**
  - `matches[0].tier: 3` is added.
  - The `overdueAssumedPaid` entry is removed.
  - The same plan is added to `overdueOutsideForecast`. It is 19 days overdue, past the 14-day drag floor.
- **Balances unchanged:** no daily balance, `lowestProjected`, `maxSafeExtra`, `endingBalance` or projected total
  changed. The remainder never dragged, since 04-25 is before the floor. The other 5 entries have no pairs.

## Must not change (verified)

- `bankToday` and the cash-row rule.
- Resolutions: matched / partial / skipped / missed / rescheduled.
- `plansPaidInFullByName`'s card-payment and debt-tag rules. These tests pass unchanged: R4, E6, C5, the review M1/M2
  debt-tag cases, and PR6 HIGH 2 / MEDIUM 1 / MEDIUM 2.
- The one-to-one pairing, and `confidence` / `ambiguous` values.
- Income listing.
- UI copy.
- The spine and other endpoints: the full API suite passes, including `spineParity`.
- Landing JS: 574.4 KB (cap 580).

## Verification

- `pnpm run typecheck`: pass. This includes e2e.
- **Web tests** (135 files):
  - `TZ=UTC CI=true`: 1113 passed, 3 skipped.
  - `TZ=America/Chicago`: 1114 passed, 2 skipped.
- **Full API suite** (`CI=true`, own DB, caffeinate): 138 files, **1321 passed**, 7 todo. The base was 1302 passed.
- `pnpm run build && node scripts/check-entry-graph.mjs`: OK, 574.4 KB.
- **Codegen:** rerun, no diff. The generated `src` and `dist` are committed, including the new
  `cashSignalMatchesItemTier`.
- **Golden:** re-recorded without `CI`, then verified with `CI=true`.
- **Fails before** (`df2adda` source, the new tests):
  - **API:** 47 of 123 failed, including the 6 golden snapshots. That covers every new tier unit test, every new
    ledger acceptance test, and each rewritten assertion. The older `planMatch` unit tests also fail there, but only
    because the helper passes `items` in the base signature's `notMatch` slot. That is a harness reason, not a behavior
    change.
  - **Web:** 1 of 50 failed (the register passes `tier`). The new UI test passes on base by design: the UI ignores
    `tier`.

## Residuals and reviewer call-outs

1. **PR7 card-payment rule kept as the tier-2 "payment reference".** It asks neither `onChecking` nor an upper amount
   bound. A manual row matching PR7's phrases could still pay an overdue minimum.
2. **Tier 1 ignores ambiguity.** A checking row tagged to the plan's debt now takes a **future** minimum off the curve
   without a name. Before, it needed the name rule.
3. **`offCurve` on an overdue plan is now `tier ≤ 2` even when the earlier-unpaid rule applies.** Before, that rule set
   the flag false while evidence already took the plan off the curve. The curve is unchanged; only the flag now agrees
   with it.
4. **Only Plaid checking rows are evidence.** A household whose checking rows are manual or imported never gets tier
   1/2, so its bills drag (errs low).
5. **(c) still accepts part of a name paid exactly within 5 days.** For example, "Verizon Fios" $120 is paid by
   "VERIZON WIRELESS" −120 two days later. This is per the rule as given.
6. **"Expense bill" means `kind !== "income"`.** The repo stores both "bill" and "expense". Rule (a) is not applied to
   income.
7. **Nameless Avalanche extra / Amex payments now drag** until the payment-link / Amex-payoff tier-1 PRs land.
8. **Production HELOC not checked** (no prod access). It is tier 2 only if "HELOC (Figure)" is on exactly one active
   expense bill and the FIGURE LENDING row carries it. A second active bill in that category drops it to tier 3.

## Open money questions (not guessed)

- **Q1.** Should PR7's card-payment rule also require a Plaid checking row, and an upper bound?
- **Q2.** Tiers also gate **future income**. A paycheck deposited early stays on the curve unless tier ≤ 2, which
  overstates cash. That was already true for nameless deposits. It is new for a manual row or a non-unique full name.
  Keep, or give income its own rule?
