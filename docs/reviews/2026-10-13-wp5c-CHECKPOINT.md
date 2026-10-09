# WP5c direction guard — CHECKPOINT (paused for the balances batch)

Branch `fin/wp5c-direction-guard`, from `origin/fin/integration` e94016de, with integration (WP5b, 8745b342) merged in at fb0cbfb8. Not merged. Not deployed.

## Done
- `avalanche-core/spendingRule.ts`: `categoryDirectionConflict(tx, categoryId, ctx, {isCardAccount, uncategorizedIds})` → `inflow_into_expense | outflow_into_income | null`, and `isCardLedgerRow(source, accountType)`. Exported from the core index and the server's `spendingFilter.ts`.
  - Exclusions as the plan lists: transfer, debtId, card-payment flag, debt or excluded category, reimbursable, a card's credit, `classifyRefund`. Also the system Uncategorized category, no category, and a deleted category.
  - A card ledger source always counts as a card.
- Engine:
  - `EngineContext.accounts`: `loadAccounts` moved from modelStage.ts into context.ts, loaded once per batch.
  - `lib/categorizer/direction.ts`: shared `spendTxnOf`, `isCardRow`, `guardDirection`.
  - `decide.ts`: a conflicting memory/rule/recurring pick drops to the queue band (0.5). It keeps the category and the rule/memory/recurring id, and gets the two explanations.
  - `judgeAnswer`: rejects a conflicting answer, beside `debtCategoryAllowed`.
- Web: `lib/categoryDirection.ts` wraps the same predicate. AttentionPanel and ActivityPanel pass `isCardAccount` from the loaded bank items, and the income check waits for those items.
- Tests added or updated:
  - `spendingFilterDirection` (new);
  - categorizerRefund: the pinned case is unchanged (now at :159-162), plus a companion case;
  - categorizationEval fixture: BIGCO PAYROLL / BIGCO CAFE, with explicit assertions;
  - categorizerEngine (5 cases), categorizeModelStage (3 cases);
  - web categoryDirection (non-Amex card, Uncategorized) and dashboard (card credit, items pending);
  - categorizerEvalModel: its 3 unlinked refund credits on checking are now rejected by code, so the expectation is exact.
- Mutation checks: removing the decide guard, the judgeAnswer check, or account-type card-ness each fails its tests.

## Half-done
- Gates on the merged tree. Done so far: root typecheck passes, and the targeted tests below pass. The full API suite ran once before the evalModel fix: 240 of 241 files passed, and the one failure was that test.
- The fixture before → after is checked by reading the seed. No scenario has a credit that the new rule treats differently, so no figure moves. Not yet confirmed with a capture.

## Next three steps
1. Full gates: API suite, web suite in both TZs, `pnpm run build` plus `check-entry-graph`, and `pnpm audit --prod`.
2. Review note `docs/reviews/2026-10-13-wp5c-direction-guard.md`. It lists what must NOT change and the tests that pin it, the figures (none on the fixture), and the effects on real data:
   - future engine picks that conflict are queued, not filed;
   - the dashboard no longer flags credits on non-Amex cards or in Uncategorized.
3. Report to the lead, then WP5d from integration.

## Passing now (targeted)
- API: spendingFilterDirection, spendingFilter, spendingFilterIncome, categorizerRefund, categorizerEval, categorizerEngine, categorizeModelStage, categorizerEvalModel.
- Web, UTC and Chicago: lib/categoryDirection, next/dashboard/dashboard.
