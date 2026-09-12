# PR-E — Amex updater fixed; a balance someone entered is never silently replaced

Branch `fix/amex-updater-balance-provenance`, base `origin/main` `df2adda`.
Round 1 `d356c535`; round 2 answers the review (REQUEST CHANGES: H1, H2, M1, the
LOW items and the NIT).

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
   - The `ANY(${array})` lookup Postgres rejected is gone.
   - Amex rows resolve through `plaid_accounts.account_id` to linked debts, scoped to
     the owner's household. A member-linked debt counts; another household's never
     does. These are reported only, never written.
   - The name-match fallback and `adopt` are removed.
   - The estimate is kept in `settings.preferences.amexAnchor` under a row lock:
     - `computedBalance` / `computedAsOf` / `computedTxnCount` always;
     - `balance` / `asOf` / `lastAutoBalance` only when the stored balance is the
       refresh's own last write. A typed-in or unknown-origin anchor is kept.
2. **Failures are recorded, never swallowed** (`lib/amexAnchorRefresh.ts`).
   - The empty catches in `plaidSync.ts` and the bare import call now use a
     savepoint, a pref `refreshError`, and an `amex_anchor` attempt row from a sync.
   - The sync and the import always complete.
3. **Liabilities failures.**
   - `recordLiabilitiesRefreshThrow` records throws the fetch didn't record itself
     (GET /debts, POST /debts/:id/refresh, POST /debts/:id/link, POST /plaid/sync).
   - (review) A failed `/accounts/get` alone is no longer recorded as a failure:
     `/liabilities/get` answered and its accounts refreshed the balances. Only a
     failed `/liabilities/get` is.
4. **Attempt rows** (review, `lib/plaidSyncAttempts.ts`).
   - A failure identical to the item's newest attempt of that kind within the hour
     moves that row's timestamp (database clock) instead of adding a row, so a
     failing streak can't prune away the `transactions` / `balance` attempts bank
     freshness reads.
   - Recent activity lists an item's attempts whoever wrote them; the route still
     checks the item is the caller's household's.
5. **Debt API provenance** (additive, OpenAPI + codegen): `bankBalance`,
   `bankBalanceAt`, `bankBalanceStale`, `bankRefreshError`, `bankRefreshFailedAt`.
6. **`POST /debts/:id/use-bank-balance`**, explicit only.
   - Sets balance = cached bank balance, source plaid, and writes a history row.
   - 400 unlinked / 409 no bank balance / 404 not found.
7. **Entered dates** (review H1).
   - PATCH /debts/:id stamps `last_balance_update = now` whenever it changes the
     balance, and POST /debts does when given one. A caller that sends
     `lastBalanceUpdate` itself wins.
8. **Amex page date** (review H2).
   - GET /amex/anchor dates a debt-row answer by the debts' own balance date:
     `last_balance_update`, else `created_at`, latest across rows.
   - It no longer uses `updated_at` or the saved anchor's `asOf`.
9. **Automatic revolving-Amex sweep.**
   - It links a same-name manual debt without adopting its balance, APR or minimum.
   - (review) It fills an empty due/statement day; a typed one stays. Explicit
     create/link clicks still adopt.
10. **Web** (`components/debt-bank-balance.tsx`, Future Goal and Debts rows only).
    - When they differ: "Entered $X · date", "Bank $Y · date", "Difference ±$Z" and
      **Use bank balance**.
    - "Couldn't refresh the bank balance · date" and "Bank balance old · date".
    - (review) The failure line is a plain sentence, never the stored error text.
      Both lines hide when the page-top reconnect banner already covers that item.
11. **Preview SQL** (`artifacts/api-server/scripts/sql/preview-debt-balance-provenance.sql`),
    READ ONLY, ending in ROLLBACK.
    - Query 1, per debt:
      - the three row lines (`shows_use_bank_balance` / `shows_refresh_failed` /
        `shows_bank_balance_old`, with `reconnect_banner_covers`);
      - the H1 symptom (`entered_date_unknown`, `entered_date_behind_balance_change`,
        and the looser `entered_date_older_than_updated_at`);
      - `old_amex_updater_name_match`.
    - Query 2, per household: the Amex page source and label today and after merge,
      the debt-row date today and after, and the saved anchor's fate. Zero Amex rows
      reads "the refresh writes nothing".
    - Query 3: the Amex cards the sweep will link to a same-name manual debt.
    - `previewDebtBalanceProvenanceSql.integration.test.ts` runs the file itself
      against seeded households and checks every flag. It has run on the test DB only.

## Figures that move (before → after)

| Where | Before | After |
|---|---|---|
| Workbook re-import, Amex rows + an Amex-named debt | That debt set to the all-card Amex transaction sum | Stays at the workbook's balance |
| Plaid sync, workbook-only Amex rows, Amex-named debt equal to `lastAutoBalance` | Debt moved to the sum | Unchanged |
| Plaid sync, Plaid Amex rows | Refresh threw every time, swallowed | No debt write; estimate advances; failures recorded |
| `prefs.amexAnchor` typed in (POST /amex/anchor, `restoreAmexAnchor.ts`) | Overwritten by the next working refresh | Kept; estimate stored beside it |
| **Amex page label**, household with Amex rows and an Amex Plaid item but no saved anchor and no debt/Plaid balance | "Calculated" (the refresh threw, so no anchor was ever written) | "From saved anchor" after its next Amex sync (query 2 `source_after_merge`) |
| **Amex page, debt-row answer** (H2) — e.g. a manual "American Express" $1,000 dated Sep 1, charges $100 Sep 3 + $50 Sep 5, an updater-written anchor | main: dated the later of `updated_at` and the anchor's asOf; round 1: the refresh moved the anchor to today → $1,000 as of Sep 11, the $150 lost | $1,000 as of Sep 1 → September ends at $1,150 (query 2 `debt_tier_as_of_today` / `_after_merge`) |
| **Hand-edited debts** (H1) | PATCH kept the old `last_balance_update`; POST left it null | Dated at the edit/create |
| ↳ Amex page, hand-edited Amex-named debt | Rolled forward from the old date, counting charges already inside the typed balance (`amexEndingBalance.ts:263`, `amex.tsx:837/882`) | Rolls forward from the edit date |
| ↳ Pending netting (effective balance, % paid) of a hand-edited manual debt | Payments tagged since the OLD date were subtracted from the new typed balance; a debt created by hand (null date) netted every tagged payment ever | Only payments after the edit/create count as pending |
| Auto-sweep, same-name unlinked manual Amex debt (≥ $1,000, APR + min) | Balance/APR/min replaced by Plaid's, sources → plaid | Linked only; entered values kept; empty due/statement day filled (query 3) |
| Debt row "refresh failed" | Also shown when only `/accounts/get` failed; the raw error text on hover; repeated under the reconnect banner | Only when `/liabilities/get` failed; plain sentence; hidden under the banner |
| Settings → Recent activity | A member's sync attempts hidden from the owner; one row per failing retry | Every attempt on the household's item; a repeated failure is one row |

## Must not change (and didn't)

- `applyLiabilityToDebt` is untouched: bank-sourced debts stay current, non-'plaid'
  sources are never overwritten, and an explicit link adopts.
- These behave as before: PATCH flipping to manual, payments, and create-debt-from-Plaid
  "linked-existing" (`plaidCreateDebtFromAccount` passes).
- The spine carries no debt balance (`spineParity` passes). Landing and hero show %
  paid only (web suite passes).
- GET /amex/anchor tier order and `source` enum are unchanged; plaid, anchor and
  computed answers keep their dates.
- Bank freshness ignores `amex_anchor` attempts and still sees the newest balance
  attempt after a burst (`plaidSyncAttemptBurst`).
- No DDL.

## Verification (round 2, head in the report)

- `pnpm run typecheck`: green.
- Web: `TZ=UTC` 136 files, 1120 passed / 3 skipped. `TZ=America/Chicago` 136 files,
  1121 passed / 2 skipped.
- API, full suite: 143 files, 1336 passed / 7 todo.
- `pnpm run build && node scripts/check-entry-graph.mjs`: OK, landing 574.8 KB against
  the 580 KB cap.
- Codegen: re-run leaves the tree clean. No spec change in round 2.
- **Round-2 tests fail on `d356c535`** — 12 API failed and 1 file errored, 2 web failed:
  - `debtBalanceProvenance`, 4: sweep due/statement fill; H1 PATCH-then-GET; H1 POST;
    accounts-only failure.
  - `amexAnchorRoute`, 1: the debt-row date.
  - `amexAnchorDebtAsOf`, 3/3: $1,150 with a refreshed anchor, with no anchor, and
    the creation-date fallback.
  - `amexAnchor`, 1: the member-linked debt.
  - `plaidSyncAttemptBurst`, 3/3: burst/freshness, repeat rules, member row visible.
  - `previewDebtBalanceProvenanceSql`: errors in setup, since the old file has 2
    SELECTs, so its 4 tests don't run.
  - `debtBankBalance.test.tsx`, 2: plain failure line; banner covers.
  - Guards that pass on both: a non-balance PATCH keeps its date; a liabilities-call
    failure is still recorded.
- Round-1 fails-before on `df2adda` stands: provenance 8/8, anchor 9/11, recorded
  refresh (file missing), web (file missing).

## Residuals

1. The Amex estimate's failure shows in Settings → Recent activity and the pref, not on
   the Amex page.
2. Only failures are written as `amex_anchor` attempts; a recovered failure row stays
   in Recent activity (the pref clears).
3. While a refresh keeps failing, every GET /debts still calls Plaid again; the
   repeated failure now updates one row per hour instead of adding rows.
4. "Use bank balance" uses the cached bank figure; an old one shows its date and "old".
5. The `balanceSource` enum is still `[plaid, manual]`; any other stored value is
   returned as-is and treated as kept.
6. `scripts/src/restoreAmexAnchor.ts` still writes a debt balance when run by hand.
7. **Frozen figure after a relink.** If an Amex item is removed and re-added, the
   sweep links the old debt row again and keeps its last figure. If that row's source
   is manual (e.g. it was unlinked via the route first), the page labels it "Entered"
   although nobody typed it, until someone chooses "Use bank balance". A plaid-sourced
   row is adopted by the next refresh as before.
8. **`POST /debts/sync-minimums`** (`routes/debts.ts` ~:560) overwrites `min_payment`
   from transaction descriptions for any non-plaid source. It predates this PR and has
   no web caller.
9. **+0.4 KB on the landing** (574.4 → 574.8 KB, cap 580) comes from the generated
   hook in the shared `api.ts` chunk. Accepted for now; a separate PR splits the
   generated client.
10. A debt-row answer combining several Amex debts is dated by the latest balance date
    among them (as before with `updated_at`). A workbook-imported debt (no balance
    date) is dated by its creation.
11. A caller that sends `lastBalanceUpdate` with a PATCH/POST balance keeps that date.
    The web never sends one.

## Owner decisions still open

- Explicit clicks still adopt the bank's balance, APR and minimum (Link on a debt,
  create-debt-from-Plaid onto a same-name manual debt). Confirm.
- A refresh-written `prefs.amexAnchor.balance` resumes advancing after merge; a typed-in
  one is kept until DELETE /amex/anchor. Confirm after reading query 2 on production.
