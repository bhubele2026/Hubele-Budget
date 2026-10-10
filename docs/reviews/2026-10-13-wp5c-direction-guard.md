# WP5c: direction guard

Branch `fin/wp5c-direction-guard`, from `origin/fin/integration`. Merged forward: integration with WP5b, then batch 1 (997aad0). Plan: `ancient-swimming-book.md`, root cause 6, WP5c.

- **Implemented:** everything below, on the branch.
- **Tested:** unit, integration and web tests, and mutation checks.
- **Deployed:** no.
- **Enabled:** nothing sits behind a flag. No AI, SMS, sync or automation setting changed.

## Root cause (base tree 997aad0)
- No categorizer stage checked which way the money went.
  - `decide.ts:34` returned a memory, rule or recurring pick as it was.
  - `modelStage.ts:145` (`judgeAnswer`) checked only `debtCategoryAllowed`.
- A broad rule could therefore file a paycheck under Dining at 0.95. That is the seeded "EXACT SCIENCES" rule after it was re-pointed: `lib/mappingSeed.ts:8`, root cause 6.
- The web flag (`lib/categoryDirection.ts:78-108`) was its own copy of the rule:
  - it did not know which accounts are cards, so a credit on a non-Amex card could read as "income";
  - it treated the system "Uncategorized" category as an expense category.

## What changed

### One rule: `categoryDirectionConflict` (avalanche-core `spendingRule.ts`, beside `isRealIncome` / `classifyRefund`)
- It returns `"inflow_into_expense" | "outflow_into_income" | null` for the category being judged.
- **Conflict:** money in filed under an expense category, or money out filed under an income category. Either way the row counts in neither spending nor income. A test pins that invariant.
- **Never a conflict:**
  - no category, the system Uncategorized category, or a deleted category;
  - a transfer, a `debtId`, or the card-payment flag;
  - a debt category or an excluded category (Transfer, Ignore, Reimbursement, …);
  - a reimbursable row;
  - money in on a card;
  - money in that `classifyRefund` calls a refund.
- **Card-ness:** `isCardLedgerRow(source, accountType)`. True for `plaid_accounts.type === "credit"` from any bank, or a source in `CARD_LEDGER_SOURCES`. A card ledger source always counts as a card, even if a caller says otherwise.

### Engine
- `EngineContext.accounts`: `loadAccounts` moved from `modelStage.ts` to `context.ts` and is loaded once per batch. The model stage now reads it from the context instead of querying again.
- `lib/categorizer/direction.ts` holds the shared `spendTxnOf` (moved out of `heuristic.ts`), `isCardRow`, `directionConflictOf` and `guardDirection`.
- **`decide.ts`:** a memory, rule or recurring pick that conflicts becomes a queue decision (confidence 0.5).
  - It keeps the suggested category and the rule, memory or recurring id.
  - Explanation: "Money in, but this would file it under an expense category." or "Money out, but this would file it under an income category."
  - A queue decision writes no category. The row stays as it is, and the model may still be asked.
- **`judgeAnswer`:** rejects a conflicting answer, next to `debtCategoryAllowed`.
- **Not guarded, on purpose:**
  - `inherited`: it writes what the readers already count (`effectiveFiling`), so what is stored keeps equalling what is read;
  - `refund`: B6 runs first and is only ever a queue decision.

### Web
- `lib/categoryDirection.ts` now wraps the same predicate.
  - New helpers: `accountTypesOf(items)`, keyed by Plaid's external account id, and `isCardTxn`.
  - Uncategorized is matched by its exact name, the same test as the server's `uncategorizedCategoryIds`.
- AttentionPanel and ActivityPanel pass `isCardAccount` from the loaded bank items.
  - AttentionPanel already waits for the items (WP7).
  - ActivityPanel shows no flag until the items answer.

## What must NOT change, and the tests that pin it
| Must not change | Pinned by |
|---|---|
| Card credits (any issuer) stay with their purchases | `spendingFilterDirection` "card credits…" (Plaid Amex, Amex workbook, non-Amex card, a card ledger source with the wrong flag) · `categorizerEngine` "a credit on ANY card…" · `categorizerRefund` the pinned case (was :154-157, now :159-162) and its companion · `categorizeModelStage` "judgeAnswer keeps a card's credit…" · web `categoryDirection` "a NON-Amex card's credit…" · `dashboard` "(WP5c) a credit on a NON-Amex card…" and the ActivityPanel card case |
| Checking refunds (a REFUND word) | `spendingFilterDirection` "checking refunds…" · `categorizerEngine` "must not change: a checking refund…" · `categorizerRefund` companion · `categorizeModelStage` (BIGCO REFUND) · web `categoryDirection` "a refund (classifyRefund)…" |
| Reimbursables, both directions | `spendingFilterDirection` "reimbursables…" · `categorizerEngine` "must not change…" · web `categoryDirection` "(lead's ruling)…" |
| Transfers | `spendingFilterDirection` "transfers…" · `categorizerEngine` "must not change…" · web "a transfer, a debt-tagged row…" |
| Card payments and debts (the flag, a debt row, a debt category, a payment leaving checking) | `spendingFilterDirection` "card payments and debts…" · `categorizerEngine` (`isExternalCardPayment`) · web "a transfer, a debt-tagged row or the card-payment flag…" |
| Correct directions file as before (cafeteria → Dining, payroll → Income) | `categorizerEngine` (the cafeteria charge, the deposit with the recurring item) · `categorizeModelStage` "through the batch…" · `categorizerEval` precision 0.974 |

## The categorizerEvalModel expectation change
- The eval-with-model test sends the fake model whatever the deterministic stages left.
- Three of those rows are the eval's refund credits (SHOPCO ×2, GREEN GROCER). In that test's database they arrive with no earlier purchase to link (B6) and no REFUND word, so they are plain credits on checking.
- The fake model always answers each row's label. Here that is an expense category, so code now rejects it: money in under an expense category.
- Those rows stay questions for a person. That matches the B6 rule: off a card, a credit nets spending only when there is evidence.
- The loose `filed ≥ asked − 2` is replaced by an exact count: filed = asked − 3. The test also checks that all three stay ambiguous.

## Figures that move
- **Fixture: none.** I read every scenario's credits:
  - the payroll in Dining & Coffee is flagged before and after (count 1);
  - the Amex workbook refund, the transfer into savings, the Blue refund tagged to a debt, the uncategorized deposits and Zelles, and the Platinum payment are flagged neither before nor after.
- **Real data, from deploy on (not measurable here):**
  - Future engine runs queue, rather than file, any memory, rule or recurring pick that goes against direction. "Categories to confirm" may grow by those rows.
  - No stored category is changed by this package.
  - Until WP5d, a rule's fill at insert time still writes its category when the row is inserted. The queue decision then sits beside it.
  - The dashboard stops flagging credits on non-Amex cards, credits parked in Uncategorized, and credits carrying the card-payment flag.

## Tests
- New: `spendingFilterDirection.test.ts` (13 cases).
- Extended: categorizationEval fixture (BIGCO PAYROLL / BIGCO CAFE plus explicit assertions), categorizerRefund (+1), categorizerEngine (+5), categorizeModelStage (+3, purity test updated), categorizerEvalModel (exact count), web `categoryDirection` (+5), dashboard (+2).
- Mutation checks, each failing its tests:
  - dropping the `decide.ts` guard fails 10;
  - dropping the `judgeAnswer` check fails 2;
  - ignoring account-type card-ness fails the card cases (API and web).
- Gates on the merged tree:
  - root typecheck passes;
  - API: 248 files, 2701 passed, 1 skipped, 2 todo;
  - web: 211 files; UTC 1999 passed + 3 skipped, Chicago 2000 passed + 2 skipped;
  - build passes, and landing JS is 619.8 KB (cap 622). No landing-path file changed: `spendingRule` stays its own lazy chunk;
  - `pnpm audit --prod`: 0 high except the known ignored `braces` advisory.

## Not verified
- How many rows on real data would be queued, or would stop being flagged. A read-only count would need the rules and memory against 90 days of rows.
- The extra accounts query per batch: one small query on household and ids, not measured.
