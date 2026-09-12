# PR-E — Amex updater fixed; a balance someone entered is never silently replaced

Branch `fix/amex-updater-balance-provenance`, base `origin/main` `df2adda`.

## Owner decision (2)

> A silent updater failure needs fixing, but repairing the integration should not
> silently replace a balance someone deliberately entered. Track whether the active
> balance comes from the bank or a manual override. Continue fetching the bank
> balance while a manual override is active. Show any difference and the dates of
> both values. Let the user explicitly return to the bank balance. Surface sync
> failures and stale balances. For existing balances whose origin is unknown,
> preserve them. Test the repair and preview affected accounts before enabling
> production writes.

## What changed

1. **`refreshAmexAnchor` never writes `debts.balance`** (`lib/amexAnchor.ts`).
   - Bug 1 fixed: the `${debts.plaid_account_id}::text = ANY(${array})` lookup, which
     Postgres rejected on every household with Plaid Amex rows, is gone.
   - Bug 2 fixed: Amex rows resolve through `plaid_accounts.account_id` (the text id
     `transactions.plaid_account_id` holds) to `plaid_accounts.id`, then to linked
     debts. The result reports `accountIds` / `linkedDebtIds`; nothing is written to them.
   - The name-match fallback (first "Amex"/"American Express" debt, no ORDER BY) and the
     `adopt` option are removed.
   - It keeps the estimate in `settings.preferences.amexAnchor` under a row lock,
     merged into that one key: `computedBalance` / `computedAsOf` / `computedTxnCount`
     always; `balance` / `asOf` / `lastAutoBalance` only when the stored balance is its
     own last write (`anchorBalanceIsRefreshOwned`). A balance typed in through
     POST /amex/anchor (no `lastAutoBalance`), or of unknown origin, is kept.
2. **Failures are recorded, never swallowed** (`lib/amexAnchorRefresh.ts`).
   Both empty catches in `plaidSync.ts` and the bare workbook-import call go through
   `refreshAmexAnchorRecorded`. It runs in its own savepoint, then writes
   `refreshError` / `refreshFailedAt` to the pref and, from a sync, a
   `plaid_sync_attempts` row of the new kind `amex_anchor` ("Amex estimate" in
   Settings → Recent activity). The sync and the import always complete. A later
   success clears the pref's error.
3. **Liabilities throws are recorded.** `recordLiabilitiesRefreshThrow` writes a
   `liabilities` failure for anything `fetchLiabilitiesForItem` didn't already record.
   It is used in the GET /debts stale refresh (was `catch {}`), POST /debts/:id/refresh,
   POST /debts/:id/link and POST /plaid/sync.
4. **Debt API provenance (additive, OpenAPI + codegen).**
   - New fields: `bankBalance` (the linked account's cached `liability_balance`),
     `bankBalanceAt`, `bankBalanceStale` (last refresh failed, or older than 48 h),
     `bankRefreshError`, `bankRefreshFailedAt` (the newest `liabilities` attempt for
     the item, when it failed).
   - `balanceSource` and `lastBalanceUpdate` were already returned.
5. **`POST /debts/:id/use-bank-balance`** (`adoptDebtBankBalance`), explicit only.
   - Sets balance = cached bank balance and `balance_source = 'plaid'`, and writes a
     history row.
   - Mirrors `applyLiabilityToDebt`'s balance half: anchors `original_balance` when
     null, archives at $0. APR and minimum are untouched.
   - Returns 400 when unlinked, 409 when there is no bank balance, 404 when the debt
     isn't found. Nothing is fetched from Plaid.
6. **The automatic revolving-Amex sweep links, never adopts.**
   - `linkRevolvingAmexDebts` runs on every liabilities fetch with no click. It used to
     overwrite a same-name manual debt's balance, APR and minimum and flip their
     sources to plaid.
   - It now passes `keepEnteredValues`: link only, and the values and sources stay.
   - Explicit create/link clicks still adopt as before.
7. **Web: `components/debt-bank-balance.tsx`.**
   - Shown in the balance cell on Future Goal (`/avalanche`) and Debts rows. Never on
     the landing or the hero.
   - When a kept balance differs from the bank: "Entered $X · date", "Bank $Y · date",
     "Difference ±$Z", and **Use bank balance**.
   - Also "Bank refresh failed · date" (reason on hover) and "Bank balance old · date".
   - Renders nothing otherwise.
8. `artifacts/api-server/scripts/sql/preview-debt-balance-provenance.sql`: a READ ONLY
   preview, ending in ROLLBACK. Query 1 lists every debt per household. Query 2 lists
   the Amex anchor per household. Run only on the test DB so far.

## Figures that move (before → after)

| Where | Before | After |
|---|---|---|
| Workbook re-import, household with Amex rows and an Amex-named debt | That debt (first name match) set to the all-card Amex transaction sum | Stays at the workbook's Debt Tracker balance |
| Plaid sync, workbook-only Amex rows (no Plaid ids), Amex-named debt equal to `lastAutoBalance` | Debt moved to the sum | Unchanged |
| Plaid sync, household with Plaid Amex rows | Refresh threw every time (Bug 1), swallowed: no debt write, no pref write | No debt write; the pref estimate advances; a failure, if any, is recorded |
| `prefs.amexAnchor` typed in via POST /amex/anchor (or `restoreAmexAnchor.ts`) | Overwritten by the next working refresh | Kept; the estimate is stored beside it |
| GET /amex/anchor `anchor` tier (only when there is no Plaid liability and no Amex debt row) | Value frozen in Plaid households (Bug 1) | A refresh-written anchor advances again; a typed-in one stays |
| Auto-sweep, same-name unlinked manual Amex debt, card ≥ $1,000 with APR + min | Balance/APR/min replaced by Plaid's, sources → plaid | Linked only; entered values kept; bank balance shown beside them |
| Debts / Future Goal rows | — | New lines only where a kept balance ≠ bank, or refresh failed/old |

Run the preview SQL on production to size each row before merge. In query 1,
`old_amex_updater_name_match` and `shows_use_bank_balance` flag the affected debts. In
query 2, `anchor_after_merge` and `estimate_now` show the Amex anchor side.

## Must not change (and didn't)

- `applyLiabilityToDebt` is untouched: bank-sourced debts stay current, non-'plaid'
  sources are never overwritten, and an explicit link still adopts.
- These behave as before: PATCH flipping to manual, payments, POST /debts, pending
  netting, and create-debt-from-Plaid "linked-existing"
  (`plaidCreateDebtFromAccount` passes).
- The spine carries no debt balance (`spineParity` passes). Landing and hero show %
  paid only (web suite passes).
- GET /amex/anchor tier order and `source` enum are unchanged. No caller used the old
  `updatedDebt`; the workbook import's `amex_anchor_updated` count is kept.
- Bank freshness ignores `amex_anchor` attempts: it reads only `transactions` and
  `balance`.
- No DDL. Entry bundle is 574.8 KB against the 580 KB cap (+0.4 KB for the generated
  hook in the shared client chunk).

## Verification

- `pnpm run typecheck`: green.
- Web: `TZ=UTC` 136 files, 1119 passed / 3 skipped. `TZ=America/Chicago` 136 files,
  1120 passed / 2 skipped. Includes the new `debtBankBalance.test.tsx` (7).
- API, full suite: 140 files, 1320 passed / 7 todo.
- `pnpm run build && node scripts/check-entry-graph.mjs`: OK.
- Codegen: generated `src` and `dist` are committed; a re-run leaves the tree clean.
- **New tests fail on `df2adda`:**
  - `debtBalanceProvenance.integration.test.ts`: 8/8 fail.
  - `amexAnchor.integration.test.ts`: 9/11 fail. The 2 that pass are guards for
    unchanged behaviour: no rows → no-op, both sources summed. The Plaid-rows case
    threw at the old `amexAnchor.ts:108`.
  - `amexAnchorRefreshRecorded.integration.test.ts` (4): the file fails to load, since
    the module doesn't exist on base.
  - `debtBankBalance.test.tsx` (7): the file fails to load.
- Acceptance tests covered:
  - Manual $5,000 with a $4,812.40 bank balance: the balance stays and the API returns
    both values, dates and source.
  - use-bank-balance: $4,812.40, source plaid, one history row.
  - The refresh changes no debt (including a never-anchored Amex-named one) and no
    longer throws; the lookup matches on `account_id`.
  - Thrown liabilities refresh (Plaid and non-Plaid) and thrown anchor refresh (sync,
    and an in-transaction SQL error): a failure is recorded, the sync or transaction
    completes, and no balance moves.

## Residuals

1. The Amex estimate's failure shows in Settings → Recent activity and in the pref, not
   on the Amex page. GET /amex/anchor doesn't expose it.
2. Only failures are written as `amex_anchor` attempts. After recovery the old failure
   row stays in Recent activity; the pref's error clears.
3. `bankRefreshError` reads only the newest `liabilities` attempt. While a refresh keeps
   failing, each GET /debts writes another failure row, as the existing Plaid-failure
   path already did.
4. "Use bank balance" uses the cached bank figure. When it is old, the row shows the
   date and "old"; no fetch happens on the click.
5. The OpenAPI `balanceSource` enum is still `[plaid, manual]`. A stored other value is
   returned as-is and treated as kept.
6. `scripts/src/restoreAmexAnchor.ts` still writes a debt balance when someone runs it
   by hand.

## Owner decisions still open

- Explicit clicks still adopt the bank's balance, APR and minimum: Link on a debt, and
  create-debt-from-Plaid onto a same-name manual debt. Only the unattended paths were
  changed. Confirm clicks should keep adopting.
- A refresh-written `prefs.amexAnchor.balance` resumes advancing after merge. A
  typed-in one is kept until DELETE /amex/anchor. Confirm, after reading query 2 on
  production.
