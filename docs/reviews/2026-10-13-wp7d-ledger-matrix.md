# WP7d — the real-ledger account matrix (web tests)

Branch `fin/wp7d-ledger-matrix`, from `origin/fin/integration` 997aad0 with `fin/wp7c-views-deeplinks` (9ce08435) merged in, since the matrix tests 7c's views. Lane 4 (plan `ancient-swimming-book.md`, WP7 "Tests"). Not merged. Not deployed.

- **Implemented:** a fake household API, the matrix test, and one page fix the matrix found.
- **Tested:** the new test and the full web suite in both time zones, build, entry graph, audit.
- **Deployed / enabled:** no / nothing.

## What changed

### `pages/__test-helpers__/fakeHouseholdApi.ts` (new)
- Answers ONE household at the fetch level, so the pages run on the REAL generated hooks.
- It composes `createFakeLedgerServer` for the bank ledger (`/transactions/ledger`, `/balances`, the bulk writes, UI preferences), scoped as `bankLedger.ts` scopes it:
  - the snapshot's account, its mask twins and the manual rows;
  - any other depository account with its own rows and no balance (`otherAccounts`);
  - cards, loans, investment accounts and `refuse` accounts are 400 `account_not_ledger`.
- It adds:
  - `GET /transactions` (the list), with WP7a's exact `plaidAccountId` (a Plaid-less row never matches, an empty value matches nothing), plus `source`, `from`, `to` and `limit`, newest first;
  - `/plaid/items`, `/spine` (with the bank account by id), `/forecast` (the `listCheckingAccounts` list, twins collapsed);
  - empty debts, payoff, liabilities, categories, mapping rules, settings and the Amex anchor.
- Anything else is a recorded 404 (`unknown()`). On these pages that is none.

### `pages/next/accountsLedgerMatrix.test.tsx` (new, 17 tests)
The household: main Chase checking ••5526 (the bank balance's) and its twin on a re-linked item, a second Chase checking, Summit Credit Union checking, Chase Savings, Amex Blue, Chase Freedom (`plaid:chase`), an Upstart loan, a checking account the ledger refuses (unlinked mid-visit), a manual row, an Amex workbook row and a closed account's row. All rows are dated this week, so both ledgers' Week mode shows them.

- **Presence AND absence per route.** Each account page lists exactly its rows, and every other fixture row is asserted absent by its ledger row id:
  - `chk` and `twin`: main + twin + manual;
  - `chase2`, `cu`, `sav`: each one's own row;
  - `blue`: its charge and refund;
  - `freedom`: its charge.
  - Standalone: `/transactions` lists main + twin + manual; `/amex` (All cards) lists Blue + the workbook, and never Freedom.
- **The route rule against the pages:** every row's `txnRoute` href opens a page that lists it. The closed account's row opens nowhere ("No ledger: Chase (no longer linked)"). The loan's row and the refused account's row open pages that say so in words.
- **A card's page** never asks `GET /transactions` without its `plaidAccountId`, and never by source.
- **Bank pages:** they ask the ledger for THAT account (`account=row-…`) and never the old list.
- **Balances:** a non-snapshot account shows "Balance unavailable"; the snapshot's account shows its balance.
- **A loan:** "H2 has no ledger for loans yet.", with no rows and no ledger request.
- **The refusal state:** `chase-no-ledger`; every ledger request names the refused account, with no fallback.
- **The combined view:** every row routed, the one note, no cap line under 100 rows. With a full window it shows "Showing the newest 100 rows of the last 30 days.", and the request is the last 30 days at limit 100.

### `pages/next/Accounts.tsx` — a defect the matrix found
- Before: on an account's route, while `/plaid/items` loaded, the page rendered the combined activity (its "else" branch, because `selected` was still null). That flashed every account's rows, and on a card's page it asked `GET /transactions` with no account.
- Now: an account's route waits for the linked accounts with its own skeleton. A failed read is said above the selector (WP7b), and nothing is guessed below it.

## Figures that move on screen
- **None.** No money figure changes.
- The loading flash on an account route is gone: a skeleton shows instead of the combined activity.

## Fails before
- With the pre-7c pages (`origin/fin/integration`'s `transactions.tsx`, `amex.tsx`, `Accounts.tsx`), 8 of the 17 tests fail: credit union, savings and Freedom pages; card list calls; bank-page calls; balance unavailable; loan words; refusal.
- The other 9 cover what was already right before 7c (main Chase and its twin, the second Chase checking via PR14, Blue, the standalone ledgers) and 7b's route rule and combined view.

## Gates (on 57632af7)
- root `pnpm run typecheck`: clean.
- web vitest: UTC 2,037 passed / 3 skipped; America/Chicago 2,038 / 2 (214 files).
- `pnpm run build` + `check-entry-graph`: OK at 619.8 KB of 622 KB (no change; the page fix is in a lazy route).
- `pnpm audit --prod`: exit 0, 1 ignored high.
- No API code, so no API suite.

## Unverified
- The fake answers as the server's contracts say (WP7a, PR13/PR14). The harness's own ledger matrix checks the real server on the fixture: 0 failures on 7c's head (`2026-10-13-wp7c-views-deeplinks.md`).
- E2E (Clerk keys).
