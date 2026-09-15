# PR-B: match evidence tiers (owner decision 13)

- **Base:** `main` = `df2adda`.
- **Branch:** `feat/match-evidence-tiers`.
- **Scope:** what a plan↔row pair proves.
  - **Touched:** the matcher (`lib/avalanche-core/src/planMatch.ts`), the forecast ledger, `CashSignal.matches`
    (spec + codegen), and one optional web field.
  - **Not touched:** DDL, stored data, UI copy, and dependencies.

| Commit | What it does |
|---|---|
| `50a39b76` | Evidence tiers in the matcher and ledger, `tier` on `CashSignal.matches` (first head) |
| `cfe7b955` | First review note |
| `46262e80` | PR-B review (REQUEST CHANGES) fixes 1–8: never knowingly understate cash either |
| docs commit | This note, rewritten |

## Owner decision implemented

> "A different charge from the same company must not hide an unpaid bill. Merchant similarity alone is insufficient
> proof of payment. Use an explicit match, a reliable payment reference, or a tightly defined combination of account,
> amount, date, and obligation. Otherwise present a suggestion. Fix the HELOC specifically; don't weaken matching for
> every bill. Neither knowingly overstating nor understating cash is acceptable."

The first head fixed the overstatement half. The review measured the other half on a seed-shaped household. Examples:
MGE was understated $241 every month, a Toyota paid 6 days late $672.80, and a Verizon paid $5 short $430. This head
fixes that.

⚠️ **Lead's reading, for the owner to see (fix 6):** "amount differences remain visible." On strong evidence (the bill's
own category, or a confirmed descriptor), a payment up to max($25, 10%) short still pays an overdue bill, and only the
remainder drags. Before its due date it stays on the curve with the difference shown.

## The rule now (`tierOf` in `planMatch.ts`)

**Pairing.** Pairs form as before, with two changes:
- **(fix 7)** A pair that would be tier 1/2 is taken before one that would not. A runner-up makes a pair ambiguous only
  when it has the same or a better rank.
- **(fix 2, my addition)** A description the user confirmed for the item counts as the payee's name for *pairing*. Without
  it, a nameless descriptor like "MADISON GAS EL" pairs only exact within 3 days. `confidence` still reads only the label
  name.

**Tier 1 (explicit).** A checking-cash row tagged to the plan's debt, paying ≥ plan − max($1, 1%). **Hook:**
`explicitEvidence()` is where payment links and Amex payoffs plug in (later PRs).

**Tier 2 (obligation evidence).** ALL of:
- not ambiguous;
- `onChecking` (fix 4): the row counts as checking cash under `classifyCashRows`, Plaid or manual/imported, **except a
  manual row carrying a debt tag** (a logged Avalanche payment; PR-F pairs those);
- within −10…+14 days;
- paying ≤ plan + max($25, 10%);
- AND one of:

| Evidence | Condition | Lowest amount it accepts |
|---|---|---|
| (a) `category` | row category = plan category, and no other active item **of the same direction** carries it (fix 5: income too). A one-time item counts only within ±31 days of the plan (fix 8). | plan − max($25, 10%) (fix 6) |
| (d) `confirmed_descriptor` (fix 2) | the row fuzzy-equals (`descriptionsFuzzyEqual`, non-empty) a row the user confirmed `matched`/`partial` for this item, the last 12 by occurrence date | plan − max($25, 10%) (fix 6) |
| (b) `full_name` | the plan's full name, no other same-direction item's full name in the row | plan − max($1, 1%) |
| (c) `name_exact` | some of the name, within max($1, 1%), ≤ 5 days | plan − max($1, 1%) |
| (c′) `name_exact_unique` (fix 1) | some of the name, within max($1, 1%), anywhere in the window, no other same-direction item shares a name word with the row | plan − max($1, 1%) |

**Tier 3.** Everything else, including a row tagged to another debt.

**`offCurve`** is `tier ≤ 2` AND the row pays at least plan − max($1, 1%). A strong-evidence underpayment stays on the
curve before its due date.

**Ledger** (`forecastLedger.ts`):
- **Confirmed descriptors** come from the existing resolved-row query (a `description` column added, no extra query),
  capped at 12 per item.
- **Hold-back (fix 3):** an earlier occurrence is not unpaid when it has a non-ambiguous pair of its own of ANY tier (not a
  pair whose row is tagged to another debt). Pairing is one to one, so that row is a different row.
- **Overdue expenses:** paid on tier 1/2 (the remainder over $1 drags), or by PR7's `plansPaidInFullByName`.
  - Its `card_payment` rule now needs a Plaid checking row (fix 4 / question 1). No upper bound was added.
  - A tier-1 tag pair reports `confidence: "debt_tag"`, as that rule's tag does.
- **Tier-3 overdue pairs drag,** and the pair stays in `matches`.
- **Income:** `incomeNotArrived` keeps PR6's non-ambiguous rule.

**Web:**
- `ProbablyPaid.tier` is **optional** (a missing tier reads as 3).
- **PR-C merge:** its `needsReview` object (`forecastMatch.ts:427`) and `needsReviewStrip.test.tsx:20` typecheck without
  supplying `tier`.
- `CashSignalMatchesItem.tier` stays required in the API. Only code that builds a `CashSignalMatchesItem` literal needs
  `tier: 3`.
- UI unchanged.

## Figures that move

### Seed-shaped household (`cashSignalSeedHouseholdTiers.integration.test.ts`), measured

The household:
- **Items:** the `budgetSeed.ts` items with their seed categories: Utilities ×3, Insurance ×3, Misc/Buffer ×3, Car Payments
  ×2, and unique HELOC / Mortgage / Home Maintenance / paycheck categories.
- **Rows:** real descriptors ("MADISON GAS EL", "CITY OF MADISON", "TOYOTA MOTOR CREDIT", "KFI STAFFING PAYROLL", …).
- **Amounts changed from the seed:** Verizon $430 and State Farm Insurance $180, so the reviewer's 425 and renewal cases
  exist.
- **Setup:** balance 10,000.00, buffer 500, short horizons. New-head figures are hand-worked in the test.

Figures are lowest / max safe extra (ending balance where shown).

| Case | Base `df2adda` | First head `cfe7b955` | New head |
|---|---|---|---|
| A0 08-21 all on time, MGE never confirmed | 9,048.98 / 8,548.98 | 8,807.98 / 8,307.98 | **8,807.98 / 8,307.98** (MGE tier 3 until confirmed) |
| A 08-21 all on time, July MGE confirmed | 9,048.98 / 8,548.98 | 8,807.98 / 8,307.98 | **9,048.98 / 8,548.98** (fix 2) |
| B 08-21 Toyota +6, TruStage +5, Mortgage +3, Verizon +2 | 9,048.98 / 8,548.98 | 8,135.18 / 7,635.18 | **9,048.98 / 8,548.98** (fixes 1, 2) |
| C 08-21 Verizon 425.00 on 430, July confirmed | 9,043.98 / 8,543.98 | 8,377.98 / 7,877.98 | **9,043.98 / 8,543.98** (fix 6: $5 remainder) |
| D 08-05 July Toyota +6, State Farm renewed 165 on 180, Water exact | 8,693.00 / 8,193.00; 08-07 16,793.00 | 8,426.98 / 7,926.98; 08-07 15,854.18 | **8,693.00 / 8,193.00; 08-07 16,793.00** (fixes 1, 2, 6) |
| D2 = D with July Toyota paid 685.00 (tier 3) | 8,693.00 / 8,193.00; 08-07 16,793.00 | 8,426.98 / 7,926.98; 08-07 15,854.18 | **8,693.00 / 8,193.00; 08-07 16,793.00** (fix 3) |
| E 08-10 State Farm ×2 +6 (July confirmed), HELOC +6, UW +4 | 9,359.55 / 8,859.55 | 9,058.01 / 8,558.01 | **9,359.55 / 8,859.55** (fix 2) |
| F1 08-20 Brad $8,100 KFI a day early (ending / lowest / max) | 17,900.00 / 10,000.00 / 9,500.00 | 17,659.00 / 10,000.00 / 9,500.00 | **9,800.00 / 9,800.00 / 9,300.00** (fix 5; base and first head counted it twice) |
| F2 08-27 Hannah $4,499.99 a day early on a manual row | 9,800.00 / 9,800.00 / 9,300.00 | 13,957.97 / 10,000.00 / 9,500.00 | **9,800.00 / 9,800.00 / 9,300.00** (fix 4) |

In D and D2, the first head's hold-back left August's Toyota on the curve on 08-07, where Brad's paycheck also lands. So
it shows in the 08-07 balance, not in the lowest.

### Other figures

**Unchanged from the first head** (they still pass as written):
- R1–R7.
- The partial-payment pair.
- The overdue low pair.
- The HELOC / Verizon / Zelle acceptance tests.

**Changed:**

| Test | First head | New head |
|---|---|---|
| (PR5 second review, now fix 3) April "paid" by nameless HOME DEPOT, May exact full name | 05-20 700.00 (May held back) | **850.00**, May off the curve |
| Debt tag: Freedom-tagged row (both debt-tag tests) | figures unchanged; row paired Sapphire as a suggestion | figures unchanged; row pairs **Freedom** (tier 1, fix 7), Sapphire no pair |

**Fixtures adjusted for fix 8:**
- The shared-HELOC and Verizon Fios siblings were one-time bills dated 12-01, which no longer count. They are now dated
  03-31 or 04-10: within 31 days, and invisible to the curve.
- The HELOC unique-category test gains a 12-01 one-time bill in the category and stays tier 2.

**Probably-paid fixture:** the logged-Avalanche row now carries its debt tag (as `POST /debts/:id/payments` writes it),
and that file's cleanup deletes debts.

### Golden: 6 of 11 entries changed (the same edit in each), versus `df2adda`

- **Entries:** the five "full household" entries and "PR4b snapshot rule". The pair is the Golden Card minimum ($38, due
  04-25).
- **Base:** paired with "golden 2026-05-09 -20" (PR4b: "…-35"), paid, remainder −18.00 (−3.00) listed.
- **First head:** the same pair, tier 3. The minimum moved to `overdueOutsideForecast`.
- **New head:** pairs with "golden 2026-05-08 -60" (dayDelta 13).
  - It carries the card's full name and pays +22.00, within +max($25, 10%), so it's tier 2 (b). Fix 7 takes it before the
    better-scored but tier-3 −20 row.
  - The minimum is in `overdueAssumedPaid` with remainder 0.00, and gone from `overdueOutsideForecast`.
- **Balances unchanged:** no daily balance, low, `maxSafeExtra`, ending or projected total changes in any entry. The plan
  is 19 days overdue, past the drag floor. The other 5 entries have no pairs.
- ⚠️ Every golden row's description contains "golden", so every row "names" the card. That's a fixture artifact.

## Must not change (verified)

- `bankToday` and the cash-row rule.
- Resolutions.
- PR7's debt-tag rule. The card-payment rule changes only by requiring a Plaid row.
- R1–R7, E6, C5, the review M1/M2 figures, and PR6 HIGH 2 / MEDIUM 1 / MEDIUM 2.
- Income listing.
- UI copy.
- The spine (`spineParity` passes).
- Landing JS: 574.4 KB of 580.

## Verification (new head `46262e80` + this note)

- `pnpm run typecheck`: pass. This includes e2e.
- **Web tests** (135 files):
  - `TZ=UTC CI=true`: 1113 passed, 3 skipped.
  - `TZ=America/Chicago`: 1114 passed, 2 skipped.
- **Full API suite** (`CI=true`, own DB, caffeinate): **139 files, 1337 passed**, 7 todo. The first head had 1321, the
  base 1302.
- `pnpm run build && node scripts/check-entry-graph.mjs`: OK, 574.4 KB.
- **Codegen:** rerun, no diff. The spec description changed; the generated `src` and `dist` are committed.
- **Golden:** re-recorded without `CI`, verified with `CI=true`.
- **Fails before** (the new test set, 124 tests: seed fixture, `planMatch` unit, overdue-evidence, probably-paid, golden):
  - **On `cfe7b955`:** 25 failed, including 6 snapshots.
    - Seed cases A, B, C, D, D2, E, F1 and F2 (A0 passes: MGE drags unconfirmed on both heads).
    - Unit tests: fixes 1, 2, 5, 7 and 8, the widened band, and the Plaid-only card payment.
    - The fix-3 HOME DEPOT test, the HELOC fix-8 ledger test, and both fix-7 debt-tag tests.
  - **On `df2adda`:** 65 failed.
  - **Web:** no web test changed this round.

## Residuals and reviewer call-outs

1. **Rule (c′) can still pay an unpaid bill with an unplanned charge.** An exact-amount charge carrying the bill's name
   within the window pays it, when no other item shares the name. The reviewer measured +$120 (a Verizon Fios charge) and
   +$128.59 (a State Farm draft). The ≤ 5-day rule (c) already had this for different same-payee charges.
2. **Fix 3 reverses the PR5 second review's guard.** A nameless earlier pair (HOME DEPOT for April's water) now counts as
   April paid for the hold-back. If April was in fact unpaid, the forecast reads high by that bill until April's
   suggestion is answered.
3. **Confirmed descriptors are a token-subset match.** A short confirmed description ("ZELLE") would name every Zelle row
   for that item. The two State Farm policies share one descriptor, so close amounts can make them ambiguous (tier 3).
   Using the descriptor as the payee's name for pairing is my addition to fix 2.
4. **Manual checking rows are now evidence.** A mistaken manual or imported row can pay a bill. A manual row with a debt tag
   is excluded.
5. ~~**An underpaid future bill with strong evidence stays on the curve.** Until the user records Partial, it understates by
   the paid part. This is the lead's asymmetric rule.~~ **CLOSED, round 4 (decided candidate C):** the remainder-only
   drag (previously overdue-only) now also applies before the due date — the plan leaves the curve, only the unpaid
   remainder drags, on the plan's own date. See "Round 4" below.
6. **The confirmed-descriptor read rides the existing resolved-row query.** That query loads every resolved row (unbounded,
   as before); only 12 per item are used.
7. **Moves between past-due lists have no reader today.** For example, the Golden Card minimum moving from
   `overdueOutsideForecast` to `overdueAssumedPaid`.
8. **Tier 1 ignores ambiguity.** A tagged row takes a future minimum off the curve without a name.
9. **Nameless Avalanche / Amex payments still drag** until the payment-link and Amex-payoff PRs.
10. **No production data checked** (no prod access).

## Questions

- **Q1 (answered by the lead):** the card-payment rule requires a Plaid checking row, with no upper bound. Done.
- **Q2 (answered by the lead):** income uses rule (a) when the category is unique among income items. Done.
- **Q3:** Fix 3 reverses a prior reviewer's guard (residual 2). Confirm, for the owner.
- **Q4:** Should a confirmed descriptor name the payee for pairing (residual 3)? Without it, fix 6 never reaches a nameless
  descriptor, and a nameless bill paid more than 3 days off its date never pairs.

## Round 3

The second review of round 2 measured OVERSTATEMENT again — round 2's own fixes for understatement (fix 3's "any tier"
hold-back, fix 2/6's confirmed descriptor as STRONG evidence) each reopened a way to count an unpaid bill paid. All four
findings are fixed below, plus the one LOW item (a display bug, not a money bug).

### HIGH — hold-back: "any tier" was too permissive

**Bug.** Round 2's hold-back let an earlier occurrence's pair of ANY tier — including a nameless, low-confidence
coincidence — count as "paid", freeing the later occurrence's row to take a DIFFERENT bill fully off the curve. Case:
April water $150 unpaid; an unrelated nameless "HOME DEPOT" −150 on 04-21; "CITY WATER" −150 on 05-12 (April, paid late);
today 05-14; May due 05-20.

**Fix.** An earlier occurrence counts as paid for the hold-back only if its own pair is tier ≤ 2, OR named AND not
ambiguous (`confidence !== "low"`) — restoring the PR5 second review's nameless guard, but keeping fix 3's real gain (a
*named* late pair, e.g. July's Toyota, still frees August's exact payment). `forecastLedger.ts`'s `pairedKeys` filter now
reads `if (m.ambiguous || m.confidence === "low") return false;`.

| Case | Round 1 (base) | Round 2 (bug) | Round 3 |
|---|---|---|---|
| HOME DEPOT / CITY WATER, balance 1,000 | 700.00 | **850.00** | **700.00** |
| The review's own repro, balance 3,150 | — (new case) | **3,000.00** | **2,850.00** |

Tests: `cashSignalProbablyPaid.integration.test.ts` — the existing HOME DEPOT case reverted to 700.00 (its title and
comment now explain the revert instead of celebrating the since-disproven fix); a new case at the review's own balance
(3,150 → bankToday 3,000 → May still due 2,850).

### MEDIUM 1 — confirmed descriptor as STRONG evidence hid unpaid bills

**Bug.** Round 2 treated a confirmed descriptor as STRONG evidence (able to underpay down to plan − max($25, 10%), the
same band as the bill's own category). A *different* charge from the confirmed company, at a *different* amount, then
paid the bill: (a) Water/Sewer confirmed in July as "CITY OF MADISON"; a different August city charge −85 (on a $101.02
bill, generalized in the review as $1,212.24 vs $1,297.24 on a larger household) counted paid; (b) rent confirmed as
"ZELLE TO JORDAN LEE", then a bare "ZELLE" −1,400 to someone else counted paid.

**Fix, two parts (`planMatch.ts`):**
1. **`descriptorsMatch`** — stricter than the dedupe pass's `descriptionsFuzzyEqual`: the two word sets must be EQUAL, or
   one a subset of the other with the SHORTER side carrying ≥ 2 distinctive words (not a stop word, ≥ 4 letters or ≥ 3
   digits). "ZELLE" is inside "ZELLE TO JORDAN LEE" but names no one (one distinctive word); "MADISON GAS EL" (also one
   distinctive word) now only matches its own exact string.
2. **`inConfirmedRange`** — the row's amount must sit inside the confirmed rows' own amount range (± max($1, 1%)), not
   the bill's wide $25/10% band. `MatchPlan.confirmedRows` replaces `confirmedDescriptions` (description **and** signed
   amount, last 12 per item); the ledger's `confirmedRowsByItem` map now carries `{ description, amount }` using the
   `resolvedTxnAmount` it already reads.

The wide $25/10% band still applies, but only to rule (a) — the bill's own, sole category — which is a claim about the
*plan*, not about a specific past payment, so it isn't vulnerable to "a different amount from the same company."

**Owner trade-off (flagging, not deciding):** a confirmed descriptor is now a much narrower reference than before — a
single confirmed month effectively pins the accepted amount to within about 1%. A bill that legitimately varies month to
month (a utility, a usage-based charge) will need either several confirmed months spanning its real range, or its own
category, to keep clearing automatically; otherwise every off-amount month is a suggestion again until confirmed. This
is deliberately the more conservative failure mode (never overstates), at the cost of asking more often.

| Case | Round 1 | Round 2 (bug) | Round 3 |
|---|---|---|---|
| Verizon $425 on $430, confirmed at $430, shared category (seed household, case C) | 9,043.98 / 8,543.98 | **9,043.98 / 8,543.98** (bug: only $5 drags) | **8,618.98 / 8,118.98** (whole $430 drags) |
| State Farm Insurance renewed $165 on $180, confirmed at $180, shared category (case D/D2) | 8,693.00 / 8,193.00 | **8,693.00 / 8,193.00** (bug: only $15 drags) | **8,528.00 / 8,028.00** (whole $180 drags) |

(The review's own $1,212.24/$1,297.24 and $8,500/$9,900 figures describe the same mechanism on a different household;
the seed-household cases above are what this repo's test fixtures could measure exactly — same bug, same fix, real
dollar amounts pinned by an existing hand-worked household.)

Tests (`planMatch.test.ts`, unit-level): MGE confirmed exact amount still tier 2; a superseded "fuzzy" case (one
distinctive word) now requires the equal set, not a superset; a genuine ≥ 2-distinctive-word subset ("TOYOTA MOTOR
CREDIT" inside "TOYOTA MOTOR CREDIT CORP") still matches; "ZELLE" inside "ZELLE TO JORDAN LEE" no longer matches; a
confirmed range from several rows (Water $89–$112) accepts anything between, and rejects just outside it; the MGE
$216-on-$241 underpayment (round 2's own worked example) is now a suggestion unless the bill is sole in its category, in
which case rule (a) — not the descriptor — pays it. Integration-level (`cashSignalSeedHouseholdTiers.integration.test.ts`):
cases C, D and D2 updated to the round-3 figures above, with the trade-off noted in each test's comment.

### MEDIUM 2 — a manual twin made a paid bill drag

**Bug.** A manual "Toyota Lease" −672.80 logged beside the bank's own "TOYOTA FINANCIAL SERVICES" −672.80 tied on rank
and score, so the pairing was ambiguous — Toyota dragged $672.80 even though the bank had paid it.

**Fix (`planMatch.ts`).** Pairing rank now has two components: whether the pair would be tier ≤ 2 (unchanged), then
whether the row is a Plaid checking row (0) or manual (1). A Plaid row is always taken over a manual twin, and a
runner-up only makes a pair ambiguous when it is of the **same or better** rank — a lower-ranked manual twin never casts
doubt on the Plaid pair it shadows.

Test (`planMatch.test.ts`, unit-level, "MEDIUM 2"): the manual twin and the Plaid row both offered; the Plaid row wins,
non-ambiguous, tier 2, off the curve; the manual row is simply unpaired (never surfaced) — it still counts as cash under
the existing checking-row rule, just not as this bill's evidence. On the pre-round-3 source this same test picks the
manual row (alphabetically) and marks the pair ambiguous — the exact bug.

### LOW — an overdue underpayment read as "Still in forecast" and offered a Move that would re-add the full bill

**Bug.** An overdue tier ≤ 2 pair that paid LESS than the plan keeps `offCurve: false` (by design — the plan still needs
its remainder). The web read `offCurve` alone, so it showed "Still in forecast" and offered Move — which posts the
occurrence's FULL planned amount on a new date, while the server is already counting the row as paid and dragging only
the smaller remainder. Confirming Move would have double-subtracted the paid part.

**Fix.**
- `CashSignal.matches[].remainderAmount` (spec + `cashSignal.ts` + `forecastMatch.ts`, web type): present only when the
  ledger counts the plan paid by this row (the same overdue evidence pass that builds `overdueAssumedPaid`), signed like
  the plan, `"0.00"` when paid in full. `forecastLedger.ts` now tracks a `remainderByPlanKey` map alongside
  `overdueAssumedPaid` (same `signedRemainder` value) and returns it on the ledger; `cashSignal.ts` looks it up by
  `planKey` when building each match.
- Web: `probablyPaidText.tsx` adds `RemainderNote` (mono numerals, "Paid; $X still assumed unpaid" / "Paid in full") and
  `remainderHelp()`. `PlanDropRow.tsx` and `ProbablyPaidStrip.tsx` render it instead of `curveLabel` whenever
  `remainderAmount` is present.
- **Move is hidden entirely** for a pair with `remainderAmount` set (`hasRemainder` alongside the existing
  `offCurveSuggestion` guard in `PlanDropRow.tsx`) — moving only the remainder is not supported, so the safe choice is no
  Move rather than a wrong one. Mark missed is untouched (it does not re-add an amount).
- `ProbablyPaid.tier` stays optional, unchanged — this PR does not touch that contract.

Codegen: `pnpm --filter @workspace/api-spec run codegen` regenerated `lib/api-zod` and `lib/api-client-react` (`src` +
`dist`, committed); a second run is a no-op.

Tests: `cashSignalProbablyPaid.integration.test.ts` — an overdue $95 bill (sole category) paid $80 exposes
`remainderAmount: "-15.00"` and a matching `overdueAssumedPaid` entry; paid in full it is `"0.00"`, not absent.
`forecastProbablyPaid.test.tsx` — the remainder note replaces "Still in forecast" on both the register row and the bank
strip, and Move is hidden for that pair while Mark missed stays. Both fail on the pre-round-3 web source (it renders
"Still in forecast").

### Golden changes, explained

`forecastLedger.golden.integration.test.ts` — exactly one shape changed, in all 6 entries that carry the Golden Card
minimum pair: `remainderAmount: "0.00"` added to that one match object (the $38 minimum paid $60 — paid in full, tier 2,
`offCurve: true`). No balance, low point, ending, or projected figure changed in any entry; this fixture doesn't exercise
the HIGH/MEDIUM-1/MEDIUM-2 scenarios (no shared categories, confirmed descriptors, or manual twins in its rows). Re-
recorded without `CI=true` (`-u`), diff reviewed (`git diff` — 6 insertions, all the same line), then verified with
`CI=true`.

### Fails-before (round 3's new/changed assertions, stash-and-run against this branch's pre-round-3 source)

Stashed the round-3 diff in the 5 source files only (`planMatch.ts`, `forecastLedger.ts`, `cashSignal.ts`,
`forecastMatch.ts`, `openapi.yaml` — no effect on the spec/type-only file) and, separately, the 4 web display files
(`forecastMatch.ts`, `PlanDropRow.tsx`, `ProbablyPaidStrip.tsx`, `probablyPaidText.tsx`), ran the new/changed tests, then
popped.

| Suite | Failed | Passed |
|---|---|---|
| `planMatch.test.ts` (unit) | **5** | 54 |
| `cashSignalProbablyPaid.integration.test.ts` (HIGH cases) | **2** | 16 |
| `cashSignalSeedHouseholdTiers.integration.test.ts` (MEDIUM 1 cases) | **3** | 6 |
| `forecastProbablyPaid.test.tsx` (LOW, web-only stash) | **2** | 17 |
| **Total** | **12** | — |

### Gates (this branch, before the PR-C merge below)

- `pnpm run typecheck`: pass.
- Web tests (135 files): `TZ=UTC CI=true` 1115 passed, 3 skipped; `TZ=America/Chicago CI=true` 1116 passed, 2 skipped.
- Full API suite (`CI=true`, own DB `h2budget_test_prb`, `caffeinate -i`, serial): **141 files, 1365 passed**, 7 todo.
- `pnpm run build && node scripts/check-entry-graph.mjs`: OK — landing 574.4 KB of 580.0 KB (unchanged; this round adds
  no weight to the open path).
- Codegen: `pnpm --filter @workspace/api-spec run codegen`, rerun with no further diff; generated `src` + `dist`
  committed.
- Golden: re-recorded without `CI`, verified with `CI=true` (6 entries, one field each, explained above).

### Open questions for the owner

- The MEDIUM 1 trade-off above: a confirmed descriptor is now a tight reference (~1% of one or a few past amounts), not
  a wide one. Is that the right default for a bill known to vary (e.g. usage-based utilities), or should such a bill
  instead rely on its own category (rule a) once it's the only bill there?
- Residual 3 from round 2 (two bills sharing one descriptor, e.g. the two State Farm policies) is unaffected by this
  round — `descriptorsMatch` requiring word-set equality/2-distinctive-word-subset does not disambiguate which OF two
  same-descriptor bills a confirmed reference belongs to; it only stops an unrelated shorter charge from borrowing it.
- Q3 from round 2 (fix 3 reversing the PR5 second review's guard) is effectively answered by this round: the guard is
  restored (nameless doesn't count), and fix 3's real case (a *named* late pair) is kept. No further owner input needed
  unless this reading is wrong.

## Round 4

The round-3 review verified all four fixes and merged cleanly with PR-C, then found one more real bug (HIGH) in the web's
own reconciliation, decided the fix for residual 5 (understated future bills), and asked for one known trade-off to be
pinned as a test and disclosed rather than fixed.

### HIGH — `forecastReconcile.ts` double-subtracted a paid-in-part bill

**Bug.** `computeBankReconcile` (`forecastReconcile.ts:~106-111`) added the plan's FULL amount to `forecastEnd` for any
open plan not fully `offCurve` — including the new round-3 overdue tier-2 underpayments that carry `remainderAmount`.
The row had already left the bank; adding the full plan on top double-subtracted the paid part. Repro: Insurance $180
due 05-10, paid $165 (tier 2, `remainderAmount: "-15.00"`) — "Projected end" subtracted $180, understating by $165. The
same bug existed a second time in `forecastMatch.ts`'s own running-balance fallback (`buildLineRegister`, the
`bankInWindowAll.length === 0` branch), and the register row showed −$180 beside "Paid; $15.00 still assumed unpaid" —
correct words, wrong number beside them.

**Fix.** Both sums now read `Number(remainderAmount)` instead of the full `p.amount`/`r.amount` when a match carries a
remainder. The register row's face amount does the same (`PlanDropRow.tsx`), with a new "Paid $165.00 of $180.00"
caption (`data-testid="plan-remainder-paid-…"`) mirroring the existing `partial` line's own caption — `PlanLine.amount`
itself is left untouched (still the full plan) so `canRecordPartial` and other consumers keep their existing meaning;
only the three DISPLAY/SUM sites that specifically care about "what's still projected to leave the bank" changed.

| Case | Before | After |
|---|---|---|
| `computeBankReconcile` unit test (p1 −$50, Insurance $180 paid $165) | forecastEnd **770** (1000 − 50 − 180) | forecastEnd **935** (1000 − 50 − 15) |
| Register row face amount (Insurance $180 paid $165) | **−$180.00** beside "Paid; $15.00 still assumed unpaid" | **−$15.00**, with "Paid $165.00 of $180.00" underneath |

Tests: `forecastReconcile.test.ts` (new unit case); `forecastProbablyPaid.test.tsx` (new register-figure case). Both
fail on the pre-round-4 web source (770 vs 935; the caption testid doesn't exist).

### DECIDED (candidate C) — the remainder-only drag now applies before the due date too

Closes residual 5. **Fix (`forecastLedger.ts`):** for a plan due today or later, if its pair is tier ≤ 2 and the row
underpaid (`paidByKey` already carries every tier ≤ 2 pair, overdue or not), the plan leaves the curve and only the
unpaid remainder drags — **on the plan's own date**, never dragged to a business day like the overdue sibling. Tagged
`remainder_assumed_unpaid` (sibling to `overdue_remainder_assumed_unpaid`); `remainderByPlanKey` (and so
`CashSignal.matches[].remainderAmount`) is set the same way for these pairs as for overdue ones. The tier gates
themselves are exactly round 3's — unchanged. As the review noted, this only ever reaches rules (a) category and (d)
confirmed descriptor in range: the name rules (b)/(c)/(c′) already require paying ≥ plan − max($1, 1%), so they can
never produce an underpaid tier-2 pair for this branch to catch. `offCurve` stays `false` for these (the web already
reads `remainderAmount`, from round 3's LOW fix).

| Case | Before (round 3) | After (round 4) |
|---|---|---|
| Verizon $430 due 05-16, confirmed 425–434, paid $425 two days early | balance 05-16 **145.00** (575 − 430, full bill drags) | balance 05-16 **570.00** (575 − 5, only the remainder) |
| State Farm Insurance $180, sole category, paid $165 before due | balance 05-20 **655.00** (1000 − 165 − 180) | balance 05-20 **820.00** (1000 − 165 − 15) |

Spine low point / max safe extra reflect the same fix: a 3-day-horizon read of the Verizon case gives
`lowestProjected`/`maxSafeExtra` **570.00**, where the full plan would have given 145.00.

**Unchanged, verified:** the round-3 hole repros (Verizon $425/$430 shared-category case, seed household case C, now
8,618.98/8,118.98; State Farm Insurance $165/$180 sole-category case, seed household case D, now 8,528.00/8,028.00) and
the HIGH water hold-back case (2,850.00) all still pass unmodified — this round's change only reaches FUTURE plans (a
new branch at the bottom of the events loop); the OVERDUE branch these cases exercise is untouched. D2 (Toyota, tier 3
hold-back) is likewise unmodified and still passes.

Tests: `cashSignalProbablyPaid.integration.test.ts`, new describe block "the remainder-only drag also applies before the
due date" (Verizon and State Farm Insurance cases above, plus the spine low-point/max-safe-extra check). Both fail on
the pre-round-4 ledger source (`remainderAmount` absent from the match).

### MEDIUM — disclosed, NOT fixed: a coincidental same-payee named charge can still misattribute the hold-back

The hold-back's "named, not ambiguous" branch (`forecastLedger.ts`, the `pairedKeys` filter) accepts ANY named,
non-ambiguous, non-low-confidence pair as proof an earlier occurrence was paid — even a charge that plainly isn't the
bill (wrong amount, wrong day, just a same-payee coincidence). Repro: "City Water" $150 monthly; an unrelated "CITY
WATER METER FEE" −$140 five days before April's due date (medium confidence — named via "water", $10 short — tier 3,
not itself evidence April was paid) clears April for the hold-back anyway; April's REAL $150 payment, posted late, then
pairs with MAY instead (full name, exact amount, tier 2) and takes May off the curve while May hasn't been paid.

**Why this stays open.** Tightening the hold-back to require tier ≤ 2 (real evidence, not just "named and not
ambiguous") would revive the exact UNDERSTATEMENT the first review measured: a named tier-3 pair (a $685 "late fee" on
July's $672.80 Toyota, six days early — genuinely July's payment, just off by $12.20) is exactly this same shape, and
holding it back is what let August's exact $672.80 payment stay correctly off the curve (round 3's own D2 case). The two
repros are structurally identical to the matcher — a named, non-ambiguous, imperfect-amount pair for an earlier
occurrence — and there is no rule inside `matchPlansToRows` today that tells "July's real late payment, $12.20 off" from
"an unrelated April fee that happens to say WATER." Fixing one repro un-fixes the other. This is disclosed, not
resolved, pending the owner's call on which failure mode is preferable (or a future PR that finds a real
discriminator — e.g. requiring the earlier pair's amount within some tolerance of the item's OWN plan amount, which
would pass the Toyota case ($672.80 vs $685, 1.8% off) and fail the water case ($150 vs $140, 6.7% off), but that
tolerance choice is itself a judgment call for the owner, not mine to make unasked).

Test (`cashSignalProbablyPaid.integration.test.ts`, "a coincidental same-payee named charge clears an earlier occurrence
for the hold-back"): pins the current, round-3 behaviour exactly — April reads `tier: 3, confidence: "medium"`, May
reads `tier: 2, offCurve: true` and the curve shows May paid ($850.00, same as bankToday) even though May hasn't been
paid. This test is a residual pin, not a new fix — it passes on both the round-3 and round-4 source unchanged, and is
included here so the trade-off has a concrete, checked repro rather than only prose.

With round 4's future remainder drag (`remainder_assumed_unpaid`, review followups item 2) added on top, the same
misattribution can now carry a wrong DOLLAR remainder on a future plan, not only a wrong on/off-curve state — the
drag amount is computed from the same misattributed pair's `txnAmount`.

**Closed by PR-B2 (owner decision 2026-09-15, the stricter direction):** the hold-back now needs tier-1/2 proof; the
named branch is removed, and D2 drags until July is confirmed. See `2026-09-15-holdback-proof-only.md`.

### Golden

No entries changed this round. The full-household golden fixture (`forecastLedger.golden.integration.test.ts`) has no
future tier ≤ 2 pair that underpays, so the new `remainder_assumed_unpaid` branch is never exercised by it; re-run with
`CI=true` unchanged (11/11 pass, no `-u` needed).

### Fails-before (round 4's new tests, stash-and-run against this branch's pre-round-4 source)

Stashed the round-4 diff in the 4 behavioural source files (`forecastLedger.ts`, `forecastReconcile.ts`,
`forecastMatch.ts`, `PlanDropRow.tsx` — `openapi.yaml`'s change is a description only) and, separately, `forecastLedger.ts`
alone for the DECIDED-C cases, ran the new/changed tests, then popped.

| Suite | Failed | Passed |
|---|---|---|
| `forecastReconcile.test.ts` (HIGH, unit) | **1** | 16 |
| `forecastProbablyPaid.test.tsx` (HIGH, register figure) | **1** | 35 (both files together) |
| `cashSignalProbablyPaid.integration.test.ts` (DECIDED C) | **2** | 19 |
| **Total** | **4** | — |

The MEDIUM residual-pin test is not counted here — it asserts EXISTING (round-3) behaviour and passes on both sides of
the stash, by design.

### Gates (this branch, before the PR-D merge below)

- `pnpm run typecheck`: pass.
- Web tests (138 files): `TZ=UTC CI=true` 1142 passed, 3 skipped; `TZ=America/Chicago CI=true` 1143 passed, 2 skipped.
- Full API suite (`CI=true`, own DB, `caffeinate -i`, serial): **142 files, 1417 passed**, 7 todo.
- `pnpm run build && node scripts/check-entry-graph.mjs`: OK — landing 574.4 KB of 580.0 KB, unchanged.
- Codegen: `pnpm --filter @workspace/api-spec run codegen`, rerun with no further diff after the second run; generated
  `src` + `dist` committed (only a description-comment change this round — `events[].assumption`'s new tag value).
- Golden: verified with `CI=true`, no changes (see above).

### Open questions for the owner (round 4)

- The MEDIUM item above: is there a better discriminator than "named and not ambiguous" for the hold-back, or is the
  current asymmetry (favor not re-dragging a genuinely-late payment, at the cost of an occasional same-payee
  misattribution) the intended trade-off? A concrete idea is floated above (tolerance relative to the item's own
  amount) but not implemented — it would move a real number in real households and shouldn't ship without a decision.
- Everything else from round 3's open questions still stands as answered/closed; nothing new otherwise.
