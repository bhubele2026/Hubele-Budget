# WP7b — one route rule for where a transaction opens (web)

Branch `fin/wp7b-account-route`, from `origin/main` 8b869e79 (WP7a is not under it; 7b does not need it). Lane 4 of the financial-consistency build (plan `ancient-swimming-book.md`, root cause 9, WP7 "One route helper"). Not merged. Not deployed.

- **Implemented:** the route rule, its five producers, `TxnTable.note`, the combined view's cap line, the dead Chase helpers removed.
- **Tested:** unit + component tests (below), web suite in both time zones, API suite (one API comment changed), build, entry graph, audit.
- **Deployed / enabled:** no / nothing.

## What changed

### `src/lib/accountRoute.ts` — `txnRoute(txn, entries, { extra })` (pure)
Built on `resolveTxnAccount` (the row's identity, by the EXTERNAL account id), `buildEntries` entries, and avalanche-core `isBankRow`. In order, a row:
1. on a **linked** account → `/next/accounts/<ext>?tx=<id>&month=<YYYY-MM-01>`, label "Chase Total Checking ••4821";
2. otherwise, from a source the **American Express page lists** (`AMEX_SOURCES`: the workbook `amex`, `plaid:amex`, `plaid:apple-card`, `apple-card`) → `/amex?tx=&month=`, label "Amex (imported) · All cards";
3. otherwise, with **no Plaid account** and on the bank ledger by `isBankRow` (a manual entry, any source that names no card) → `/transactions?tx=&month=`, label "Checking ledger";
4. otherwise → `href: null` and a note: "No ledger: Chase (no longer linked)" for a `plaid:*` row ("No ledger: its account is not linked" for anything else).

- `month` is the row's own month (a timestamp is read to its day); `extra` params (the income row's `category`) follow, encoded; empty ones are dropped.
- ⚠️ **One rule wider than the plan's text:** the plan says "`plaid:*` with no entry → href null". An unlinked `plaid:amex` / `plaid:apple-card` row is listed by `/amex` All cards (the page queries by its source list, `amex.tsx:372-403`, and All cards filters by nothing else), so it opens there instead of saying "No ledger". Every other unlinked `plaid:*` row gets the plan's null + note. Reverting is one branch in `txnRoute`.

### Supporting modules
- `src/lib/accountPage.ts` `accountPageHref({ plaidAccountId, rowId })`: an account's page by its external id, falling back to the row id (the page accepts either). Its own tiny module so the landing's Accounts panel can link without loading the route rules. `accountRoute.ts` re-exports it.
- `src/lib/amexSources.ts` `AMEX_SOURCES`: moved verbatim out of `pages/amex.tsx` so the page's query and rule 2 share one list.
- `components/next/shortDate.ts`: `shortDate` moved verbatim out of `TxnTable.tsx` (see Bundle).

### Producers
| Surface | Before | After |
|---|---|---|
| Dashboard · Recent activity (`ActivityPanel.tsx`) | linked → `/next/accounts/<ext>`; everything else → `/transactions` | `txnRoute`; a row with no ledger shows its note and no link. (Review fix) While the linked accounts load, or after they failed, a Plaid row has no link and no note and its chip names only the institution (`kind: "unknown"`); a failure adds "Your linked accounts did not load … Try again". Workbook and manual rows still open |
| Dashboard · Needs attention, income row (`AttentionPanel.tsx`) | `/transactions?tx=&category=` whatever the account | `txnRoute` with `category`; no ledger → a plain row whose detail ends with the note; the check waits for the linked accounts (without them every row would read "no longer linked"), and their failure shows "did not load · Try again" |
| Dashboard · Accounts (`AccountsPanel.tsx`) | `/next/accounts/<row id>` | `accountPageHref` (external id). Only the href line and one import line changed (lane 2 owns this file) |
| Accounts · account chips (`AccountSelector.tsx`) | `/next/accounts/<ext>` (inline) | `accountPageHref(e)` — same href |
| Accounts · combined view (`Accounts.tsx` `CombinedActivity`) | linked → account page; everything else not a link | `txnRoute` + notes; "Showing the newest 100 rows of the last 30 days." when the 100-row window is full. (Review fix) Unknown accounts as on the dashboard; a failed accounts read says "Your linked accounts did not load. Try again" (was "No linked accounts yet.") and an account's page no longer says "That account is not linked here" while the list is unknown |
| `TxnTable` | — | `note?: string` on a row, drawn only when the row has no `href` (table: a second line under the description; list: in the facts line) |

### Review fixes (independent review of 58ff920b)
- **Major — unknown read as "no longer linked".** `ActivityPanel` built its account map from `items.data`, which is undefined while `/plaid/items` loads or after it fails, so every linked Plaid row took rule 4: "No ledger: Chase (no longer linked)" and no link. `txnRoute` gains `entriesKnown`; with `false` a row with a Plaid account is `kind: "unknown"` (no href, no note, chip = the institution without "(no longer linked)"). Recent activity and the combined view pass it; a failure shows "did not load · Try again". (The income row already waited for the accounts.)
- **Accounts page on an items error:** "No linked accounts yet." and false notes → the failure line with Try again, rows unknown.
- **Minor:** `lib/accountBalance.ts computeBalanceAtEndOfDate` was dead (its only caller was the deleted `chaseEndingBalance.ts`) and untested: deleted. The stale comment that named it (`api-server/src/__tests__/cashSignal.integration.test.ts:1808`) now points at the server ledger.
- Tests: `accountRoute.test.ts` (+1, unknown), `dashboard.test.tsx` (+2: items loading, items failed), `Accounts.test.tsx` (+3: failed, failed on an account page, loading).
- Gates on ac476c51: typecheck clean; web UTC 1,885 passed / 3 skipped, America/Chicago 1,886 / 2 (204 files); build + entry graph OK at 618.4 KB; audit exit 0 (1 ignored high).

### Dead code removed
- `lib/chaseScope.ts`, `lib/chaseEndingBalance.ts` and both tests (no product caller since the Chase page reads the server ledger; `docs/reviews/2026-10-08-parity-verified.md:680-681`). `accountBalance.ts` keeps its own test.
- Stale comments fixed: `lib/amexEndingBalance.ts` (said it mirrored `chaseEndingBalance.ts`), `api-server/src/lib/budgetSeed.ts:36,363` (named it among the balance helpers; now the server ledger), and `docs/manifesto-coverage.md` row M12.

## Root cause (on main 8b869e79)
- `pages/next/dashboard/ActivityPanel.tsx:45`: any row not on a linked account linked to `/transactions` — the checking ledger, which does not list an Amex workbook row or a closed card's row (a dead end), and no link carried the row or its month.
- `pages/next/Accounts.tsx:49`: the combined view linked only linked rows; `:31` cut at 100 rows without saying so (CLAUDE.md §2: a capped pull discloses its cap).
- `pages/next/dashboard/AttentionPanel.tsx:191`: the income row always opened `/transactions`.
- `pages/next/dashboard/AccountsPanel.tsx:138`: the internal row id, unlike every other account link.

## Figures that move on screen (fixture)
- **No money figure moves.** Only link targets and words:
  - `normal`: Recent activity's workbook refund now opens `/amex?tx=…&month=2026-10-01` (was `/transactions`); the manual row opens `/transactions?tx=…&month=2026-10-01` (was `/transactions`); linked rows gain `?tx=&month=`. The Accounts panel's links read the external id (same page).
  - With an unlinked account's row (`gone` overlay): the row loses its dead `/transactions` link and reads "No ledger: <Institution> (no longer linked)".
  - The combined view's cap line appears only with 100 rows in 30 days (not in the base scenarios).
- Landing JS **621.8 → 618.4 KB** (cap 622 unchanged).

## Bundle
- `TxnTable.tsx` held `shortDate`, which the landing's dashboard helpers (`pages/next/dashboard/shared.tsx:4`) use, so the whole table sat in the entry chunk although only lazy panels draw it (Rollup keeps a module whole in the chunk of anything using one of its exports). With `shortDate` in its own module the table, the route rules and `isBankRow` (constant-folded to its Plaid-less branch) share one lazy chunk (`entries-*.js`, 6.0 KB) used by the dashboard's lower panels and the Accounts page.
- Before the move the route work measured **622.2 KB** (over by 0.2 KB: the `note` lines sit in `TxnTable`); after, **618.4 KB**. I did not lower the cap: five lanes share it.
- `isBankRow` was not already in the entry chunk (the brief thought it came with `uncategorizedSpend.ts`; that module is Reports-only). It stays off the open path.

## Tests
- **New** `lib/accountRoute.test.ts` (23): every rule per kind (linked checking, savings, non-Amex card, Amex card, loan; workbook; unlinked Amex; manual, imported file, no source; gone bank; unknown account), encoding, array vs Map, the internal id never matching, blank ids, no accounts at all, month from timestamps and from no day, extra params, identity = `resolveTxnAccount`; `accountPageHref` external / fallback / entries / one helper.
- `components/next/next.test.tsx` (+2): a row with no href shows its note (both layouts), is not a link and does not open; a row with an href never shows one.
- `dashboard.test.tsx` (+3, 1 updated): Recent activity hrefs per kind (checking, Amex, Capital One, workbook, manual, gone + note); the income row per kind (linked, manual, gone as a plain row with the note and count); the income check waits for the linked accounts (loading, failed); the Accounts panel links by external id.
- `Accounts.test.tsx` (+3): the combined view's hrefs per kind + the one note; the cap line at 100 rows and not at 99; the chips' hrefs.
- **Fails before:** the per-kind href expectations (`?tx=&month=`, `/amex`, the note) cannot pass on main's producers.

## Gates (on 81288c74; the note is the only later change)
- root `pnpm run typecheck`: clean.
- web vitest: UTC 1,879 passed / 3 skipped; America/Chicago 1,880 passed / 2 skipped (204 files: −2 deleted, +1 new).
- API suite on `h2budget_test_fin_4` (one comment changed in `budgetSeed.ts`): 238 files, 2,575 passed, 2 todo.
- `pnpm run build` + `check-entry-graph`: OK, landing **618.4 KB** of 622 KB (main 621.8).
- `pnpm audit --prod`: exit 0; 1 high, the already-ignored one.

## Fixture evidence (`normal+accounts+gone`, ports 5184/3344, harness overlays)
- **Checks (`checks.sh`):** 5 of 5 pass — reach (all 25 links on `/home` open: no 404, no error boundary, no page error, incl. the new `?tx=&month=` routes, `/amex?tx=…` for the workbook row, the income row's `…&category=`), keyboard, axe at 1280 and 390, overflow and names, reduced motion. Results: `dash-shots/fin4-wp7b/checks/normal+accounts+gone.json`.
- **Probe (`fin4-probe.mjs`, read-only):** every row of Recent activity (6) and the combined view (32) routed by kind; the gone account's WALGREENS row has no link and reads "No ledger: Chase (no longer linked)". Opening each destination: 22 of 32 show the row. The 10 that do not are exactly WP7c's cases, which this branch only routes to:
  - Chase Freedom ×2, Quicksilver ×2: the embedded Amex ledger still asks by the Amex source list (empty);
  - Summit CU checking ×2: the embedded Chase ledger still self-heals to the main Chase account;
  - Chase savings ×1: "no activity view yet";
  - Platinum ×2 and the workbook payment ×1: current-month rows outside this week, and the Amex ledger opens in Week mode.

## Unverified
- The destinations' own behaviour on arrival: until WP7c, `/amex` opens on the row's month in Week mode (a row outside this week is filtered out), a card's account page still asks by the Amex source list, and the embedded Chase ledger still self-heals a non-Chase checking account. WP7c fixes those.
- `askWords.refHref` (Ask answers) and `legacyRoutes` still open `/transactions?tx=` from an id alone; they know no account and are outside this package.
- E2E (Clerk keys).
