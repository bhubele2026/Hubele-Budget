# WP7c — each account opens its own ledger; row links open Month mode (web)

Branch `fin/wp7c-views-deeplinks`, from `origin/fin/integration` e94016de (main + WP7a) with the fixed WP7b merged, then `origin/fin/integration` 997aad0 (batch 1, = main) merged in (c0092755). Lane 4 of the financial-consistency build (plan `ancient-swimming-book.md`, root cause 9, WP7 "Per-kind views" and "Deep links"). Not merged. Not deployed.

- **Implemented:** per-kind account views, the embedded bank and card ledgers for one account, row links in Month mode on both ledgers.
- **Tested:** component tests (below), web suite in both time zones, build, entry graph, audit; the harness's ledger matrix and shots on `normal+accounts` and `normal+accounts+gone`.
- **Deployed / enabled:** no / nothing.
- **Owner's OK used:** "any checking/savings account opens its own ledger" (2026-10-09). The server half is WP7a (on integration).

## What changed

### Accounts page — one view per kind (`pages/next/Accounts.tsx`, `accounts/entries.ts`)
- `accountViewOf(entry)` (pure): a card → `card`; a checking, savings or other depository account → `bank`; a loan → `loan`; anything else → `other`. "Depository" is the server's own rule (`bankLedger.ts isDepository`: subtype checking or savings, or type depository), carried on the entry as `depository`, so the page opens a ledger exactly when the server has one.
- `card` → the Amex page's layout, embedded for that card (any bank's card).
- `bank` → the Chase page's layout, embedded for THAT account (any bank, savings included). Before, only `kind === "checking"` was embedded; savings said "no activity view yet".
- `loan` → "H2 has no ledger for loans yet."; `other` → "H2 has no ledger for this kind of account yet." (both beside the account's Summary).
- Batch 1 merged without loss: every branch still hands `AccountSummary` WP3b's `pending` (debts / bank unknown or failed), `liability` and `bank` props, and the WP3b failure lines and WP7b's unknown-accounts states stay above the selector.

### Bank ledger embedded for one account (`pages/transactions.tsx`)
- **No self-heal:** the effect that swapped an account missing from the Chase-only list for the bank balance's account is skipped when embedded. That swap put the main Chase ledger under a credit union account's title.
- **No reset on refusal:** a 400 `account_not_ledger` / `invalid_account` no longer falls back to another account when embedded (no toast either). The ledger panel says so in place (`chase-no-ledger`, role=status): "H2 has no ledger for this account. The ledger lists this household's checking and savings accounts, and this one is not among them now. It may have been unlinked." The figures panel reads "No ledger for this account." instead of "No checking account linked."
- **`pickerAccounts`:** embedded, the page's account list is every linked depository account the forecast names (`forecastData.plaidCheckingAccounts`), not the Chase-only one. The account's digits, its snapshot entry and the picker come from it. In the picker, a pick opens that account's page (the title and the ledger always name the same account) instead of switching in place.
- **No persistence when embedded:** neither `?account=` nor the Chase page's saved pick (`h2budget:chase-account`) is written from an account page (each account page used to overwrite the standalone page's remembered account).
- The balance panel is titled "Savings balance" for a savings account (it said "Checking balance").
- Standalone `/transactions` is unchanged: Chase-only list, self-heal, reset on refusal with its toast.

### Card ledger embedded for one card (`pages/amex.tsx`)
- Embedded, both list reads ask `GET /transactions?plaidAccountId=<ext>` (WP7a's parameter) instead of the Amex source list, so a Chase Freedom (`source: "plaid:chase"`) lists its own rows. Standalone `/amex` keeps the source list: All cards is the one view that lists the workbook rows.
- Embedded, the card band does not filter in place (the page holds one card's rows): another card opens that card's page; All cards opens `/amex`.

### Row links (`?tx=`), both ledgers (`lib/rowDeepLink.ts`)
- `?tx=<id>` opens **Month mode** on the row's month (`?month=`, which `lib/accountRoute.ts` always adds; this month when absent). Week mode hid a row from earlier in the month.
- A `role="status"` line: "Showing October 2026 for the row you opened", while the page is on that month in Month mode.
- Amex: the first-load jump to the latest month never moves a month a link chose (`?month=` or a row link) — it used to override the Budget page's `?month=` links too.
- Chase: `?tx=` with no `?account=` reads the bank balance's account (the ledger that lists the rows such links point at), never the saved pick, and leaves the saved pick in place.
- Chase: the row's focus scroll escapes the id itself (only `"` and `\` in an attribute value) instead of `CSS.escape`, as `useTxDeepLink` does.

## Root cause (on main 8b869e79)
- `pages/next/Accounts.tsx:119`: only a `checking` account embedded the bank ledger; `:142` every card embedded the Amex page, which asked by the Amex source list (`pages/amex.tsx:129`, `:372-403`), so a Chase Freedom's page was empty; `:162-172` savings: "no activity view yet".
- `pages/transactions.tsx:252-261` (Chase-only list), `:418-441` (self-heal), `:571-577` (reset on refusal): a credit union's checking account page showed the main Chase ledger.
- `pages/transactions.tsx:181-191`: the saved pick won over a row link with no `?account=`; `:468-470` Week mode unless `?month=`.
- `pages/amex.tsx:257`: always Week mode; `:583-607`: the first-load jump overrode a linked month.

## Figures that move on screen (fixture)
Fixture `normal+accounts` (harness overlays; before = the lead's main shots in `fin-shots/before/normal+accounts`, after = `dash-shots/fin4-wp7c/normal+accounts`):

| Page | Before (main) | After (this branch) |
|---|---|---|
| `/next/accounts/{cu}` (Summit Checking ••2290) | the MAIN checking ledger under the credit union's title: picker "Chase ••5526 · snapshot"; Money in vs out In $2,100.00 · Out $851.45 · Net +$1,248.55; "Checking balance $4,812.37, Start $3,563.82, End $4,812.37"; Chase's rows | its own: "Summit Credit Union ••2290"; In $150.00 · Out $18.40 · Net +$131.60; "Balance unavailable" (not the snapshot's account), Start — End —; its 2 rows |
| `/next/accounts/{savings}` | Summary + "This account type has no activity view yet." | the savings ledger: "Savings balance · Balance unavailable", its rows by range (this week: none, Net $0.00, a real zero) |
| `/next/accounts/{freedom}`, `{quicksilver}` | "No transactions match these filters." | their own rows (Freedom: Panera $14.82, Amazon $63.18) |
| `/amex?tx={workbook}` | Week mode | Month mode + "Showing October 2026 for the row you opened" |
| `/transactions?tx={deeplinkChk}&month={deeplinkChk:month}` | Week mode, the Sep 15 row missing | Month mode on September, "Showing September 2026 for the row you opened", the row listed |

- The money figures that move are the credit-union page's: they stop being the main account's (In $2,100.00 / Out $851.45 / $4,812.37) and become its own (In $150.00 / Out $18.40, no balance). No other account's figures change; the dashboard is untouched.
- Harness ledger matrix (`FIXTURE_MATRIX=1`, `normal+accounts`): main 18 failures → **0** on c0092755. Every account page lists its own rows only (`{savings}` 29/29, `{freedom}` 30/30, `{quicksilver}` 30/30, `{cu}` 30/30, `{chase2}` 30/30 …), both deep links land, all 6 `/home` row links land on their row. Shots (1280×800, 390×844, `FIXTURE_PATHS=fin`, 0 console errors, 0 failed calls): `dash-shots/fin4-wp7c-final/normal+accounts/`.
- **Kit change (the lead's decision, no server lookup):** a row link carries its month, like every in-app link from `lib/accountRoute.ts`. The kit's `fin` paths are now `/transactions?tx={deeplinkChk}&month={deeplinkChk:month}` and `/amex?tx={workbook}&month={workbook:month}`; `{row:month}` expands from `/api/__fixture` `seeded`; the matrix's deep links add the month the same way; shot names are unchanged (the `&month=` part is left out of them). README updated.

## Tests
- **New** `pages/chaseDeepLink.test.tsx` (13, the real ledger hooks over `fakeLedgerServer`): Month mode on `?tx=&month=` and on `?tx=` alone; the status line (and it leaves on another month; none without a row link); the saved pick ignored and kept; `?account=` honoured; saved pick still used without a row link; embedded credit-union checking (its rows, digits from the full list, no swap, nothing persisted); savings (title); embedded refusal (in place, no fallback request, no toast); standalone refusal unchanged; the embedded picker lists every depository account and navigates; the standalone picker unchanged; embedded + row link.
- **New** `pages/amexDeepLink.test.tsx` (7): embedded asks by `plaidAccountId` and never by source; standalone keeps the source list; the embedded band navigates; Month mode + status line; Week mode without a link; the first-load jump never moves a linked month; embedded + row link.
- `amexLayout.test.tsx` (+2): the embedded card's reads carry `plaidAccountId` and no source; standalone the source list.
- `Accounts.test.tsx` (+6): credit-union checking, savings and PayPal open the bank ledger for that account; a non-Amex card the card ledger; a loan and an investment account say so; `accountViewOf` table.
- **Fails before:** with the pre-7c page code, 18 of these fail (mutation run; the shims only stand in for the new export).

## Gates
- On c0092755 (after the batch-1 merge): root `pnpm run typecheck` clean; web vitest UTC 2,020 passed / 3 skipped, America/Chicago 2,021 / 2 (213 files); `pnpm run build` + `check-entry-graph` OK at **619.8 KB** of 622 KB (this package adds nothing to the open path: the two ledgers, the Accounts page, `entries.ts` and `lib/rowDeepLink.ts` are lazy); `pnpm audit --prod` exit 0 (1 ignored high). No API code in this package (WP7a is underneath), so no API suite.

## Unverified
- A row link to a row that is NOT on the ledger's first page (50 rows, newest first) in a busy month: Month mode is right, but the Chase ledger does not page on until it finds the row. The Amex page loads the whole month (1,000 rows).
- A row link while "Hide reviewed" is on and the row is reviewed: the row stays hidden on both ledgers.
- `askWords.refHref` (Ask answers, proposals, memory) and `legacyRoutes` open `/transactions?tx=` with no month: Month mode on THIS month, which misses an older row. Decided: no server lookup; in-app links carry their month (the route rule), and these two know only an id.
- The Amex trend read still uses `limit: 5000` (pre-existing; CLAUDE.md §2 bans it) — now per card when embedded. Not changed here.
- E2E (Clerk keys).
