# PR7 — One spending rule: a card payment is never spending twice

Codex work-order points **7** (spending and checking cash are distinct) and **9** (what the spending numbers mean), plan
PR7. Base: `main` = `b93c01e`. Plan: `~/.claude/plans/h2-budget-work-serene-pebble.md`. Brad's decision 5: card payments
are recognized **automatically, in spending totals only**; nothing is re-tagged.

- **First look:** `aecbf38`, REQUEST CHANGES (one HIGH, two MEDIUM, three LOW, one NIT).
- **This revision:** `0198bb8` plus this note. The findings and what was done are in **Review** below.

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
- An outflow tagged to a debt (`transactions.debt_id`) counted, if its category was a plain expense. Sync only tags the
  payment side (positive amounts on the linked card), so a tagged outflow is a hand-tagged payment.
- The user's own `isExternalCardPayment` flag and Plaid's `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` category were ignored.
- A row whose category had been deleted counted **nowhere**: not spend, not uncategorized, not excluded.

**Three copies of the rule.** `isRealSpend`, `isUncategorizedSpend` and the Spending facts loop each repeated the checks.
The Spending page's Recategorize popover kept a **browser copy** of the bank-noise list.

## What changed

**One classifier, `classifyOutflow()`,** pure, in **`lib/avalanche-core/src/spendingRule.ts`**. The server
(`api-server/src/lib/spendingFilter.ts`, a re-export) and the web app import the same code. Every outflow gets exactly one
kind; first match wins:

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
| 9 | `CARD_PAYMENT_PATTERNS` (also re-exported from `lib/mappingSeed.ts`) | card payment |
| 9b | the pre-PR7 bank-noise patterns, unchanged | bank noise |
| 10 | otherwise | spend: categorized, or uncategorized when there is no category or it was deleted |

- **Recognition is automatic.** Rules 8–9 apply whatever category a row carries and whoever set it. The rule does not
  read `isTransferUserOverridden` (see Review H1).
- **There is no user override in this PR.** A false-positive card-payment match cannot be undone by the user until the
  follow-up adds a "this was a purchase" marker with its own column and per-row toggle. That is additive DDL and needs
  Brad's go.
  - The reviewer found no false positives in a 32-row realistic table: Apple Store, Capital One Café, Discover Books,
    American Express Travel, PayPal \*Netflix, Zelle, Venmo and others.
  - `spendingFilter.test.ts` pins a 32-row table of its own.
- **The system "Uncategorized" category is not excluded.** A row there is spend, as before.
- **Wrappers.** `isRealSpend` is `spend && categorized`; `isUncategorizedSpend` is `spend && !categorized`.
- **Every field the rules read is required on `SpendTxn`.** A caller that forgets to select `debtId`, `reimbursable`,
  `isExternalCardPayment` or `pfcDetailed` fails to compile rather than classify with a default.
- **Callers:** three production callers, `spendingFacts`, `behaviorFacts` and `amexAnchor`. `billsOneOff.computeOneOff`
  was updated to compile but has **no production caller**.

**`CARD_PAYMENT_PATTERNS`** are issuer payment phrases, never a merchant or brand name on its own:
- `crcardpmt`
- `capital one mobile pymt`, `capital one online pymt`
- `applecard gsbank`, `goldman sachs apple`
- `discover e payment`, `discover dc pymnts`
- `citi card online`, `credit one bank`
- `synchrony paypal`, `synchrony bank paypal`, `synchrony bank payment`, `synchrony ashley`
- `paypal paymthly`, `barclaycard us creditcard`, `credit card pymt`, `target card srvc`, `menards big card`
- `amex epayment`, `amex ach pmt`, `american express ach`

**How a phrase matches:**
- **Normalized.** The description is lowercased, every run of punctuation and whitespace becomes one space, and the
  phrase must appear as **whole words**. So "SYNCHRONY BANK/PAYPAL", "PAYPAL \*PAYMTHLY" and "CAPITAL ONE   CRCARDPMT"
  match, and "XCRCARDPMTX" does not.
- **Merchant names stay out.** The seed rules also send "MATTRESS FIRM" and "AFFIRM" to Misc / Buffer; those are merchant
  names and are left out. "NELNET" and "DEPT OF ED" are student loans, not cards.

**`/reports/spending-facts`** (`lib/spendingFacts.ts`) runs each row through `classifyOutflow` once.
- **New `householdSpend {total, transactionCount}`** = categorized + uncategorized spend.
- **`realSpend`** is its categorized part, and still feeds `byCategory`, `byMerchant`, `dailyBuckets`, `dailyNet`,
  `dayOfWeek` and `monthlyTrends`.
- **New `excluded.cardPayments` and `excluded.reimbursable`**, beside the four existing buckets. Bank noise goes to
  `transfersTotal`, as before.
- **`unplanned`** is required in OpenAPI and counts any UN-flagged purchase through the same rule.
- **`Transaction` gains `pfcDetailed`** in the spec. The list route already returned it; the popover needs it for rule 8.
- Codegen was run and the generated `api-zod` / `api-client-react` files are committed.

**The spine.** `spentWeek` / `spentMonth` = `buildSpendingFacts().householdSpend.total`, the same call the report makes.

**The web app.**
- **Banking strip** (`chase-insight-strip.tsx`): the headline is `householdSpend`, so it agrees with the Command Center
  tiles.
  - When anything is uncategorized, a note under the headline says "Includes $X not yet categorized". The category mix
    beside it is categorized only.
  - The "Needs a category" stat now says it is included in the total above.
- **Spending page** "Total real spend" and the **Reports hub** "Spending" tile stay on `realSpend`. When anything is
  uncategorized they add "+ $X uncategorized", so each reconciles on sight with the household figure.
- **The Recategorize popover** (`SpendingPage.tsx`) lists rows through `lib/uncategorizedSpend.ts`, which calls the shared
  `classifyOutflow`. The browser copy of the bank-noise list is gone. It no longer offers card payments, reimbursable
  charges or bank noise as "needs a category".

**The Amex weekly payoff** (`lib/amexAnchor.ts`) uses the same rule with one option, `reimbursableIsSpend`. A reimbursable
charge is still owed to Amex, so it stays in "what to pay this card".

## Deviations from the plan, and why

1. **No "this was a purchase" override.** The plan reused `is_transfer_user_overridden`. The review showed it cannot mean
   that: every hand-picked category sets it (`routes/transactions.ts` #479). A dedicated marker is deferred to a follow-up
   (Review H1).
2. **The bank-noise patterns stay, as rule 9b.** The plan's list omits them. Dropping them would count rows main excluded
   ("ACH PMT … WEB ID:" bills, "AUTOPAY"). The plan's figures-that-move list does not include that.
   - Their loose substring "epay" also drops "REPAY \*PEST CONTROL" and "EPAYMENTS PLUMBING LLC". That is pre-PR7
     behaviour, disclosed and pinned by a test (Review NIT).
3. **The pure rule lives in `lib/avalanche-core`, not only in `api-server`.** It is the package both apps already share
   rules through (`inForecast`, the household calendar), so the popover runs the server's code.
4. **Pattern list trimmed** to issuer phrases (see above).
5. **The Amex payoff keeps reimbursable charges** (`reimbursableIsSpend`).
6. **Field names follow the plan literally:** `excluded.cardPayments` and `excluded.reimbursable`, not `…Total` like their
   siblings.
7. **Not done: pending/posted pairs.** PR4c's note hands "spending totals should not count both halves" to PR7, but PR4c
   (`fix/pending-superseded-by-posted`) is not on `main`.

## Figures that should move

**Live, wherever household spending shows** (Command Center "Spent this week/month" via the spine, the Banking strip):
- **Down** by card payments: flagged, Plaid-classified, or matched by description, however the row is categorized.
- **Down** by outflows tagged to a debt and by reimbursable charges.
- **Up** by uncategorized purchases, including rows whose category was deleted.

**`realSpend`** (Spending page total, byCategory/merchant/day-of-week/monthly charts, dailyNet, Reports hub tile): down by
card payments, debt-tagged outflows and reimbursable charges. **Never up**; the uncategorized total is now shown beside it.

**Other surfaces:**
- **Unplanned:** down by any card payment, debt-tagged or reimbursable row flagged UN. Up by a UN row whose category was
  deleted.
- **Habits (behavior facts):** splurge, most-visited, streaks and days-since exclude card payments and debt-tagged
  outflows. Reimbursable rows were already dropped there.
- **Amex weekly payoff (`weekCharges`):** down only by a charge on the card that is flagged, tagged to a debt,
  Plaid-classified as a card payment or matching a card-payment phrase. Reimbursable and uncategorized charges are
  unchanged.
- **Spending popover:** stops listing uncategorized card payments, reimbursable charges and flagged or debt-tagged rows.
- **`excluded` panel (API only; no screen reads it):**
  - two new buckets;
  - a transfer tagged to a debt now lands in transfers (rule 1 before rule 2);
  - an outflow in an income category that matched bank noise is no longer counted in transfers.

**Tests, before → after:**

| Test | Before (main) | After |
|---|---|---|
| Household scenario S10, spent this week (card payment filed by hand, override flag set) | 424.00 | **274.00** |
| Codex check: $100 Amex groceries + $100 "CAPITAL ONE CRCARDPMT" | 200.00 | **100.00**; `excluded.cardPayments` 100.00 |
| The same payment after `PATCH {categoryId: Misc / Buffer}` | 200.00 (and 200.00 on `aecbf38`) | **100.00** |
| Spine parity, spent month | `realSpend` 557.90 | `householdSpend` **570.24** (fixture gains a 12.34 uncategorized charge) |
| Household clock, unplanned spending, spending-facts income | unchanged | unchanged |

**Not measured:** the production figures, or payment-like descriptions that match no pattern. Both need a read-only
production query Brad approves.

## Must not change

- **Budget page `plannedTotal` / `planBySource`:** `routes/budget.ts` and `lib/budgetFacts.ts` import nothing from the
  spending rule. `budgetPlanBySource` passes.
- **Cash today and the forecast:** `cashSignal`, `forecastLedger` and `routes/forecast.ts` do not import it. Golden,
  cash-signal, household-scenario cash and review columns, and spine bank and review-count parity all pass unchanged.
  - The spine parity fixture's new charge sits on a card account, so it does not move either.
- **Landing:** `landing.tsx` untouched and still shows no dollar figures. Landing JS **572.5 KB of 580** (entry chunk
  239.8 → 239.9 KB).
- **No stored data re-tagged:** the integration test PATCHes a category through the real route and reads the row back.
  `isTransfer` and `isExternalCardPayment` are untouched, and no route writes anything new.
- **No new dependency; no schema or DDL change** (`lib/db` untouched).

## Residuals

- **No user override** until the follow-up. A false-positive match stays excluded.
- **A phrase list, not a certainty.**
  - An issuer phrase not on the list still counts until Plaid's category or the user's `isExternalCardPayment` flag
    catches it.
  - Plaid's detailed category is only on rows synced since #636.
- **The popover lists only rows with no category id** (the `uncategorized=true` SQL filter). A purchase whose category
  was deleted is in the banner's total but not in the list.
- **Legacy bank noise** (unchanged):
  - The loose "epay" substring above.
  - "chase credit", "bk of amer", "wells fargo card" and "credit card pmt" sit in `excluded.transfersTotal`, not
    `cardPayments`. Totals are unaffected.
- **`dailyNet` and the charts use categorized spend only**, so they do not sum to `householdSpend` while anything is
  uncategorized. The tiles now say by how much.
- **Browser bucket helpers** (`bucketSpend.ts`, `discretionarySpend.ts`) keep their own flag-based rules. They count only
  rows the user explicitly tagged weekly, monthly or UN.
- **Pending/posted pairs** the sync left unlinked still count twice in spending (PR4c covers cash only).

## Tests

- **`lib/spendingFilter.test.ts`** (76):
  - **the 12-row table**, one row per rule in order, each asserting the kind, the rule and that both wrappers agree;
  - first match wins, inflows, manual-Amex positive charges, a deleted category, the system Uncategorized category, the
    Amex payoff option;
  - **automatic recognition:** a card payment uncategorized, filed under Misc / Buffer or Groceries, in Uncategorized, or
    in a deleted category is still a card payment; the override flag is ignored, by description and by Plaid category;
  - **16 payment strings recognized**, including all eight from review M2;
  - **32 purchases not caught**, including the reviewer's examples;
  - whole-word matching after normalization; every seeded card-payment pattern recognized; patterns written normalized;
  - the loose legacy "epay", pinned and disclosed.
- **`__tests__/spendingCardPayments.integration.test.ts`** (4), through `/reports/spending-facts`, `/spine` and
  `PATCH /transactions/:id`:
  - **Codex check:** $100 Amex groceries + $100 card payment → `householdSpend` and `realSpend` **100**,
    `excluded.cardPayments` 100, spine week and month **100**.
  - **H1:** `PATCH {categoryId: Misc / Buffer}` sets `isTransferUserOverridden`; household spend and the spine stay
    **100**. The same after `PATCH {isTransfer: false}`. The row is never re-tagged.
  - **M1:** an uncategorized purchase inside the spine's week and month; the spine equals `householdSpend` **112.34** and
    differs from `realSpend`.
  - **One mixed ledger, every bucket:** categorized, uncategorized, deleted category, reimbursable, a Plaid-classified
    payment with a bland description, a UN-flagged card payment, bank noise. The buckets sum to every dollar that left
    (710.00).
- **`__tests__/amexWeeklyPayoffReimbursable.integration.test.ts`** (1, L2): through `/amex/weekly-payoff`, $50 +
  $40 reimbursable + a $30 card-payment string on a Platinum card → `weekCharges` **90**. The Spending report for the same
  week shows `householdSpend` 50, `excluded.reimbursable` 40, `cardPayments` 30.
- **Household scenario:** S10 switched on at **274.00**, its fixture row carrying `isTransferUserOverridden: true` as a UI
  filing would. The contract document is updated.
- **Spine parity:** gains an uncategorized card charge today. It asserts the spine equals `householdSpend`, that
  `householdSpend = realSpend + uncategorized`, and that spent week and month differ from `realSpend`.
- **Web:**
  - `lib/uncategorizedSpend.test.ts` (13): popover rows through the shared rule;
  - the strip's uncategorized note and its absence (2);
  - the Reports hub "+ $X uncategorized" (1);
  - mocks in `chaseInsightStrip.test.tsx` and `commandCenter.test.tsx` carry `householdSpend`.
- **`spendingFilterIncome.test.ts`:** row helper fills the new required fields.

**Failing before**, each run and restored:
- **Against `main`'s source (`b93c01e`, first look):** all four new or changed API files fail. S10 fails on the number
  (424 vs 274); the rest fail at the missing `householdSpend` or `classifyOutflow`.
- **Against `aecbf38`'s API source (this revision): 14 fail.**
  - S10: 424 vs 274.
  - **H1 through the PATCH route:** 200 vs 100.
  - M1 test: 212.34 vs 112.34, but only because the hand-filed payment is counted there.
  - The override-ignored unit test.
  - The eight M2 strings.
  - Whole-word normalization, and patterns written normalized.
  - The false-positive table, the L2 payoff test and spine parity pass there, as they must.
- **`spine.ts` reverted to read `realSpend` (M1):** both M1 assertions fail (card-payment test 100 vs 112.34; spine parity
  557.90 vs 570.24).
- **`reimbursableIsSpend` removed from `amexAnchor.ts` (L2):** the payoff test fails.
- **`aecbf38`'s strip and Reports hub (L1):** both new web tests fail.
- **`lib/uncategorizedSpend.test.ts`** is a new module. On `aecbf38` the popover's own predicate kept "CAPITAL ONE
  CRCARDPMT" as uncategorized.

## Verification

- **Full API suite:** **123 files, 982 pass, 7 todo** (`aecbf38`: 122 files, 929 pass; main `b93c01e`: 120 files, 901 pass,
  8 todo).
- **Full web suite:** **119 files, 933 pass** (`aecbf38` and main: 118 files, 917 pass).
- **Workspace typecheck:** exit 0.
- **Workspace build:** exit 0.
- **Landing bundle guard:** **572.5 KB of 580**; entry chunk 239.9 KB.
- **Codegen:** re-run after commit, no diff.

## Review

First look at `aecbf38`: **REQUEST CHANGES**.

| Finding | What was done |
|---|---|
| **HIGH H1** — a hand-picked category put a card payment back into spending (`isTransferUserOverridden` skipped rules 8–9, and every category PATCH sets it) | `classifyOutflow` no longer reads the flag; recognition is automatic whatever the category. The "this was a purchase" marker (own column + toggle) is deferred to a follow-up (additive DDL, needs Brad's go); until then a false positive cannot be undone by the user. The popover now runs the shared rule from `@workspace/avalanche-core` instead of a browser copy. New integration test PATCHes a category through the real route and asserts household spend and `spentWeek` stay 100. S10's row carries the flag and stays 274.00. |
| **MEDIUM M1** — nothing tested that the spine reads `householdSpend` | An uncategorized purchase inside the spine's week and month, in both the card-payment test and spine parity, with `spentWeek`/`spentMonth` ≠ `realSpend`. Both fail with `spine.ts` reverted. |
| **MEDIUM M2** — common payment strings missed | Punctuation normalized to spaces, whole-word matching; added Capital One online, Discover DC, Synchrony Bank (PayPal and payment), Barclaycard US, "credit card pymt", Target card service ("PAYPAL \*PAYMTHLY" matches the existing phrase once normalized). All eight strings are in the table; the 32-purchase false-positive table stays green. A read-only production check for unmatched payment-like descriptions needs Brad's approval. |
| **LOW L1** — household spend and real spend differ by the uncategorized total | Shown, not just disclosed: the strip says "Includes $X not yet categorized" under its headline; the Spending page total and the Reports hub tile add "+ $X uncategorized". |
| **LOW L2** — no route test for `reimbursableIsSpend` | `/amex/weekly-payoff` integration test; fails with the option removed. |
| **LOW L3** — "four callers" was wrong | Corrected: three production callers; `computeOneOff` has none. |
| **NIT** — legacy "epay" drops "REPAY \*PEST CONTROL", "EPAYMENTS PLUMBING LLC" | Disclosed and pinned by a test. Left unchanged: tightening it would count rows the app has always excluded, which this PR cannot measure. |

## Left for later

- **"This was a purchase":** a dedicated column and per-row toggle, skipping rules 8–9 for that row only. Additive DDL;
  needs Brad's go.
- **A read-only production query** (Brad's approval): payment-like outflows that match no phrase, and the before/after
  household figures.
- **Spending totals should not count both halves of a pending/posted pair** once PR4c's `pairPendingWithPosted` is on
  `main`.
- **PR10:** needs classification and the Codex point-9 states. `householdSpend` and `unplanned` are the inputs.
- **The popover could list deleted-category purchases** if `/transactions` gained a filter for a dangling category id.
