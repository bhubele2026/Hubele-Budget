# WP5d — insert-time fills obey the direction rule; the gap backfill runs the engine

Branch `fin/wp5d-fills-backfill`, from `origin/fin/integration` (WP5c merged in; then integration a3dc9156). Plan: `ancient-swimming-book.md`, WP5d.

- **Implemented:** everything below, on the branch.
- **Tested:** unit and integration tests (Plaid mocked), plus mutation checks.
- **Deployed:** no.
- **Enabled:** nothing is behind a flag. No AI, SMS, sync or automation setting changed.

## Root cause (base tree)
- WP5c guards the engine, but rules also fill a category **at insert time**, before the engine sees the row. Those fills never checked direction:
  - `autoCategorize.ts:181` (`categorize`);
  - the Plaid cursor sync (`plaidSync.ts:1364`);
  - the gap backfill (`plaidSync.ts:3655`);
  - a manual create (`routes/transactions.ts:242`);
  - the workbook import (`workbookImporter.ts:522`);
  - the recovery script (`scripts/src/reapplyCategories.ts:80`).
- Result: a payroll deposit that a re-pointed rule matched was still **stored** in Dining. WP5c could only add a queue decision beside it.
- The gap backfill (`plaidSync.ts:3419`) never ran the engine at all. Only the cursor path does (`:2042`). A backfilled row kept its rule fill and got no decision until a later job.

## What changed
- **`categorize(input, rules, guard?)`:**
  - With a guard, a winning rule that would file money in under an expense category, or money out under an income one, now files nothing. The result is `{categoryId: null, directionConflict: {kind, ruleId, pattern}}`.
  - In that case `matchedRuleId` is null, so the sync's "auto-categorized via rule X" count never claims the row.
  - The rule is the same `categoryDirectionConflict` WP5c added.
  - Without a guard, nothing changes.
- **`loadRuleContext(householdId)`** loads the rules, the categories as the spending rule reads them, and the system Uncategorized ids. `directionGuard(ctx, row)` builds the guard for one row.
  - Card-ness comes from `isCardLedgerRow(source, plaid_accounts.type)`.
  - `spendContextOf` moved to `lib/spendContext.ts`, so autoCategorize can use it without an import cycle. `categorizer/context.ts` re-exports it.
- **Call sites:**
  - **Cursor sync:** the account type comes from the item's own accounts (`acctByExternalId`). The signed amount and the debt link are now computed before the fill (both pure; unchanged values).
  - **Gap backfill:** the fill uses the current account's type. Afterwards the backfill runs the cursor path's tail:
    - `reconcileSplitsAfterSync`;
    - `runCategorizationBatch(householdId, {txnIds: upserted, freshIds: inserted, trigger: "sync"})`;
    - the `txn.arrived` emit.
    It is non-fatal, and idempotent by `input_hash`.
  - **`POST /transactions`:** a rule fill that conflicts leaves the row uncategorized. The deterministic engine then runs on that one row so the queue question exists at once, and the response returns the row as it now stands. A category the person names in the body is never second-guessed: it is kept and locked, as before.
  - **Workbook import:** guarded, with the imported categories' real kinds. Today it never fires (card rows, expense categories); it is wired so the rule is the same everywhere.
  - **`scripts/src/reapplyCategories.ts`:** uses `categorize` with the guard and each row's account type. Conflicts are skipped and counted in the output.

## What must NOT change, and the tests that pin it
| Must not change | Pinned by |
|---|---|
| Card credits (any bank) filed by a rule | `autoCategorize` "must not change: a card's credit (any bank)…" · `plaidSyncCategoryLock` "a credit on a card of any bank…" · `workbookImportCategoryLock` (the card's REVERSAL credit is filed like its purchase) |
| Transfers, debt payments, reimbursable credits, checking refunds | `autoCategorize` "must not change…" · `categorization` (POST: reimbursable credit filed) |
| The right direction files as before, attributed to the rule | `autoCategorize` "the right direction files as before…" · `plaidSyncCategoryLock` (cafeteria filed; `autoCategorized` 1, attribution count 1) · `categorization` (POST money out filed, `autoCategorizedRuleId` set) · `plaidGapBackfill` (purchase filed) |
| A person's explicit category on create: kept and locked | `categorization` (POST with `categoryId`) · existing `categoryLockedByUser` POST cases |
| No guard means no change (existing callers) | `autoCategorize` "without a guard nothing changes" · every pre-existing test in the six files |
| The audited correction learns nothing (WP5a: Brad's single-row "Set category") | `categoryLockedByUser` "(WP5d) a single-id bulk-update…": a user decision with `previousCategoryId`, row locked, no new or changed merchant memory, rules and rule history untouched, and Undo restores the previous category and unlocks |
| A rule fill never locks a row | `plaidSyncCategoryLock` (conflicted and filed rows both unlocked) |

## Figures that move
- **Fixture: none.** The harness seeds rows directly; no sync, backfill or manual create runs during a capture.
- **Real data, from deploy on (not measurable here):**
  - **Future rows** a rule would file against their direction are stored **uncategorized** instead of in that category, with a queue decision naming the rule. That applies to synced, backfilled and manually created rows. Such a row no longer lands in an expense budget line (a deposit) or an income line (a charge).
  - **Backfilled rows** now get engine decisions as synced rows do. A row a merchant memory knows gets filed straight away rather than at the next job. One the engine can't decide joins "Categories to confirm".
  - **No stored row changes.** Existing misfiled rows stay as they are until Brad corrects them (WP5a).

## Tests
- `autoCategorize` +6.
- `plaidSyncCategoryLock` +2.
- `plaidGapBackfill` +1: the fill, the engine's decisions, and that a second run records nothing.
- `categorization` +1: POST conflict queued, money out filed, explicit pick, reimbursable.
- `workbookImportCategoryLock` +1 assertion.
- `categoryLockedByUser` +1.
- Mutation checks:
  - ignoring the conflict in `categorize` fails 5 cases;
  - dropping the backfill's engine run fails the backfill case;
  - dropping POST's inline engine run fails the POST case.
- Gates on the merged tree:
  - root typecheck passes;
  - API: 248 files, 2712 passed, 1 skipped, 2 todo;
  - web: 214 files; UTC 2044 passed + 3 skipped, Chicago 2045 passed + 2 skipped;
  - build passes; landing JS 619.8 KB (cap 622);
  - `pnpm audit --prod`: 0 high except the known ignored `braces` advisory.

## Not verified / left alone
- The live Plaid paths: Plaid is mocked in every test.
- How many future rows would be stored uncategorized on real data.
- `scripts/src/recategorize.ts` fills from its own canonical merchant map, not from mapping rules, so it is not guarded here. It is dry-run by default and run by hand. A guard there would be a separate change.
- `reapplyCategories.ts` end to end (a CLI); it shares `categorize`, which is tested.
