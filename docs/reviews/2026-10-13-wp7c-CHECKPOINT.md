# WP7c — CHECKPOINT (paused for the capacity change, 2026-10-09)

Branch `fin/wp7c-views-deeplinks` = `origin/fin/integration` e94016de (main + WP7a) + the fixed `fin/wp7b-account-route` 76e4b936 merged (844faa79) + the 7c feature commit ca20e19a + this checkpoint. Not merged, not deployed. Draft review note: `2026-10-13-wp7c-views-deeplinks.md` (gates and fixture figures filled; final once step 1 below is decided).

## Done (ca20e19a)
- Accounts page per kind (`accountViewOf`, the server's depository rule): card → card ledger asking `?plaidAccountId=<ext>`; checking/savings/other depository at any bank → bank ledger embedded for THAT account; loan / other → "H2 has no ledger … yet".
- Embedded bank ledger: no self-heal, no reset on refusal (inline `chase-no-ledger`), `pickerAccounts` = every linked depository account (a pick navigates), nothing persisted, "Savings balance" title.
- Embedded card ledger: band opens the other card's page / `/amex`.
- Row links `?tx=`: Month mode on both ledgers, role=status "Showing <Month> for the row you opened", Amex first-load jump respects a linked month, Chase ignores (and keeps) the saved pick without `?account=`; focus scroll without `CSS.escape`.

## Half-done
- A row link with NO `?month=` opens Month mode on THIS month. The harness path `/transactions?tx={deeplinkChk}` (row dated Sep 15) therefore still misses its row — the one remaining ledger-matrix failure. `askWords.refHref` (Ask answers, proposals, memory) and `legacyRoutes` also link without a month.

## Next three steps
1. Decide the month-less link: (a) a small read `GET /transactions?id=<id>` (exact, household-scoped, like WP7a's `plaidAccountId`) that both ledgers ask only when `?tx=` has no `?month=`, then open that row's month; or (b) keep it and have the harness path carry `&month=` like every in-app link from `lib/accountRoute.ts`. (a) also fixes the Ask links. Lead's call.
2. Finish the review note, run the full gates (web both TZs, build + entry graph, audit; the API suite too if (a)), re-run the matrix to 18/18, push, report.
3. Then WP7d (`pages/next/accountsLedgerMatrix.test.tsx` over a new `__test-helpers__/fakeHouseholdApi.ts`), then WP8.

## Tests passing (on ca20e19a)
- `pages/chaseDeepLink.test.tsx` 13/13; `pages/amexDeepLink.test.tsx` 7/7; `amexLayout.test.tsx` 10/10; `next/Accounts.test.tsx` 28/28 (incl. the 7b review-fix cases).
- Full web suite: UTC 1,913 passed / 3 skipped; America/Chicago 1,914 / 2 (206 files). Typecheck clean. Build + entry graph OK at 618.4 KB. Audit exit 0.
- Fails before: 18 of the new tests fail on the pre-7c page code (mutation run).
- Harness ledger matrix, `normal+accounts` and `normal+accounts+gone`: main had 18 failures (`normal+accounts`); this branch has 1 in each (the month-less deep link above). Every account page lists its own rows only (`{savings}` 29/29, `{freedom}` 30/30, `{quicksilver}` 30/30, `{cu}` 30/30, …); all 6 `/home` row links land on their row. Shots: `dash-shots/fin4-wp7c/`.
