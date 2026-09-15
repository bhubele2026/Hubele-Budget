# PR-H — the household money model, a shared foundation (owner decisions 7 and 12)

- **Base:** branched from `main` at `df5d8b0b`, and merged with `main` since — most recently `9aad763` (merge commit
  `b7106660`), so the branch tree is what `main` becomes. Round 1's "Base: `main` = `df5d8b0b`" was stale (review N1).
- **Branch:** `feat/household-money-core`.
- **Owner decision 7:** one household calculation — bank balances, weekly spending, bills and debt payments fit
  together without counting money twice. Cash moves only through checking rows and unresolved plans; card rows never
  move cash, they size a future Amex payoff plan.
- **Owner decision 12:** a confirmed bill match should stop counting a second time toward allowance/weekly spend (the
  bill is already in the plan).
- **Owner rule, 2026-09-15 (the TARGET for PR8r/PR10, not this PR's output):** one spending rule everywhere, through
  `classifyMovement` coverage — a debt payment fills its debt plan line, never a spending category; a card payment
  counts nowhere; a reimbursable charge is its own row; a pending charge and its posted copy count once; Budget
  `plannedTotal`/`planBySource` do not change.

**This PR changes no displayed figure.** Nothing in production calls the classifier or the loader. It lays the
foundation, and proves — against today's figures, row class by row class — exactly what will move when PR8r/PR10
switch a figure onto it.

## Scope (plan section A, as amended 2026-09-15 after review round 1)

In this PR:

- `classifyMovement` — one coverage, one timing per row, conflicts reported; the tier-2 half of step 2 as an
  **injected** set (`tier2PairedTxnIds`, empty by default).
- `everydayPlan` — the weekly cap (standing amount or that week's override) and the monthly cap.
- `loadMoneyContext` — the one server read the classifier needs.
- `amexCardCadence.ts` — card discovery and cadence, extracted from `computeWeeklyPayoff` and shared.
- Parity helpers `classifierHouseholdSpend` and `classifierAllowanceRows`, each with a `"today"` and a `"forward"` mode.
- Test-only parity: Spending's `householdSpend` and the spine's `spentMonth`/`spentWeek` are reproduced exactly;
  the Budget allowance card differs by an enumerated list of classes (below).

Deferred, on purpose:

| Section A item | Moves to | Why |
|---|---|---|
| Timing "via an Amex payoff on date Y" | **PR8r** | Needs the payoff hooks. Until then a card row's timing is `card` with its own date. |
| `preferences.everydayHooks` (read + validated) | **PR8r** | Ships with the hooks, with its OpenAPI schema and server validation. |
| `preferences.paycheckItemIds` (read + validated) | **PR9** | Ships with paydays, with its OpenAPI schema and server validation. |
| The tier-2 pair set itself | **PR8r** | Supplied from the match tiers; this PR only honours an injected set. |
| Production wiring (spine, Spending, Budget reading the classifier) | **PR8r / PR10** | Wired when a figure switches; until then a second pass and an extra query would compute a number nothing shows (CLAUDE.md §2). |

## What changed

### 1. The pure core — `lib/avalanche-core/src/householdMoney.ts`

`classifyMovement(row, ctx)` returns exactly one `coverage` and one `timing`:

- `coverage` ∈ `transfer | debt_payment | card_payment | bill_matched | unplanned | allowance_monthly |
  allowance_weekly | reimbursable | needs_classification | income | excluded`.
- Precedence, first match wins:
  1. the core spending rule (`classifyOutflow`, with `reimbursableIsSpend: true` so its own reimbursable rule cannot
     pre-empt steps 2-6) — transfer / debt payment / card payment / income / excluded (bank noise folds into
     `transfer`, exactly as the Spending report buckets it);
  2. a **confirmed** bill match (`ctx.matchedTxnIds`) → `bill_matched`, with the flag it beat reported:
     `flag_ignored_matched` (weekly/monthly) or `unplanned_on_matched`. **Or** a tier-2 pair
     (`ctx.tier2PairedTxnIds`) on a row with **no allowance flag** → `bill_matched`; a flagged row keeps its flag and
     reports no conflict. `reimbursable` is not an allowance flag;
  3. `unplanned_allowance` → `unplanned`;
  4. `monthly_allowance` → `allowance_monthly`;
  5. `weekly_allowance` → `allowance_weekly`;
  6. `reimbursable` → `reimbursable`;
  7. otherwise → `needs_classification`.
- An inflow is `income` when `isRealIncome` says so, else `excluded`.
- `timing` ∈ `{kind:"checking", date}` | `{kind:"card", accountId, date}` | `{kind:"none"}`. Checking is `isBankRow`,
  called directly — the cash rule's own identity. **With no resolved checking account, no Plaid row is checking, but
  a manual row (no Plaid account, source not a card) still is**, exactly as `classifyCashRows` counts it: "cash moves
  only through checking rows". (Round 1's note said a null account meant "never checking"; the code was right and the
  note was wrong — review N2.) `card` is an Amex ledger row (`CARD_LEDGER_SOURCES`, pinned equal to
  `AMEX_TXN_SOURCES`).

`everydayPlan(periodStartSunday, settings, overrides)` returns `{weeklyCents, monthlyCents}`, parsed the way the
Allowances page parses it: an override counts only when `Number(value)` is finite, standing amounts are `Number(value)`
or 0, and only a key that is a week start on the household clock (`isHouseholdWeekStart`: a real date that is its own
Sunday–Saturday week's Sunday) is an override. `command-center.tsx` reads an override with `Number()` and no finite
check (NaN for "12abc"); that page is not changed here.

### 2. The Amex card cadence extraction — `artifacts/api-server/src/lib/amexCardCadence.ts`

`discoverAmexCards(householdId, ownerUserId?, { preferences? })` is `computeWeeklyPayoff`'s card discovery and
cadence block, moved. `computeWeeklyPayoff` calls it exactly as before (no preferences handed in, so it reads them).
The one addition: a caller that has already read the owner's settings row hands its `preferences` in, and the row is
not read again. Discovery and cadence are now pinned directly (`amexCardCadence.integration.test.ts`), including
through `computeWeeklyPayoff`'s own cards.

### 3. The server loader — `artifacts/api-server/src/lib/moneyContext.ts`

`loadMoneyContext(householdId, range, { supersede? })` returns a context that **is** a `MovementContext`. Each table
is read once:

- the owner's settings row: the allowance amounts, `weeklyAllowanceOverrides` (read server-side for the first time),
  and the Amex preferences handed to `discoverAmexCards`;
- the household's categories — `categoriesById`, `debtCategoryIds`, and `effectiveFiling`'s uncategorized ids;
- confirmed matches (`matched`/`partial`) whose matched transaction **belongs to this household** and is dated in the
  range, by its own date — **plus each posted row whose replaced pending row carries a confirmed match** (read
  `SUPERSEDE_MAX_DAYS` before the range, which covers every pending row a posted row in the range can have replaced);
- the pending pairs — `findSupersededPendingForRange` for the range, or the caller's own already-read pairs;
- the tracked checking account (`resolveLedgerAccounts`) and the Amex cadence map (`discoverAmexCards`);
- `tier2PairedTxnIds`: empty until PR8r.

### 4. Parity helpers — not wired into any live request path

- **`spendingFacts.ts` — `classifierHouseholdSpend(rows, ctx, { mode })`.** Given the same effective-filing rows
  `buildSpendingFacts` sums. Mode `"today"` (default) **is** `householdSpend`, total and count: a confirmed match
  counts like any purchase, and a reimbursable row never counts, whatever flag or match it carries (today's rule 7).
  Mode `"forward"` is coverage alone.
- **`budgetActuals.ts` — `classifierAllowanceRows(rows, supersede, ctx, movement, { mode })`.** Mode `"today"` keeps
  today's handling of matches (bucket by the row's own flag) and reimbursables (bucket nowhere); it still differs from
  `aggregateBudgetMonth` by the classes below. Mode `"forward"` is coverage alone.
- `routes/spine.ts`, `routes/budget.ts`, `routes/reports.ts`: no diff.

## Proof no figure moves

- **Golden files byte-identical:** no file under a golden snapshot path is in this branch's diff against `main`
  (`git diff --stat origin/main -- '*golden*'` is empty); `forecastLedger.golden.integration.test.ts` passes.
- **The spine parity file only gains assertions:** one new test; every existing assertion is untouched and passes.
- **No route, response shape, OpenAPI spec or generated client changed.** Codegen regenerated with no drift.
- **`computeWeeklyPayoff` unchanged:** its call is unchanged, and its cards' cadence and display names are pinned
  against the discovery directly.
- The full API suite, both web suites, the build and the entry-graph check pass on the merged tree (Verification).

## Where the classifier differs from what is displayed today

### Spending (`householdSpend`) and the spine (`spentMonth`/`spentWeek`)

Mode `"today"` is exact — on a seeded randomized ledger (9 windows plus the spine's shared-pairs shape) and over the
spine's own month and week windows. Mode `"forward"` differs in two places:

1. **A confirmed bill match stops counting** (decision 12), including a match carried from a pending row to its posted
   row. Pinned: a matched −142.17 row is counted today and removed by `"forward"`, exactly 14,217 cents.
2. **A reimbursable row carrying an allowance flag counts under its flag**, because steps 3-5 outrank step 6. Pinned:
   a −35.00 reimbursable weekly-flagged row is $0 today and $35.00 in `"forward"`; a plain reimbursable row stays out.
   **The owner's rule ("a reimbursable charge is its own row") sides with today here** — PR8r must move `reimbursable`
   ahead of the flags, or keep the gate, before it switches a figure.

### The Budget allowance card (review H1)

Today's allowance rule (`aggregateBudgetMonth`) screens four things — transfer, external card payment, reimbursable,
debt tag — then buckets any flag. The classifier runs the one spending rule first, so it also drops every flagged row
that rule excludes. `budgetActuals.test.ts` compares both functions on 20,000 seeded units (single rows and pending
pairs; inflows, refunds, $0 rows; every category kind; plain and pattern descriptions; flags, reimbursables, transfers,
debt tags, card-payment flags and Plaid card-payment categories; confirmed matches and tier-2 pairs). They agree on
every unit **except** the classes below, and **every unit in a class really diverges** — the list is exact, and each
class must be hit at least 20 times. The reviewer's 8 repro rows are pinned one per class.

Shares are of the synthetic generator's 20,000 units. They show every class is live; they are **not** how often each
case happens in the household's ledger.

| Class | Synthetic example (flagged; today buckets it, the classifier does not) | Share of units | Owner's one rule says |
|---|---|---|---|
| `non_outflow` | a +20.00 refund flagged weekly — today adds a row with `spend "0.00", cnt "1"` (the count shows on the card); or a $0.00 row | 13.54% (credit/refund 11.09%, $0 2.46%) | classifier: a refund is not spending |
| `excluded_category` | −40.00 in "Ignore", weekly (also "Transfer" and "Reimbursement") | 10.69% (Ignore 3.71%, Transfer 3.74%, Reimbursement 3.25%) | classifier: those categories are never spending |
| `bank_noise_description` | "PLANET FITNESS AUTOPAY" −15.00 monthly; "REPAY *PEST CONTROL" −12.00 unplanned | 5.34% | classifier for real transfers and payments — **but see the false-positive list** |
| `income_category` | −9.00 in "Paycheck" (an income category), weekly | 3.69% | classifier: an outflow in an income category is a reversal, not spending |
| `debt_category` | −80.00 in "Card Payoff" (linked to a debt), monthly | 3.46% | classifier: a debt payment fills its debt plan line, never a spending category |
| `card_payment_description` | "CRCARDPMT REF 42" −300.00 weekly; "CAPITAL ONE MOBILE PYMT" | 1.88% | classifier: a card payment counts nowhere |
| `plaid_card_payment` | −25.00 with Plaid's credit-card-payment category (`LOAN_PAYMENTS_CREDIT_CARD_PAYMENT`), weekly | 1.36% | classifier: a card payment counts nowhere |

In mode `"forward"` two more classes appear (today mode has none of them, asserted):

| Class | Synthetic example | Share of units | Owner's one rule says |
|---|---|---|---|
| `bill_matched_flagged` | −88.40 weekly-flagged, confirmed match: today buckets it, `"forward"` buckets nowhere | 2.18% | classifier: decision 12 — the bill is already in the plan |
| `reimbursable_flagged` | −25.00 reimbursable and weekly-flagged: today buckets nowhere, `"forward"` buckets it weekly | 1.82% | **today**: a reimbursable charge is its own row — PR8r decides the step order before switching |

Mapping to the reviewer's 12 classes (core kind × matched): matched or not makes no difference to any class above,
because the core rule fires before the match; the reviewer's `debt_payment` is `debt_category` (a tagged debt payment
is screened by today's rule too), and `card_payment` is `plaid_card_payment` + `card_payment_description` (an external
card-payment flag is screened by today's rule too). Their reimbursable rows are `reimbursable_flagged` and, when
matched, the today-mode gate.

### ⚠️ For the owner: description rules that look like false positives on real purchases or bills

`classifyOutflow` is **not changed** here. These description rules (rule 9b, `TRANSFER_PAYMENT_PATTERNS`, substring
match) exclude rows that read like real purchases or bills. Spending already excludes them today; the Budget allowance
card counts them when flagged, and will stop when it switches to the one rule.

- **"autopay"** — a merchant subscription billed on autopay ("PLANET FITNESS AUTOPAY") is a real purchase.
- **"epay"** (substring) — "REPAY *PEST CONTROL", "EPAYMENTS PLUMBING LLC" are purchases; `spendingRule.ts` already
  notes this.
- **"web id:"** — billers' ACH debits carry it ("CITY WATER WEB ID: 4417"): a bill payment, not a transfer.
- **"ach pmt" / "ach payment"** — "ACH PMT RIVERSIDE GYM" is a membership debited by ACH.

Issuer card-payment phrases (rule 9: "CRCARDPMT", "CAPITAL ONE MOBILE PYMT") and Plaid's card-payment category
(rule 8) look sound. In the generated data each flagged description above is 0.82–0.93% of units.

## Round 2 — review findings, what changed, and the proof

"Fails on `26db504`" means: the round-2 test files, run against `26db504`'s versions of the six source files (the
merged tree otherwise), fail — 36 of their tests do. The tests pinning M1, M2, the L2 household scope and L3 each fail
for that fix's own reason, quoted below.

| Finding | What changed | Proof |
|---|---|---|
| **H1** allowance "parity" false | Fixture parity replaced by the 20,000-unit seeded comparison with enumerated classes, exact in both directions; round 1's claim removed; classes listed above with shares, owner sides and false-positive flags. Mode `"today"` gates reimbursables, so the classes are only the one-rule screens. | `budgetActuals.test.ts`; mutation `R2-H1` caught |
| **M1** today mode ≠ `householdSpend` | Mode `"today"`: a reimbursable row never counts. Seeded randomized DB ledger (400 rows + 45 pending pairs, resolutions matched/partial/skipped/needs_review) compared over 9 windows and the spine's shared-pairs shape: total and count equal. | `spendingFactsClassifierParity.integration.test.ts`; the M1 test fails on `26db504` (`{ total: 109, transactionCount: 3 }` instead of `{ total: 0, transactionCount: 0 }`); `R2-M1` caught |
| **M2** pending-row match lost on posting | The loader carries a confirmed match from a pending row to the posted row that replaced it, reading 7 days before the range. | Pending −40 matched, posted −48: counted once today, $0 forward, also from a window starting after the pending day; loader test with the pending row dated before the range. Both fail on `26db504` (the posted row is not in `matchedTxnIds`: `false` instead of `true`); `R2-M2` ×3 caught |
| **M3(a)** tier-2 half of step 2 missing | `tier2PairedTxnIds` injected set, honoured only on rows with no allowance flag. | 6 unit tests; property test hits `step2:tier2` 220, `tier2-ignored:flagged` 596; `R2-M3a` ×2 caught |
| **M3(b)** payoff-date timing | Deferred to PR8r, stated in the scope table and the core file's header. | — |
| **M3(c)** `everydayHooks`, `paycheckItemIds` | Deferred: PR8r and PR9, each with its OpenAPI schema and validation. Stated in the scope table and the loader header. | — |
| **M3(d)** no spine parity through the classifier | Test-only: `spentMonth`/`spentWeek` equal mode `"today"` over the spine's own windows (`weekStartFor`/`weekEndFor`, month start → today), with the pairs shared as the spine shares them and read per window. Production wiring stays with PR8r/PR10. | `spineParity.integration.test.ts` (one added test) |
| **M4** cadence extraction untested | `amexCardCadence.integration.test.ts`: discovery filters (type, liability kind, institution, household), brand, default and explicit cadence both ways, names, excluded ids, pre-read preferences, `classifyAmexBrand`, and `computeWeeklyPayoff`'s cards. | A1–A7 caught (table) |
| **L1** loader shape | One categories read with everything the context needs; settings read once and handed to `discoverAmexCards`; optional pre-read pairs. | Loader tests incl. a spy on the handed-in preferences; `R2-L1` ×4 caught |
| **L2** loader tests shape-only; no household scope on the match join | `transactions.household_id` scoped. Tests against real rows: checking account, Amex cadence map, pending pairs; two households side by side, including resolutions that cross households in both directions. | C2, C5, C6, C7 and `R2-L2` caught; the cross-household test fails on `26db504` (the other household's row reads as matched: `true` instead of `false`) |
| **L3** override parsing differs from the web | `Number` + finite check, standing amount fallback; non-week-start keys ignored; comment corrected. | "12abc", padding, exponent, non-Sunday and impossible-date tests, plus a value-by-value check against the Allowances page's formula; fail on `26db504` ("12abc" gives 1,200 cents instead of 15,000; a Monday key gives 99,900 instead of 15,000); `R2-L3` ×2 caught |
| **L4** five behaviours unpinned | One targeted test each: reimbursable card payment stays a card payment (M4); unplanned+weekly/monthly on a match reports `unplanned_on_matched` (M8); one row per coverage at distinct powers of two (S1); no mode given is `"today"` (S5); a bare posted row buckets under the flag it inherits (B5). | M4, M8, S1, S5, B5 caught |
| **N1** base line | Base line above corrected. | — |
| **N2** null checking account | The note was wrong, the code right (the cash rule's identity); corrected here and in the code comments; unit test pins manual → checking, Plaid → none. | `householdMoney.test.ts` |
| **N3** weak property generator | 6,000 seeded rows checked against an independent model of section A; generator built to reach every branch; each of 28 paths asserted ≥ 25 hits. | Hit counts below |

Property-test hit counts (6,000 rows): step 1 — transfer 183, bank noise 173, debt payment 344, card payment 571 (of
which over a reimbursable 191), excluded category 344, income category 189, inflow→income 154, inflow→excluded 408;
step 2 — confirmed 268, with `flag_ignored_matched` 364, with `unplanned_on_matched` 311 (unplanned plus another flag
175), confirmed and tier-2 291, tier-2 alone 220, tier-2 ignored on a flagged row 596; steps 3-7 — unplanned 948
(over another flag 539), monthly 614 (over weekly 214), weekly 408, flag over reimbursable 593, reimbursable 160,
needs_classification 341; timing — checking 2,205 (with no resolved account 267), card 2,339, none 1,456.

### Mutation results

The reviewer's runner, copied (scratchpad `mutate-r2.mjs`) and pointed at this worktree. Each mutation is applied
alone, the PR's test files run (the Amex set — every test file mentioning Amex — for `A*`), then reverted. Where
round 2 rewrote the mutated line, the find string was re-anchored to the new line with the same meaning
(`[reanchored]`). The PR test set gained this round's files (`amexCardCadence`, `spineParity`).

**58 of 58 caught** — the reviewer's 44 (16 survived round 1) and 14 for round 2's fixes. 9 re-anchored.

| Mutation | Result | Caught by (one of the failing tests) |
|---|---|---|
| M1 no confirmed-match step | caught | M2 pending/posted test; ledger non-vacuity; conflict tests |
| M1b unplanned checked before the match | caught | "an unplanned flag on a confirmed match gets its own conflict name" |
| M2 weekly before monthly | caught | "monthly beats weekly"; property test |
| M3 reimbursable before the flags | caught | property test (spec model) |
| **M4** drop `reimbursableIsSpend` (round 1 survivor) | caught | "a reimbursable row that is a card payment is still a card payment" |
| M5 bank noise as spend | caught | "bank-noise pattern folds into transfer" |
| M6 card payment as debt | caught | "isExternalCardPayment wins over a confirmed match" |
| M7 an inflow is never income | caught | "a real deposit in an income category is income" |
| **M8** conflict order swapped (round 1 survivor) | caught | "a confirmed match on a row flagged unplanned AND weekly/monthly reports unplanned_on_matched" |
| M9 no card timing | caught | "an Amex ledger row is 'card'" |
| M10 override ignored `[reanchored]` | caught | "uses that week's override when one is set" |
| M11 excluded category as transfer | caught | "an excluded category wins over allowance flags" |
| M12 a coverage outside the list | caught | property test; "needs_classification" |
| M13 flag conflict silent | caught | "a weekly flag on a confirmed match is reported" |
| M14 debt payment as transfer | caught | "a tagged debt payment wins over allowance flags" |
| M15 monthly uses the weekly override `[reanchored]` | caught | "monthly has no per-period override" |
| **S1** monthly dropped from the sum (round 1 survivor) | caught | randomized ledger windows; "what each coverage adds" |
| S2 weekly dropped from the sum | caught | randomized ledger windows |
| S3 unplanned dropped from the sum | caught | randomized ledger windows |
| S4 needs_classification dropped from the sum | caught | randomized ledger windows |
| **S5** default mode flipped `[reanchored]` (round 1 survivor) | caught | "no mode given is 'today'"; M2 test |
| S6 reimbursable counted | caught | "forward counts the flagged one only — a plain reimbursable row stays out" |
| S7 no rounding | caught | randomized ledger windows |
| B1 default mode flipped `[reanchored]` | caught | "today and the classifier's today mode bucket it nowhere" |
| B2 replaced pending rows not skipped | caught | randomized comparison; "a pending row a posted row replaced is counted nowhere" |
| B3 monthly bucketed as weekly | caught | randomized comparison |
| B4 sub-bucket dropped | caught | randomized comparison |
| **B5** no `effectiveFiling` (round 1 survivor) | caught | randomized comparison; "a bare posted row buckets under the weekly flag and slice it inherits" |
| B6 matched branch off `[reanchored]` | caught | randomized comparison; decision-12 test |
| C1 extra statuses count as matched | caught | "excludes a resolution that is not matched or partial" |
| **C2** no resolution household filter (round 1 survivor) | caught | "a resolution filed under another household never marks this household's row matched" |
| C3 overrides not read | caught | "reads the standing amounts and the overrides map" |
| C4 bounded by occurrence date `[reanchored]` | caught | "includes a matched transaction dated in range, by its OWN date" |
| **C5** checking account always null (round 1 survivor) | caught | "resolves the tracked checking account's external id"; spine classifier test |
| **C6** empty cadence map (round 1 survivor) | caught | "maps every discovered Amex card to its cadence" |
| **C7** empty pending pairs `[reanchored]` (round 1 survivor) | caught | "the loader's own read finds the pair"; randomized ledger |
| C8 unplanned amount zero | caught | "reads the standing amounts" |
| **A1** Blue default weekly (round 1 survivor) | caught | "with no explicit cadence, a Blue card bills monthly"; loader cadence map |
| **A2** explicit cadence ignored (round 1 survivor) | caught | "the owner's explicit cadence wins, in both directions" |
| **A3** card names ignored `[reanchored]` (round 1 survivor) | caught | "reads the display names…"; `computeWeeklyPayoff` cards |
| **A4** excluded ids ignored `[reanchored]` (round 1 survivor) | caught | "reads the display names and the 'not mine' charge ids" |
| **A5** liability-kind filter off (round 1 survivor) | caught | "a credit account whose liability is not a credit card is not a card" |
| **A6** Blue brand regex broken (round 1 survivor) | caught | "brand comes from the display name" |
| **A7** type filter off (round 1 survivor) | caught | "a depository sub-account on the same Amex login is not a card" |
| R2 spend: today-mode reimbursable gate off (M1) | caught | randomized ledger windows; M1 test |
| R2 allowance: today-mode reimbursable gate off (H1) | caught | randomized comparison |
| R2 no match carried through supersede (M2) | caught | M2 tests |
| R2 no lookback before the range (M2) | caught | "…though the pending row is dated before the range" |
| R2 in-range filter off (M2) | caught | "a matched transaction dated in the days read before the range … is not in the range's set" |
| R2 no transaction household filter (L2) | caught | "a resolution in this household that names another household's row is ignored" |
| R2 pre-read pairs ignored (L1) | caught | "pre-read pairs are used exactly as handed in" |
| R2 preferences not handed to `discoverAmexCards` (L1) | caught | "reads the owner's settings row once" |
| R2 debt-category ids empty (L1) | caught | "categoriesById carries name, debt link and kind" |
| R2 pre-read preferences ignored (L1) | caught | "pre-read preferences are used exactly as handed in" |
| R2 tier-2 set ignored (M3a) | caught | "a tier-2 pair on an unflagged row reads bill_matched" |
| R2 tier-2 overrides flags (M3a) | caught | "a tier-2 pair never overrides an allowance flag"; property test |
| R2 `parseFloat` parsing (L3) | caught | "not a finite number falls back"; "agrees with the Allowances page's own formula" |
| R2 no week-start check (L3) | caught | "a key that is not a week start on the household clock is ignored" |

## What must not change

- `classifyOutflow`, `isRealSpend`, `isRealIncome`, `spendAmount` (`spendingRule.ts`) — including the description
  patterns flagged above, until the owner decides.
- `classifyCashRows`/`isBankRow` (`cashRows.ts`) — `classifyMovement`'s checking timing calls `isBankRow` directly.
- `computeWeeklyPayoff`'s output — the cadence extraction stays a move; change card discovery once, in
  `amexCardCadence.ts`.
- `buildSpendingFacts`'s and `aggregateBudgetMonth`'s returned figures — the parity helpers sit beside them.
- `CARD_LEDGER_SOURCES` (`householdMoney.ts`) = `AMEX_TXN_SOURCES` (`amexAnchor.ts`), pinned by `moneyContext.test.ts`.

## How PR8r/PR10 will use this

1. Call `loadMoneyContext(householdId, range, { supersede })` once per request in `routes/spine.ts`,
   `routes/reports.ts` (via `buildSpendingFacts`) and `routes/budget.ts`, handing in the pairs where the route already
   has them.
2. Supply `tier2PairedTxnIds` from the match tiers.
3. **Decide the reimbursable step order first** (the owner's rule sides with today), then switch `buildSpendingFacts`'s
   household accumulation to `classifierHouseholdSpend`'s `"forward"` rule — decision 12 becomes visible there.
4. Switch `aggregateBudgetMonth`'s buckets to `classifierAllowanceRows`: the allowance card then drops the classes
   listed above, and Spending and the card move together from one classifier. The owner's answer on the flagged
   description patterns should land before this.
5. Read `everydayPlan` server-side wherever the allowance cap is computed, and bring `command-center.tsx` onto the same
   parsing.
6. Consume `timing` where a figure needs to know whether a row already moved cash; add "via an Amex payoff on date Y"
   with the hooks.

## Open questions

- **Reimbursable + flag:** keep the specified precedence (a flag outranks `reimbursable`) or put `reimbursable` first,
  as the owner's 2026-09-15 rule reads? One-line change; mode `"today"` and the tests show both answers.
- **The four description patterns** listed for the owner: keep excluding, or tighten (a change to `classifyOutflow`
  that moves Spending's figures, measured first)?
- **Refunds:** neither today's card nor the classifier nets a refund against its envelope; today only adds a $0 row.
  Whether a refund should reduce an allowance's spend is not decided anywhere yet.
- `checkingAccountExternalId` reuses `resolveLedgerAccounts` with no explicit account (the snapshot account). A
  household mid-way through a bank switch resolves to the snapshot's account only.
- "Unresolved plans" (decision 7's second half) are not classified here; PR10 decides how a plan slots in.

## Verification

Round 2, on the merged tree (`b7106660`, `main` at `9aad763` merged in; this note is the only later change):

- `pnpm run typecheck` — clean (on its own before the last merge, and again as the first step of `pnpm run build`).
- Web tests, `CI=true pnpm --filter h2budget exec vitest run`: `TZ=UTC` 141 files, 1,235 passed, 3 skipped;
  `TZ=America/Chicago` 141 files, 1,236 passed, 2 skipped.
- API tests, the full suite against `h2budget_test_prh` under `caffeinate -i` (`CI=true TZ=UTC`): 151 files, 1,591
  passed, 7 todo. Round 1 reported 2,020: its own 5 test files held 546 tests, 500 of them one row each of the property
  test; round 2's 6 files hold 111 (the property test is one test over 6,000 rows), plus 1 new test in spine parity.
  The rest of the difference is `main`'s merges.
- `pnpm run build && node scripts/check-entry-graph.mjs` — landing route 575.7 KB raw (173.4 KB gz), budget 580 KB; no
  recharts on the open path; react-dom confined to `vendor-react-*`.
- Codegen: `pnpm --filter @workspace/api-spec run codegen`, then `git status` — no drift.
- Golden: `git diff --stat origin/main -- '*golden*' '*.snap'` is empty; the golden tests pass in the full suite.
- Fails-before: 36 of the round-2 tests fail on `26db504`'s source; mutations: 58 of 58 caught (table above).

Round 1 (for the record): typecheck clean; web 1,148 (UTC) / 1,149 (Chicago); API 150 files, 2,019 passed, 7 todo;
landing route 574.4 KB.
