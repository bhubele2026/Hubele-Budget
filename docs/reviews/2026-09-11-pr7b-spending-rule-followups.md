# PR7b — Spending rule follow-ups: pending pairs count once, more card-payment strings

This PR covers the reviewer's follow-ups to PR7 (`docs/reviews/2026-09-11-pr7-one-spending-rule.md`).

- **Base:** `main` = `56596f3`, which includes PR4c (`2874a7b`), PR4e and PR7.
- **Owner decision (unchanged):** card payments are recognized automatically, in spending totals only. Nothing is re-tagged.

| Commit | What it does |
|---|---|
| `28b392a` | Pending/posted pairs count once in spending, Habits and the Amex weekly payoff; `excluded.replacedPending`; the popover lists deleted-category purchases |
| `bcdb4fc` | More card-payment strings; generic phrases match only where a payment puts them |
| `1b8f588` | Mono numerals on PR7's three "uncategorized" figures |
| `7c924b2` | This note, and an "Update (PR7b)" section in the PR7 note |
| `6e3d68b` | Review M1, M2, N2, N3: bounded pairing read, read once per spine request; guard tests |
| `30d41cc` | Review L1, N1: a card-payment phrase counts only in a payment's position |
| docs commit | **Review fixes** below |

## The problem

**1. A pending charge and the posted row that replaced it counted twice in spending.** This bug was also on `main`.
- PR4c pairs them (`pairPendingWithPosted`) and keeps them out of cash twice. Nothing in spending read that pairing.
- **The reviewer's case:** a pending $45.00 and its posted $47.40 on one card counted **$92.40** of household and real
  spend. The truth is $47.40.
- **The same double count appeared in:**
  - the spine (`spentWeek` / `spentMonth` read the same function);
  - Habits (two visits, not one);
  - the Amex weekly payoff (two charges owed).

**2. Card-payment strings PR7 missed:**
- "Payment to Chase card ending in 1234" (Chase's own wording)
- "US BANK CREDIT CARD PAYMENT"
- "WF CREDIT CARD AUTO PAY"
- "TARGET CARD SERVICES PAYMENT"
- glued "CRCARDPMT5KX9ABC", which whole-word matching cannot see

The same review flagged a NIT: the generic phrase "credit card pymt" matched a purchase, "CREDIT CARD PYMT SUPPLIES INC".

**3. PR7's three new figures did not use mono numerals,** which CLAUDE.md requires wherever money renders:
- the Banking strip's "Includes $X not yet categorized";
- the Spending page's "+ $X uncategorized";
- the Reports hub tile's "+ $X uncategorized".

**4. The PR7 note said PR4c was not on `main`.** It merged as `2874a7b`.

**5. PR7 residual: the popover could not list a purchase whose category was deleted.**
- The banner counted it; the list asked for `category_id IS NULL` only.
- `routes/budget.ts` nulls the rows when it deletes a category. The workbook importer and `routes/avalanche.ts` do not.

## What changed

### 1. Pending/posted pairs

**`lib/supersededPending.ts` → `loadSupersededPendingIds(householdId)`:** the ids of every pending row a posted row
replaced. The answer is the one PR4c's pairing gives over the household's **whole ledger**, without reading the whole
ledger. As revised after review M1:
- **One query joins each pending row to the posted rows that could replace it.** It tests only conditions
  `canSupersede` also requires, loosened where SQL and JS round differently:
  - same household and Plaid account;
  - posted, dated 0–7 days after, created after the pending row;
  - same non-zero sign;
  - |pending| ≤ |posted| ≤ 1.30 × |pending| + $1.01.
- **Descriptions are left to `canSupersede`.**
- **`pairPendingWithPostedAmong`** runs PR4c's pairing loop, offering each posted row only its candidates.
  `pairPendingWithPosted` now delegates to it with every pending row as a candidate, so cash pairing runs the same loop.
- **Why the result is exact:**
  - every pending row `canSupersede` would accept is a candidate;
  - a row with no candidate can take nothing or be taken by nothing;
  - ranking is a total order, so candidate order changes nothing.
- **The spine reads the set once** and hands it to both spend windows. `/reports/spending-facts` loads the same set
  itself.

**Callers.** The replaced pending row is dropped by all three production callers of the spending rule:
- **`buildSpendingFacts`** (the spending report, so the spine, the Banking strip, the Spending page and the Reports hub).
  The row counts nowhere: not spend, not income, not any excluded bucket.
  - Its outflow amount is shown as **`excluded.replacedPending`**, so the panel still accounts for every dollar that left.
  - OpenAPI plus codegen; the generated `api-zod` / `api-client-react` are committed.
- **`buildBehaviorFacts`** (Habits): range rows and streak rows.
- **`computeWeeklyPayoff`** (the Amex weekly payoff).

The charge counts once, on its posted row, with that row's date, amount and classification. No row is deleted or
re-tagged.

### 2. Card-payment strings

These changes are in `lib/avalanche-core/src/spendingRule.ts`. Rule 9 now has three parts.

**`CARD_PAYMENT_PATTERNS`** (issuer phrases, whole words, as in PR7) gains four phrases:
- `payment to chase card ending in`
- `us bank credit card payment`
- `wf credit card auto pay`
- `target card services`

It loses `credit card pymt` (see the generic phrases below).

**`CARD_PAYMENT_WORD_PREFIXES` = `["crcardpmt"]`:** a word that STARTS with an issuer code.
- "CRCARDPMT5KX9ABC" matches.
- "XCRCARDPMTX" and "ABCRCARDPMT5KX9" do not.

**`GENERIC_CARD_PAYMENT_PHRASES`** are `credit card pymt`, `credit card payment` and `credit card auto pay`.

**Every phrase (issuer, generic, or glued code) counts only in a payment's position.** The first revision applied
this to generic phrases only; review N1 and L1 widened it:
- **never after a leading card processor:** "SQ *", "PAYPAL *", "TST*", "SP ", "TOAST", "STRIPE", "CLOVER", "POS".
  The exception is a phrase that itself starts the description: "PAYPAL *PAYMTHLY" is PayPal Credit's own payment;
- **right after an ACH entry-description label**, whatever follows: Chase "… CO ENTRY DESCR:CREDIT CARD PAYMENT …",
  BofA "… DES:CREDIT CARD PYMT …";
- **or followed by nothing but references:**
  - words containing a digit;
  - ACH boilerplate (`ppd`, `web`, `id`, `ach`, `pymt`, `thank you`, …);
  - the one word after an ID label ("PPD ID: WFCCAUTOPY");
  - `CO ID` / `ORIG ID` / `IND ID`;
  - up to four name words after BofA's `INDN:`;
  - "to <issuer or network>" ("TO VISA", "TO CAPITAL ONE").
- **A glued code** ("CRCARDPMT5KX9ABC") also needs a digit in the rest of the word, so "CRCARDPMTSHOP" is not a payment.

"BEST BUY CREDIT CARD PYMT 0412 WEB ID: 1234" and "FIRST NATIONAL DES:CREDIT CARD PYMT ID:1234 INDN:JANE DOE CO
ID:9999 PPD" are payments. "CREDIT CARD PYMT SUPPLIES INC", "TARGET CARD SERVICES GIFT CARD" and "SQ *CREDIT CARD
PAYMENT" are purchases.

- **It errs toward missing, on purpose.** A payment it misses can be flagged by the user (`isExternalCardPayment`,
  rule 3). A purchase it wrongly caught cannot be put back, because there is no "this was a purchase" override yet.
- **PR7's 32-purchase table** is untouched and green. A second table adds 11 purchases built to trip the new phrases.

### 3. Mono numerals

- **Where:** each of the three amounts renders in a `<span className="font-mono tabular-nums">`, as `tdNum` and `Stat` do.
- **Kit types widened:**
  - `Stat.hint` (`ui.tsx`) is now `ReactNode` instead of `string`;
  - `ReportTile.sub` (`reports.tsx`) likewise.
- Every existing caller passes a string, and `Stat` still renders nothing for an empty hint.
- The existing text assertions ("+ $24.50 uncategorized", "$40.00") pass unchanged.

### 4. The PR7 note

It gains a short **Update (PR7b)** section pointing here. The original text is not rewritten.

### 5. The popover

`GET /transactions?uncategorized=true` now means: no category, **or** a category id that no longer exists in this
household (`NOT EXISTS` against `budget_categories`, household-scoped like the spending rule's context).
- **Only caller:** the Spending page popover.
- **No spec change:** the parameter has no description to update.
- The popover's browser-side rule (`isUncategorizedSpendRow`) already treated a dangling id as uncategorized.

## Deviations, and why

1. **Pairing reads the whole ledger's pairable rows, not "the rows in scope plus 7 days".** The work order suggested
   the window plus a 7-day lead. That is still window-dependent, because pairing is one to one and oldest-first.
   `pairPendingWithPosted` over the test fixtures (scratch script, not committed):

   | Case | Whole ledger | Window rows only | Window + 7 days |
   |---|---|---|---|
   | Two $45.00 meals pending (9/05, 9/06), one posts 9/07 at $47.40; week 9/06–9/12 | **92.40** | 47.40 | 92.40 |
   | Chain: $5.00 pending 8/13, 8/17, 8/23; $6.00 posted 8/18, 8/24; week 8/23–8/29 | **11.00** | 6.00 | 6.00 |

   With the whole ledger, adjacent windows add up exactly: 0 + 6 + 11 = 17 over three weeks.

   **Corrected after review M1.** The first revision said the cost was "one indexed query per call, bounded by how
   many pending rows exist". That was overstated:
   - a pending row every few days pulled nearly every posted row into the read;
   - the pairing then ran quadratic in JS.

   The read is now bounded by date **and** amount, the pairing by candidate pairs, and the spine reads it once.
   Measured figures are under **Review fixes**.
2. **Applied beyond `buildSpendingFacts`:** also to Habits and the Amex weekly payoff. Those are the other production
   callers that total rows through the spending rule. `billsOneOff.computeOneOff` has no production caller and is left
   alone.
3. **New API field `excluded.replacedPending`.** Without it, the PR7 property "every outflow lands in exactly one
   bucket" would silently break for pairs.
4. **The replaced pending row leaves income and every bucket, not only spend.** It is not a transaction, so a pending
   deposit its posted row replaced is not income twice.
5. **The generic phrase was tightened by position, not by a word list.** A blocklist of business words ("INC",
   "SUPPLIES") can always be beaten by the next merchant.
6. **Popover (item 5) fixed server-side** by widening the existing filter, rather than adding a new parameter.
7. **Kit type change:** `Stat.hint` and `ReportTile.sub` accept a node.
8. **`spendingTotalHint.test.tsx` mocks four recharts names locally** (`AreaChart`, `Area`, `BarChart`,
   `ReferenceLine`). `reportsShared.tsx` uses them and `test-recharts-stub.tsx` lacks them; the shared stub is not
   edited.

## Figures that should move

**Live**, only where the ledger holds a pending row its posted row replaced, or a description the rule now reads
differently.

**Pending/posted pairs.**
- **Household and real spend fall** by the replaced pending outflow: spine `spentWeek` / `spentMonth`, the Banking strip,
  the Spending page total and its charts, and the Reports hub tile. Uncategorized and unplanned move the same way when
  the pending half sat there.
- **`realIncome` falls** by a replaced pending deposit.
- **Excluded buckets fall**, and `excluded.replacedPending` rises, by a replaced pending card payment, transfer or other
  excluded outflow.
- **Habits:** visits, splurges, daily and hourly totals, and streak days lose the pending half.
- **Amex weekly payoff** (the Amex band and the Avalanche card config): `weekCharges` and `chargeCount` lose it.
- ⚠️ **A closed window can fall later.** A pending charge dated in last week that posts this week now counts this week
  only, so last week's figure drops once it posts. The Amex weekly payoff is included (see Residuals).
- ⚠️ **The Budget page now disagrees with Spending wherever a pair exists** (review M2).
  - **What still double-counts:** the Budget page's per-category actual (`actualAmount` / `sourceBreakdown`,
    `routes/budget.ts` ~1897–1925) and its allowance sums (~2135–2160).
  - **Why it's new:** on `main` both pages double-counted, so they agreed.
  - **Reviewer's reproduction, June Dining:** Spending **$124.40**, `/budget/months/2026-06-01` **$189.40**. The
    $65.00 gap is the two replaced pending rows.
  - **Not changed:** it is a Budget-page financial calculation (see **Pending Brad's decision**). A test pins the gap.

**Card-payment strings.**
- **Down:** payments matching the new phrases or the issuer code.
- **Up:**
  - a purchase with a generic phrase in a non-payment position ("CREDIT CARD PYMT SUPPLIES INC");
  - ⚠️ a payment whose generic phrase is followed by a name or other words ("BEST BUY CREDIT CARD PYMT JANE DOE"). PR7
    caught it; now it counts until flagged (see Residuals).
- **Bucket only, totals unchanged:** a row PR7 already excluded as bank noise but that now matches rule 9 moves from
  `transfersTotal` to `cardPayments` ("CREDIT CARD PAYMENT THANK YOU").

**Popover:** also lists rows whose category was deleted. The banner is unchanged.

**Tests, before (`main`'s code) → after:**

| Case | Before | After |
|---|---|---|
| Reviewer's pair, week 10/04–10/10, household and real spend | 92.40 (2 rows) | **47.40** (1 row) |
| The same, spine `spentWeek` and `spentMonth` | 92.40 | **47.40** |
| The same, Habits most-visited merchant | 2 visits, 92.40 | **1 visit, 47.40** |
| Plus five unrelated pending/posted rows (still count) | 302.40 | **257.40** |
| Straddle: week 9/13–9/19 / week 9/20–9/26 / fortnight | 45.00 / 47.40 / 92.40 | **0.00 / 47.40 / 47.40** |
| Two meals pending, one posted: week 8/30–9/05 / week 9/06–9/12 | 45.00 / 92.40 | **0.00 / 92.40** |
| Chain: weeks 8/09, 8/16, 8/23 / three weeks | 5 / 11 / 11 / 27 | **0 / 6 / 11 / 17** |
| Pending payroll deposit + posted, `realIncome` | 1000.00 | **500.00** |
| Amex weekly payoff, `weekCharges` / `chargeCount` | 92.40 / 2 | **47.40 / 1** |
| Popover list `uncategorized=true`, no category + deleted category + live category | 1 row | **2 rows** (banner 22.00, both) |
| June "Eating out", two pairs: Spending / Budget page (**pinned known residual**) | 134.40 / 134.40 | **69.40** / 134.40 |
| PR7b payment strings recognized (18, after review) | 5 of 18 | **18 of 18** |
| PR7b purchase table (23, after review) caught as card payments | 3 of 23 | **0 of 23** |
| "CREDIT CARD PYMT SUPPLIES INC" | card payment | **purchase** |

**Not measured:** the production figures. That needs a read-only production query Brad approves.

## Must not change

- **Cash today and the forecast:**
  - `cashRows`, `ledgerCashRows`, `forecastLedger`, `cashSignal` and `routes/forecast.ts` import none of the touched
    modules;
  - `pairPendingWithPosted` itself is unchanged;
  - in `amexAnchor.ts` only `computeWeeklyPayoff` changed; `refreshAmexAnchor` (plaid sync, workbook import) is untouched;
  - in the full suite, golden, cash-signal, household-scenario, and spine bank and review-count parity pass unchanged.
- **Budget page `plannedTotal` / `planBySource`:** `routes/budget.ts` and `lib/budgetFacts.ts` import nothing touched.
  `budgetPlanBySource` passes.
- **Landing:** `landing.tsx` is untouched and still shows no dollar figures. Landing JS **572.5 KB of 580**; entry chunk
  239.9 KB, unchanged.
- **No stored data changes:** every change is a read.
  - The pair test reads both rows back, pending and posted, amounts intact.
  - The popover change is a `SELECT` filter.
- **No new dependency; no DDL** (`lib/db` untouched).
- **Spine parity:** in the pair test the spine equals the report to the cent for the week and the month, and
  `spineParity.integration.test.ts` passes unchanged.

## Residuals

**False pairs now lower spending too.**
- **The case:** PR4c's disclosed false pair: a still-pending charge paired with a *different* same-merchant charge that
  posted first, within 7 days and 1.30× + $1.
- **Effect:** that pending charge drops out of spending, Habits and the **Amex weekly payoff**, as well as cash. A
  false pair therefore **lowers the payoff**, under-stating what to pay that card until the real charge posts. Short
  labels ("Amazon", "Uber") are the risk.

**Nothing carries over from the pending half.** The category, UN flag or reimbursable flag set on the pending half stays
on that row.
- **Why it matters:** the pending row often survives precisely because the user worked it. Its posted twin can be
  uncategorized.
- **Effect:** household spend is right, but the dollars can move from a category to "uncategorized" until the posted
  row is categorized.
- Carrying them over would be a stored-data change or a read-time merge; that needs an owner decision.

**A closed window's figure can move** when its pending charge posts in the next window (see Figures).
- **This includes the Amex weekly payoff.**
- **The case:**
  - a charge pending on Saturday shows in last week's payoff on Monday;
  - after it posts, it moves into this week's payoff;
  - if last week's payoff was already paid, the charge can be **paid twice**.
- `main` has the same double payment, and PR7b does not make it worse. But "the payoff owes the pair once" holds only
  once the charge has posted, not while it is pending across a week boundary.

**The Budget page disagrees with Spending for a pair** (review M2; see Figures). Its category actuals and allowance
sums still count both halves. Pinned by `spendingPendingPairs.integration.test.ts` ("KNOWN RESIDUAL"). Pending Brad's
decision.

**Cost on a ledger dense with pending rows** (review M1). The read is bounded by pending rows and the posted rows near
them in date and amount, not by ledger size. A synthetic 20,000-posted / 2,000-pending household still took ~0.78 s,
almost all SQL (a hash join on account, then the date and amount filters). There is no index on
(household_id, plaid_account_id, occurred_on); adding one is DDL and needs Brad's go.

**Cash and spending pair over different rows.**
- The ledger pairs the snapshot account's rows from anchor − 7 days; spending pairs the whole ledger's pairable rows.
- In a chain like the one above, they could name a different pending row for the same posted row. Each is internally
  consistent.

**The popover's list does not pair.** It comes from `/transactions`, so an uncategorized replaced pending row is listed
while the banner leaves it out. This is rare: a worked pending row is usually categorized.

**Phrase recall** (after review N1).
- **What now counts as spending until the user flags it:** any phrase, issuer or generic, followed by an unlabelled
  name or free text. Example: "US BANK CREDIT CARD PAYMENT JANE DOE". Without a name list it cannot be told from
  "… PROCESSING CENTER".
- **What still reads as a payment:** the same name after BofA's `INDN:`, or the phrase as an entry description.
- **What PR7 caught:** its phrases anywhere, so some of these read as a card payment on `main`.
- **A payment after a processor-like first word** ("POS", "SP") also reads as a purchase.
- **The trade is deliberate:** a missed payment can be flagged (rule 3), and a caught purchase cannot be put back.
- **Pinned** by the disclosed-name test.

**`target card services` has no payment word.** Any outflow to Target Card Services is treated as a card payment.

**`billsOneOff.computeOneOff`** (no production caller) does not pair.

**Legacy "epay" substring** (PR7 NIT) is unchanged.

**Not measured:**
- the count of unlinked pairs in production;
- how many live descriptions the new phrases and the tightening move;
- the pairing query's cost on the production ledger.

## Tests

**After review:** `spendingFilter.test.ts` is 121; `spendingPendingPairs.integration.test.ts` is 10;
`supersededPending.integration.test.ts` is new (4); `pendingSupersede.test.ts` is +2. Details are under **Review
fixes**. The lists below describe the first revision.

**`lib/spendingFilter.test.ts`, 76 → 103:**
- **14 payment strings recognized:** the reviewer's five, the same issuers in bank layouts, generic phrases with
  references, and an ACH long form;
- **11 purchases not caught:** the NIT, generic phrases inside business names, "US BANK STADIUM", "CHASE CENTER",
  "WF CAFE";
- issuer code at word start only;
- the NIT, "credit card pymt" only in a payment's position;
- the lists test now covers all three lists.

**`__tests__/spendingPendingPairs.integration.test.ts`** (new, 8), through `/reports/spending-facts`, `/spine`,
`/amex/weekly-payoff`, `/transactions` and `buildBehaviorFacts`:
- **the reviewer's pair:**
  - report 47.40 and `replacedPending` 45;
  - spine week and month equal the report;
  - Habits one visit;
  - both rows still in the ledger;
- **unrelated pending rows still count:** a pending row never posted, the same text on another card, and a posted
  amount over 1.30× + $1;
- **a pair straddling a week boundary:** counts in the week it posted, and the weeks add up to the fortnight;
- **the edge:** the older pending row outside the window is replaced, and the second meal inside still counts;
- **a chain longer than 7 days:** three weeks add up;
- **a pending deposit** is not income twice;
- **the Amex weekly payoff** owes the pair once;
- **the popover:** `uncategorized=true` lists the deleted-category row, and matches the banner.

**`__tests__/spendingCardPayments.integration.test.ts`:** the exact `excluded` shape gains `replacedPending: 0`.

**Web:**
- `chaseInsightStrip.test.tsx` and `reportsHubKitRestyle.test.tsx` assert the amount's `font-mono` / `tabular-nums`.
- New `pages/reports/spendingTotalHint.test.tsx` (2): the Spending page total with and without uncategorized spend.

**Fails on `main`'s code.** The source files were checked out from `origin/main`, the tests run, then the source was
restored.
- **All PR7b API source reverted: 25 fail of 115** in the three API files.
  - **All 8 pair/popover tests:**
    - 92.40 vs 47.40;
    - 302.40 vs 257.40;
    - 45 vs 0 at the edges;
    - 1000 vs 500;
    - 92.40 / 2 charges;
    - the popover (1 row).
  - **PR7's ledger test**, on the new key only.
  - **In `spendingFilter.test.ts`:**
    - 12 of the 14 new payment strings ("CREDIT CARD PYMT 0412" and the ELAN string matched `main`'s loose phrase);
    - the NIT purchase;
    - the prefix test, the NIT test and the lists test.
  - **Pass on `main`, as guards should:** the other 10 new purchases.
- **Each server file reverted alone:**
  - `behaviorFacts.ts` → only the Habits assertion fails (2 visits);
  - `amexAnchor.ts` → only the payoff test fails (92.40, 2 charges);
  - `routes/transactions.ts` → only the popover test fails.
- **The four web files reverted: 3 fail of 28**, the three mono assertions. The "no uncategorized" case passes on both.

## Verification

| Gate | After review (`30d41cc`) | First revision (`7c924b2`) | `main` (`56596f3`) |
|---|---|---|---|
| **Full API suite** | **127 files, 1097 pass, 7 todo** | 126 files, 1071 pass, 7 todo | 125 files, 1036 pass, 7 todo |
| **Full web suite** | **120 files, 935 pass** | 120 files, 935 pass | 119 files, 933 pass |
| **Workspace typecheck** | exit 0 | exit 0 | — |
| **Workspace build** | exit 0 | exit 0 | — |
| **Landing bundle guard** | **572.5 KB of 580**; entry chunk 239.9 KB | same | unchanged |
| **Codegen** | re-run, no diff (no spec change in review fixes) | no diff | — |

## Review fixes

First review of `7c924b2`: **REQUEST CHANGES**. No HIGH; the pairing arithmetic, bucket sums, forecast isolation,
household scope and spine parity were confirmed.

| Finding | Fix | Test |
|---|---|---|
| **M1** — the pairing read was unbounded, quadratic in JS, and ran twice per spine request | (1) The spine reads the set once and passes it to both `buildSpendingFacts` calls (`opts.replacedPendingIds`; `.then` on one promise, so a failure rejects the `Promise.all`). (2) One join returns only (pending, posted) pairs that could supersede: account, 0–7 days, created after, same sign, amount band with rounding slack. (3) `pairPendingWithPostedAmong` runs PR4c's loop over each posted row's candidates; `pairPendingWithPosted` delegates to it, so cash and spending share one loop. (4) No DDL; index proposed below. | `supersededPending.integration.test.ts`: equals whole-ledger pairing on a 400-row randomized ledger (two accounts, look-alike merchants, out-of-order arrivals) and on the 92.40 / 11.00 fixtures, exact ids. **Cost guard:** 3,060 rows, 3,000 unrelated, reads **60** rows / **30** candidate pairs, under 5 s. `pendingSupersede.test.ts` (+2): the "among" loop equals the full loop with complete candidates (plus extras, any order); a missing candidate changes the answer, so the precondition is real. |
| **M2** — the Budget page now disagrees with Spending, undisclosed | Budget page **not changed** (financial calculation; needs Brad). Disclosed under Figures and Residuals with the reviewer's numbers; added to **Pending Brad's decision**. | "⚠️ KNOWN RESIDUAL (pending Brad's decision)": June "Eating out", Spending **69.40**, Budget **134.40**, gap 65.00. Written to be updated, not deleted, when Budget adopts pairing. |
| **L1** — BofA's layout and "… TO VISA" regressed | `des` is an entry-description label beside `descr`; `INDN` names (≤ 4 words), `CO ID` / `ORIG ID` / `IND ID` count as references; "to <issuer or network>" is accepted. | Recognized: "FIRST NATIONAL DES:CREDIT CARD PYMT ID:1234 INDN:JANE DOE CO ID:9999 PPD", "CAPITAL ONE DES:CRCARDPMT ID:… INDN:… CO ID:… PPD", "US BANK CREDIT CARD PAYMENT ID:1234 INDN:JANE DOE CO ID:9999 PPD", "CREDIT CARD PYMT TO VISA", "CREDIT CARD PAYMENT TO CAPITAL ONE 1234". |
| **L2** — note residuals missed the Amex payoff | Residuals now name the Amex weekly payoff for closed windows (the Saturday case, possible double payment, same as `main`) and for false pairs (they lower the payoff). | — (note) |
| **N1** — seven purchases newly caught | Every phrase counts only in a payment's position (What changed §2). A leading processor means purchase. A glued code needs a digit. `online` / `mobile` are no longer references. | The seven as purchases, plus "CRCARDPMTSHOP", "TST* CREDIT CARD PYMT 0412", "CREDIT CARD PYMT TO VISA SUPPLIES", "CREDIT CARD PAYMENT TO", an over-long INDN name. Processor test ("PAYPAL *PAYMTHLY" stays a payment). Disclosed test: an unlabelled name reads as a purchase. Every PR7 and PR7b payment case stays green. |
| **N2** — a test depended on another | "pending rows that are not the other half…" has its own week and accounts: **210.00**, `replacedPending` 0. | Passes alone (`-t`), 1 passed / 9 skipped. |
| **N3** — guard tests | Added. | Household scope: the same external account id in two households, 0 candidate pairs each; a control household pairs. **Every bucket**, `replacedPending` included, sums to raw outflow in each of two weeks (587.00, 62.40) and the fortnight (649.40); the weeks add up bucket by bucket. Plus the Budget residual, the cost guard and BofA above. |

**Measured, M1** (scratch comparison, not committed; same synthetic households, statistics refreshed with `ANALYZE` as
autovacuum would; same replaced set in every case):

| Posted / pending | First revision | This revision | Rows read / candidate pairs |
|---|---|---|---|
| 5,000 / 500 | 174 ms | **72 ms** | 2,102 / 2,155 |
| 15,000 / 50 | 165 ms | **27 ms** | 695 / 673 |
| 20,000 / 2,000 | 2,044 ms | **775 ms** (≈ 734 ms SQL) | 16,381 / 33,233 |

- **Stale statistics:** right after a bulk insert, without `ANALYZE`, the planner misjudged both queries. The first
  revision took 2–33 s; this one 84–680 ms.
- **Also measured:** an exact-day join via `generate_series` (so the planner could hash on account and date). It
  planned worse (1,021 ms at 20,000 / 2,000) and was not kept.
- Each spine request halves this again, since the set is read once.

**Fails before this revision.**
- **Against `main`'s rule (`56596f3`): 20 of 121 fail.**
  - **Payment strings:** 13 of the 18 are missed. PR7 did catch BofA's layout, "CREDIT CARD PYMT TO VISA", "CREDIT
    CARD PYMT 0412" and the ELAN string.
  - **Purchases:** 3 of the 23 are caught, among them "CREDIT CARD PYMT SUPPLIES INC" and "TST* CREDIT CARD PYMT
    0412". The seven N1 purchases were already purchases there.
  - **The lists test** fails because the new lists don't exist on `main`.
- **Against `7c924b2`'s rule: 14 of 121 fail:**
  - the three regressed L1 payments;
  - the nine purchases the first revision caught;
  - the processor test;
  - the disclosed-name test.
- **The M1 equivalence and household tests are new behaviour checks.** The first revision's read also gave the
  whole-ledger answer; its cost is the difference (above).
- **The cost guard and `pairPendingWithPostedAmong` do not exist on `7c924b2`.**
- **The Budget residual pins today's behaviour** and passes on `7c924b2` too.

## Pending Brad's decision

- **The Budget page and pending/posted pairs** (review M2). Should the Budget page's category actuals and allowance
  sums drop the replaced pending half, as Spending, Habits and the Amex payoff now do? Until then the two pages differ
  by those rows. The residual test is written to flip when he decides.
- **Index (DDL):** `transactions (household_id, plaid_account_id, occurred_on)`. It would let the pairing join range-scan
  one account's days instead of hash-joining the household's rows on account. Additive; needs his "go".

## Left for later

- **"This was a purchase":** a dedicated column and per-row toggle (PR7's deferral; additive DDL, needs Brad's go). It
  would also let the generic phrases be loosened again.
- **Carry the pending half's category and flags to its posted row**, or show the pair as one row. Owner decision.
- **A read-only production query** (Brad's approval):
  - unlinked pending/posted pairs;
  - rows the new phrases and the tightening move;
  - the pairing query's cost.
- **Pair the popover's list** the way the banner does. It needs a server-side "not a replaced pending row" filter.
- **One pairing scope for cash and spending**, if a chain disagreement is ever seen.
- **Add `AreaChart`, `Area`, `BarChart`, `ReferenceLine` to `test-recharts-stub.tsx`**, so Reports sub-page tests need no
  local mock.
