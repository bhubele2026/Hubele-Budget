# F4b — category splits in the two client groupings (2026-10-09)

Branch `restore/f4b-splits-in-groupings`, base `12c92f41` (main with F4). Follows the F4 note's list of groupings that did not honour splits.

## Why an API change
`GET /transactions` rows carried no split information (`splitCount` exists only on `/transactions/ledger` rows, which are one account's). The only source of parts was one request per charge.

## API (additive)
- `Transaction.splits?: [{ categoryId, amount }]` (readOnly; same string format and sign as `amount`; the parts add up to `amount` to the cent).
- `GET /transactions` only: after the rows are read, ONE `inArray` query (`loadSplitsForTxns`, valid parents only, `splits_invalid = false`) feeds the existing `expandSplits`, which also drops any split whose parts do not add up. Rows that pass get `splits`; every other row has no `splits` key, so it serializes byte-identical to before. The ledger endpoint and every other route are untouched (the type is shared, so ledger/POST/PATCH rows may declare the optional field but never send it).
- CI-style codegen (dists and tsbuildinfo removed, regenerated): committed; drift check after regeneration shows 0 changed files.
- Integration test `transactionsListSplits.integration.test.ts` (DB `h2budget_test_f4b`): a valid split carries its parts and the parent keeps its category; an unsplit charge and an invalid split (flagged) have no `splits` key; parts that no longer add up (amount edited) have none; the `db.select` call count of a list is the same for 1 row and for 6 rows with 3 splits (no N+1).

## Client (`lib/splitParts.ts`)
- **Reports › Cash flow money flow** (`CashFlowPage.tsx`, `flowBars`): `monthMoneyFlow` — an expense charge with `splits` adds each part under its own category name; income and every other row unchanged.
- **Budget actuals popover** (`budget.tsx`, `txnsByCategoryThisMonth`): `groupTxnsByCategory` — a split charge appears under each part's category as a row with that part's amount (same id; parts in one category are added up); other rows are filed as before (inherited category, transfers and replaced pending skipped).
- No new request, no new query key.

## Tests (`lib/splitParts.test.ts`)
- No splits: money flow and the Budget index equal reference copies of main's old loops on a fixture with income, transfers, a replaced pending row, an inherited category, an unknown category, an out-of-month row and uncategorized rows (same Maps, same row objects, same order).
- A valid split: parts land in their categories, the month total is unchanged, the parent's own category no longer holds the whole charge, two parts in one category become one row, the part amounts for one charge add up to the charge.
- An invalid split (no `splits`): counts whole under the parent's category in both groupings.

## Not changed
- `dailyCashFlow(txns, excludedCategoryIds)` in Cash flow (the daily series and KPIs) still reads a charge by its own category when deciding exclusions; a split whose parts straddle an excluded category is a separate case and the series totals are unaffected. Left for a follow-up if wanted.
- Income charges are not split-aware (the income grouping is by description, not category).

## Gates
`pnpm run typecheck` (repo root) clean; codegen drift 0; API suite 236 files / 2,555 passed (2 todo) on `h2budget_test_f4b`; h2budget vitest UTC 1,752 passed / 4 skipped, America/Chicago 1,754 passed / 2 skipped; frozen h2 suite 522 passed / 4 skipped (and typechecks); build + entry graph OK at 618.8 KB of 622 KB; `pnpm audit --prod` 1 high, already ignored.
