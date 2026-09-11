# PR7 — One spending rule: a card payment is never spending twice

Codex work-order points **7** (spending and checking cash are distinct) and **9** (what the spending numbers mean), plan
PR7. Base: `main` = `b93c01e`. Plan: `~/.claude/plans/h2-budget-work-serene-pebble.md`. Brad's decision 5: card payments
are recognized automatically, **in spending totals only**; nothing is re-tagged; one click marks a row "this was a
purchase".

## The problem

**A payment to a credit card counted as spending.**
- The purchases were already counted when they hit the card. The payment from checking then counted them again.
- `isRealSpend` only screened a short bank-noise list ("ach pmt", "web id:", "autopay"…). Capital One ("CRCARDPMT"), Apple
  Card, Discover, Citi, Synchrony and similar strings passed straight through. The transfer heuristic that used to catch
  them is empty on purpose (#666).
- **Example (household scenario S10):** $150 "CAPITAL ONE CRCARDPMT" filed under Misc / Buffer. The spine said **$424.00**
  spent this week; the truth is $274.00.
- Codex's check: $100 of groceries on a card plus a $100 payment from checking showed **$200** of spending.

**Four smaller holes in the same predicate.**
- A reimbursable charge counted as spending.
- An outflow tagged to a debt (`transactions.debt_id`) counted, if its category was a plain expense.
- The user's own `isExternalCardPayment` flag and Plaid's `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` category were ignored.
- A row whose category had been deleted counted **nowhere**: not spend, not uncategorized, not excluded.

**Two rules, not one.** Categorized purchases (`isRealSpend`) and the uncategorized bucket (`isUncategorizedSpend`)
repeated the checks separately, and the Spending facts loop repeated them a third time for the excluded panel.

## What changed

**One classifier, `classifyOutflow()`** (`lib/spendingFilter.ts`, pure). Every outflow gets exactly one kind. First match
wins:

| # | Rule | Kind |
|---|---|---|
| 1 | `isTransfer` | transfer |
| 2 | `debtId` set | debt payment |
| 3 | `isExternalCardPayment` | card payment |
| 4 | category linked to a debt | debt payment |
| 5 | excluded category name (Transfer, Transfers in/out, Ignore, Reimbursement, "Uncategorized — transfer") | excluded category |
| 6 | income category | income |
| 7 | `reimbursable` | reimbursable |
| 8 | `pfc_detailed = LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` | card payment |
| 9 | `CARD_PAYMENT_PATTERNS` (exported from `lib/mappingSeed.ts`) | card payment |
| 9b | the pre-PR7 bank-noise patterns, unchanged | bank noise |
| 10 | otherwise | spend: categorized, or uncategorized when there is no category or it was deleted |

- **The system "Uncategorized" category is not excluded.** A row there is spend, as before.
- **Wrappers.** `isRealSpend` is `spend && categorized`; `isUncategorizedSpend` is `spend && !categorized` (it now takes
  the category context, so it can see a deleted category).
- **Every field the rules read is required on `SpendTxn`.** A caller that forgets to select `debtId`, `reimbursable`,
  `isExternalCardPayment`, `pfcDetailed` or `isTransferUserOverridden` fails to compile rather than classify with a
  default. All four callers were updated: `spendingFacts`, `behaviorFacts`, `amexAnchor`, `billsOneOff`.
- **`CARD_PAYMENT_PATTERNS`:** `crcardpmt`, `capital one mobile pymt`, `applecard gsbank`, `goldman sachs apple`,
  `discover e-payment`, `citi card online`, `credit one bank`, `synchrony paypal`, `synchrony ashley`, `paypal paymthly`,
  `menards big card`, `amex epayment`, `amex ach pmt`, `american express ach`.
  - Matched case-insensitively with runs of whitespace collapsed, since Chase pads raw strings.
  - They are the seed mapping rules' card-payment patterns, minus merchant names (see Deviations).

**"This was a purchase."** A row with `isTransferUserOverridden=true` and `isTransfer=false` skips rules 8–9 only.
- Rules 1–7 are recorded facts (flags, tags, categories) and still apply.
- Bank noise (9b) still applies, as it did before PR7. So the override can never count a row main's rule did not already
  count.
- The server honours it now. **No new per-row UI toggle in this PR** (see Deviations, point 1).

**`/reports/spending-facts`** (`lib/spendingFacts.ts`) runs each row through `classifyOutflow` once.
- **New `householdSpend {total, transactionCount}`** = categorized + uncategorized spend.
- **`realSpend`** is its categorized part, and still feeds `byCategory`, `byMerchant`, `dailyBuckets`, `dailyNet`,
  `dayOfWeek` and `monthlyTrends`.
- **New `excluded.cardPayments` and `excluded.reimbursable`**, beside the four existing buckets. Bank noise goes to
  `transfersTotal`, as before.
- **`unplanned`** is required in OpenAPI and counts any UN-flagged purchase through the same rule.
- It selects the five columns the rule reads. Codegen was run and the generated `api-zod` / `api-client-react` files are
  committed.

**The spine.**
- `spentWeek` / `spentMonth` = `buildSpendingFacts().householdSpend.total`, the same call the report makes.
- The Banking strip ("Household spending this week/month", `chase-insight-strip.tsx`) reads the same field, so it still
  agrees with the Command Center tiles. Its help text now says what is in and out.

**The Amex weekly payoff** (`lib/amexAnchor.ts`) uses the same rule with one option, `reimbursableIsSpend`. A reimbursable
charge is still owed to Amex, so it stays in "what to pay this card".

## Deviations from the plan, and why

1. **The override flag does not mean "this was a purchase". Needs the lead's decision.**
   - `PATCH /transactions/:id` sets `isTransferUserOverridden=true` (and `isTransfer=false`) whenever the body carries a
     non-null `categoryId`, not only when the user toggles the Transfer flag (`routes/transactions.ts`, #479). POST does
     the same when the Transfer category is picked.
   - The flag therefore means "the user decided this row's transfer status **or picked its category by hand**".
   - **Consequence:** a card payment the user hand-categorized into a non-debt category (e.g. Misc / Buffer) carries the
     override. It **still counts as spending**, as it did on main.
   - Rows categorized by a mapping rule (sync, import, bulk re-categorize) do not set the flag and are recognized.
   - I kept the plan's reuse because it matches the route's own stated meaning ("the user disagreeing with any
     auto-Transfer heuristic"), and it can never raise a total above main's.
   - **A true one-click override needs its own marker.** Options: a new boolean column (DDL, needs approval), or a jsonb
     id list in `settings.preferences`. Every jsonb read would have to load it, and any stale `preferences` write would
     wipe it.
   - **Not measured:** how many such rows production holds. That needs a read-only query Brad approves, e.g. outflows
     with `is_transfer_user_overridden AND NOT is_transfer` whose description matches the patterns or whose
     `pfc_detailed` is the card-payment category.
   - **The UI toggle was skipped** for the same reason. The existing "Reset to auto" (`clear-transfer-override`) already
     undoes it.
2. **The bank-noise patterns stay, as rule 9b, and the override does not skip them.** The plan's list omits them.
   Dropping them, or letting the override skip them, would count rows main excluded ("ACH PMT … WEB ID:" bills,
   "AUTOPAY"). The plan's figures-that-move list does not include that.
3. **Pattern list trimmed.** The seed rules also send "MATTRESS FIRM" and "AFFIRM" to Misc / Buffer. Those are merchant
   names, so a store charge would be dropped from spending; they are left out. "NELNET" and "DEPT OF ED" are student
   loans, not cards. A unit test pins that every other seeded card-payment pattern is recognized.
4. **The Amex payoff keeps reimbursable charges** (`reimbursableIsSpend`). Reason above.
5. **Field names follow the plan literally:** `excluded.cardPayments` and `excluded.reimbursable`, not `…Total` like their
   siblings.
6. **Which surfaces moved to `householdSpend`:** the spine and the Banking strip, which show "household spending" and must
   agree. The Reports hub tile and the Spending page's "Total real spend" stay on `realSpend`, with the uncategorized
   banner beside it. The hub's own comment pins it to the Spending page, and both are labelled real spend.
7. **Not done: pending/posted pairs** (PR4c's note hands "spending totals should not count both halves" to PR7). PR4c is
   not on `main` (`fix/pending-superseded-by-posted` is unmerged), so its pairing rule is not available here. Listed
   under Left for later.

## Figures that should move

**Live, wherever household spending shows** (Command Center "Spent this week/month" via the spine, the Banking strip):
- **Down** by card payments: flagged, Plaid-classified, or matched by description.
- **Down** by outflows tagged to a debt and by reimbursable charges.
- **Up** by uncategorized purchases, including rows whose category was deleted.

**`realSpend`** (Spending page total, byCategory/merchant/day-of-week/monthly charts, dailyNet, Reports hub tile): down by
card payments, debt-tagged outflows and reimbursable charges. **Never up**: uncategorized stays its own bucket.

**Other surfaces:**
- **Unplanned:** down by any card payment, debt-tagged or reimbursable row flagged UN. Up by a UN row whose category was
  deleted.
- **Habits (behavior facts):** splurge, most-visited, streaks and days-since exclude card payments and debt-tagged
  outflows. Reimbursable rows were already dropped there.
- **Amex weekly payoff (`weekCharges`):** down only by a charge on the card that is flagged `isExternalCardPayment`,
  tagged to a debt, Plaid-classified as a card payment or matching a card-payment string. Reimbursable and uncategorized
  charges are unchanged.
- **`excluded` panel (API only; no screen reads it):**
  - two new buckets;
  - a transfer tagged to a debt now lands in transfers (rule 1 before rule 2);
  - an outflow in an income category that matched bank noise is no longer counted in transfers.

**Tests, before → after:**

| Test | Before (main) | After |
|---|---|---|
| Household scenario S10, spent this week | 424.00 (pinned as known-wrong) | **274.00** |
| Codex check: $100 Amex groceries + $100 "CAPITAL ONE CRCARDPMT" | 200.00 spending (card payment counted) | **100.00**; `excluded.cardPayments` 100.00 |
| Spine parity, spent week/month | spine = `realSpend.total` | spine = `householdSpend.total` (same fixture values; no uncategorized row) |
| Household clock, unplanned spending, spending-facts income | unchanged | unchanged |

**Not measured:** the production figures. That needs a read-only query Brad approves.

## Must not change

- **Budget page `plannedTotal` / `planBySource`:** `routes/budget.ts` and `lib/budgetFacts.ts` import nothing from the
  spending rule. `budgetPlanBySource` passes.
- **Cash today and the forecast:** `cashSignal`, `forecastLedger` and `routes/forecast.ts` do not import it. Golden,
  cash-signal, household-scenario cash and review columns, and spine bank parity all pass unchanged.
- **Landing:** `landing.tsx` untouched and still shows no dollar figures.
- **No stored data re-tagged:** the integration test reads the card-payment row back after classification. `isTransfer`,
  `isExternalCardPayment` and `categoryId` are unchanged, and no route writes anything new.
- **No new dependency; no schema or DDL change** (`lib/db` untouched).

## Residuals

- **Hand-categorized card payments still count** (Deviation 1).
- **A pattern list, not a certainty.**
  - A card issuer not on the list still counts until Plaid's category or the user's flag catches it.
  - Plaid's detailed category is only on rows synced since #636.
  - A description containing one of the strings would be dropped even if it were a purchase. None of the patterns is a
    merchant name; there is a test for that.
- **Browser-side mirrors not moved:**
  - The Spending page's Recategorize popover (`SpendingPage.tsx` `isUncategorizedSpendTxn`) still screens only the
    bank-noise list, so it can list an uncategorized card payment the banner no longer counts. The list is rows to
    fix, not a total.
  - The Allowances/bucket helpers (`bucketSpend.ts`, `discretionarySpend.ts`) keep their own flag-based rules. They count
    only rows the user explicitly tagged.
- **Legacy noise that is really a card payment** ("chase credit", "bk of amer", "wells fargo card", "credit card pmt")
  sits in `excluded.transfersTotal`, not `cardPayments`. Totals are unaffected.
- **`dailyNet` and the charts use categorized spend only**, so they do not sum to `householdSpend` while anything is
  uncategorized.
- **Pending/posted pairs** the sync left unlinked still count twice in spending (PR4c covers cash only).

## Tests

- **New `lib/spendingFilter.test.ts`** (25):
  - **the 12-row table**, one row per rule in order, each asserting the kind, the rule and that both wrappers agree;
  - first match wins, inflows, manual-Amex positive charges, a deleted category, the system Uncategorized category;
  - the override: it skips rules 8 and 9, never beats rules 1–7 or 9b, and a user-set transfer stays a transfer;
  - the Amex payoff option;
  - `CARD_PAYMENT_PATTERNS`: every seeded card-payment pattern is recognized, store purchases are not, and the list is
    normalized.
- **New `__tests__/spendingCardPayments.integration.test.ts`** (3), through `/reports/spending-facts` and `/spine`:
  - **Codex check:** $100 Amex groceries + $100 card payment → `householdSpend` and `realSpend` **100**,
    `excluded.cardPayments` 100, spine week and month **100**.
  - **Override:** "this was a purchase" → 200 on the report and the spine together; reset → 100; the row is never
    re-tagged.
  - **One mixed ledger, every bucket:** categorized, uncategorized, deleted category, reimbursable, a Plaid-classified
    payment with a bland description, a UN-flagged card payment, bank noise. The buckets sum to every dollar that left
    (710.00).
- **Switched on:** household scenario S10, 274.00. Its `it.todo` is removed, and the fixture and the contract document
  are updated. No step carries a known-wrong value now.
- **Changed:**
  - `spineParity` now compares the spine to `householdSpend`, and adds `householdSpend = realSpend + uncategorized`. It
    is stricter, not looser.
  - `spendingFilterIncome.test.ts`'s row helper fills the new required fields.
  - The web mocks in `chaseInsightStrip.test.tsx` and `commandCenter.test.tsx` carry `householdSpend`, the real payload
    shape.
- **Failing before:** the new and changed tests were run against `main`'s seven source files (`git checkout origin/main --`
  on the spending lib, the three callers and `routes/spine.ts`), then restored. **All four files fail there:**
  - household scenario S10 on the number: **424 vs 274**, a difference of exactly the $150 card payment;
  - the three integration tests and the spine parity test at the missing `householdSpend`;
  - all 25 unit tests, because `classifyOutflow` / `CARD_PAYMENT_PATTERNS` do not exist on main.

## Verification

- **Full API suite:** **122 files, 929 pass, 7 todo** (main `b93c01e`: 120 files, 901 pass, 8 todo). That is +25 unit
  and +3 integration tests, and one todo switched on.
- **Full web suite:** **118 files, 917 pass** (same as main).
- **Workspace typecheck:** exit 0.
- **Workspace build:** exit 0.
- **Landing bundle guard:** **572.5 KB of 580**, unchanged.
- **Codegen:** re-run after commit, no diff.

## Left for later

- **A dedicated "this was a purchase" marker, plus its per-row toggle** (Deviation 1). A column needs DDL approval; the
  jsonb alternative is described above.
- **Spending totals should not count both halves of a pending/posted pair** once PR4c's `pairPendingWithPosted` is on
  `main`.
- **PR10:** needs classification and the Codex point-9 states. `householdSpend` and `unplanned` are the inputs.
- **Move the Spending page popover's client-side filter onto a server field** (or the `uncategorized` SQL filter plus the
  card-payment rule).
