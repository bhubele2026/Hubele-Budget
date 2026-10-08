# PR-A2 — categorization API polish for the Activity screen

- **Branch:** `reinvent/pra2-api-polish`, cut from `origin/main` at `2faa9a8a`.
- **Package:** API only, additive and backward compatible. No migration, no financial calculation, no web change. Closes the API gaps listed in `2026-10-07-s2-activity.md`.
- **All data in tests is synthetic.**

## What changed

| Gap (S2 review) | Change |
|---|---|
| 1, 2. PATCH returned no ids | `PATCH /transactions/:id` returns `decisionId` (the `user` decision this hand filing wrote) and `learnedRuleId` (the merchant-memory row it created, re-pointed or confirmed). `recordHandFiling` now also returns `learnedRuleId`. |
| Bulk | `POST /transactions/bulk-update` returns `decisionIds[]` (one per updated row; empty when the patch carried no `categoryId`). It is the array `recordUserDecisions` already returned. |
| 3. Ledger rows | `GET /transactions/ledger` rows carry `splitCount` (one grouped read for the page, 0 when none), `categoryProvisional`, and `categoryLockedByUser` (already on the row; now in the `LedgerRow` schema as required). |
| 5. No preview for "apply to past charges" | `POST /learned-rules/:id/apply-retroactively?dryRun=true` answers `{ updated: 0, dryRun: true, count, sample[≤5] }` and writes nothing. The count and sample come from the same `memoryRetroactiveIds` the real run uses. |
| 4. No decision history | `GET /category-decisions?transactionId=` lists a charge's decisions, newest first, at most 20: `id, transactionId, source, categoryId, previousCategoryId, confidence, band, explanation, resolution, undoneAt, createdAt`. A charge outside the household answers 404. |

## Choices to confirm

- **`dryRun` is a query parameter in the spec**, and the server also reads `{ "dryRun": true }` in the body. A typed JSON body would make the generated mutation require `data`, which breaks the existing `{ id }` calls in `artifacts/h2` (typecheck failed on it; `artifacts/h2` is not this package's to edit).
- **`decisionId` / `learnedRuleId` are absent, not null, when no category was set.** Declared nullable, the generated type no longer fits the local `{ decisionId?: string }` in `useFiling.ts`. Once S4 loosens that type, the spec can say nullable.
- **A PATCH that sets the same category again still writes a decision** (unchanged PR-A behavior), so it returns that decision's id.
- The history route lives in `routes/categorization.ts` beside `POST /category-decisions/:id/undo`; its query is in `lib/categorizer/userDecisions.ts`.
- The ledger count query lives in `lib/bankLedger.ts` (`loadAnnotatedRows`), where the ledger row is assembled; `routes/transactionsLedger.ts` only delegates.

## Must not change

No money figure, query filter or stored value changes. The write path of `apply-retroactively` and of PATCH/bulk-update is untouched; the new fields only read what those paths already computed.

## Tests (`pra2ApiPolish.integration.test.ts`, 8 tests)

- PATCH returns both ids (and the same rule id on a second confirm); no ids without a category. Bulk returns one decision id per row; none without a category.
- Ledger: `splitCount` 0 and 2, `categoryProvisional` true/false, `categoryLockedByUser`; another household's splits and rows do not count.
- Dry run: count 7, sample 5, no row, lock or decision written; the real run then moves exactly 7; a second dry run finds 0; body form works; a bad value is 400; another household's rule is 404.
- History: newest first with the fields; capped at 20 of 23; other household 404; missing or malformed `transactionId` 400.
- **Fails before:** with `src/lib` and `src/routes` reverted to the parent, all 8 fail.

## Gates

| Gate | Result |
|---|---|
| `pnpm run typecheck` | clean (all apps; an earlier body-typed `dryRun` and nullable ids broke `artifacts/h2`, hence the choices above) |
| Codegen | no drift; generated clients and zod committed |
| API suite (`h2budget_test_pra2`, `CI=true`) | 204 files · 2173 passed, 13 todo, 0 failed |
| H2 tests (`TZ=UTC`) | 23 files · 314 passed, 3 skipped (unchanged) |
| Classic tests | 140 files · 1248 passed, 4 skipped (unchanged) |
| `pnpm run build` + entry graphs | both built · classic 576.1 / 580 KB · h2 391.1 / 400 KB · both guards OK |
| `pnpm audit --prod` | 1 high, already ignored; no dependency changed |
