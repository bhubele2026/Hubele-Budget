# PR-E — Amex updater fixed; a balance someone entered is never silently replaced

Branch `fix/amex-updater-balance-provenance`, base `origin/main` `df2adda`.
Round 1 `d356c535`; round 2 `c0eca735` answers the first review (H1, H2, M1, the
LOW items, the NIT); round 3 answers the second look (H3 and three LOW items) on
top of `origin/main` `1a0c1f71` (PR-A, merged in). Round 4 (`46668d6b`) tried
gating a debt's first history row on `debts.updated_at`; round 5 reverts that —
see the Round 5 section below.

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
   - (round 3) A collapsed streak keeps its size and start. The otherwise-unused
     `cleanup_details` jsonb (no DDL) holds `failureStreak: {count, firstFailedAt}`
     on repeats.
   - The API adds `failureCount` / `firstFailedAt` (additive, codegen).
     `cleanupDetails` is returned only for `pending_cleanup`.
   - Recent activity shows "N times · failing since <date>" and counts every try
     in "Failed X of the last Y".
5. **Debt API provenance** (additive, OpenAPI + codegen): `bankBalance`,
   `bankBalanceAt`, `bankBalanceStale`, `bankRefreshError`, `bankRefreshFailedAt`.
6. **`POST /debts/:id/use-bank-balance`**, explicit only.
   - Sets balance = cached bank balance, source plaid, and writes a history row.
   - 400 unlinked / 409 no bank balance / 404 not found.
7. **Entered dates** (review H1).
   - PATCH /debts/:id stamps `last_balance_update = now` whenever it changes the
     balance, and POST /debts does when given one. A caller that sends
     `lastBalanceUpdate` itself wins.
8. **Amex page date** (review H2, H3; `lib/debtBalanceDate.ts`).
   - GET /amex/anchor dates a debt-row answer by the debts' balance date. For each
     debt it is the LATER of `last_balance_update` (else `created_at`) and the
     household day its balance last changed in `debt_balance_history`. That day is
     the newest row whose balance differs from the row before, and a debt's FIRST
     row always counts as a change (round 3's rule, restored in round 5). Round 4
     tried gating the first row on whether it fell on the household day of the
     debt's `updated_at`, on the theory that a page view writes a row for every
     active debt, so a first row alone is usually a view, not an edit. Round 5
     reverted it — see the Round 5 section below for why. It is the same
     definition as the preview SQL's `last_change`, taken as noon UTC on that day.
   - Across debts the latest date is used. It never uses `updated_at` or the saved
     anchor's `asOf`.
   - History can only move the date later; a stamp on or after the change day wins.
   - Nothing is backfilled: the date is read, never written.
   - PATCH now compares balance, minimum (to the cent) and APR (to 0.0001)
     numerically. "5000" for a stored "5000.00" is not a change: no new date, no
     flip to manual, no history row.
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
      the debt-row date today and after (the H3 rule), and the saved anchor's fate.
      Zero Amex rows reads "the refresh writes nothing".
    - (round 3) Query 2 prices the date move, for the operator to read on production:
      - `debt_tier_date_move`: earlier / later / same day;
      - `debt_tier_date_move_risk`: earlier = counted twice if the balance already
        held the rows; later = dropped if it did not;
      - `amex_rows_between_dates` and the signed `page_total_change`.
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
| **Amex page, legacy / stale balance date** (H3). An "American Express" debt created Jun 1, `last_balance_update` NULL, typed to $1,000 on Sep 1 by the pre-merge PATCH (history row that day). Charges $200 Jun 10, $300 Jul 10, $400 Aug 10, $50 Sep 5 | main: dated by `updated_at` Sep 1 → $1,050 (right by accident; an APR edit after Sep 1 would have dropped the Sep 5 charge). Round 2: dated Jun 1 → $1,950, charges counted twice. The same with an old bank date left in `last_balance_update` | Dated Sep 1, the day the balance last changed → September ends at $1,050. Rule: the later of `last_balance_update ?? created_at` and that history day; no data written. Query 2 flags the move per household with its dollar sum |
| **Amex page, never-edited debt first seen later** (round 4 attempt, reverted round 5). Created Jun 1, never edited (`updated_at` Jun 1), first history row a Jun 15 page view. $1,000; charges $200 Jun 10, $300 Jul 10, $100 Aug 10, $50 Sep 5 | main: dated Jun 1 by `updated_at` → $1,650. Round 4: dated Jun 1 by gating the first row on `updated_at` → $1,650 (this was the round-4 attempt, later found to be unbounded elsewhere) | **Round 5 (current head):** dated Jun 15 by the first row → $1,450, the Jun 10 charge dropped. This is round 3's rule and its documented bounded residual — see Round 5 below |
| **Amex page, legacy raise then a later unrelated edit** (round 5 drift fix). Created Jun 1, a Sep 1 legacy raise (its only history row) to $1,000, then a later APR/name/min PATCH or Plaid refresh moves `updated_at` to Sep 10. Charges $200 Jun 10, $300 Jul 10, $400 Aug 10, $50 Sep 5 | Round 4: the first row (Sep 1) no longer matched the now-later `updated_at` (Sep 10), so it fell back to `created_at` (Jun 1) → $1,950, double-counting everything since creation. Unbounded: any later unrelated edit could trigger this on any legacy debt | **Round 5 (current head):** dated Sep 1 regardless of the later edit → $1,050. The first row always counts, so an unrelated edit can't move the date |
| **PATCH repeating the same number** (`"5000"` for `"5000.00"`) | Treated as a change: re-dated, flipped a bank balance to manual, wrote a history row | No change |
| **Hand-edited debts** (H1) | PATCH kept the old `last_balance_update`; POST left it null | Dated at the edit/create |
| ↳ Amex page, hand-edited Amex-named debt | Rolled forward from the old date, counting charges already inside the typed balance (`amexEndingBalance.ts:263`, `amex.tsx:837/882`) | Rolls forward from the edit date |
| ↳ Pending netting (effective balance, % paid) of a hand-edited manual debt | Payments tagged since the OLD date were subtracted from the new typed balance; a debt created by hand (null date) netted every tagged payment ever | Only payments after the edit/create count as pending |
| Auto-sweep, same-name unlinked manual Amex debt (≥ $1,000, APR + min) | Balance/APR/min replaced by Plaid's, sources → plaid | Linked only; entered values kept; empty due/statement day filled (query 3) |
| Debt row "refresh failed" | Also shown when only `/accounts/get` failed; the raw error text on hover; repeated under the reconnect banner | Only when `/liabilities/get` failed; plain sentence; hidden under the banner |
| Settings → Recent activity | A member's sync attempts hidden from the owner; one row per failing retry | Every attempt on the household's item; a repeated failure is one row showing "N times · failing since <date>"; the "Failed X of the last Y" summary counts every try |

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

## Round 5 — round-4's `updated_at` gate reverted (owner decision)

Round 4's review requested changes on the first-row rule (gate a debt's first
`debt_balance_history` row on whether it falls on the household day of
`debts.updated_at`). The round-4 review reproduced the finding both directions:

- **(a) False negative, unbounded.** A legacy debt (`lastBalanceUpdate` NULL,
  created Jun 1) whose only history row is a Sep 1 legacy raise (`updated_at`
  Sep 1) dates Sep 1 correctly, September ending at $1,050. One later, wholly
  unrelated APR edit moves `updated_at` to Sep 10; the first row (Sep 1) no
  longer matches it, stops counting as a change, and the date falls back to
  `created_at` (Jun 1) — September ends at $1,950, double-counting everything
  since creation. `debts.updated_at` is bumped by writes that have nothing to
  do with the balance: a PATCH /debts/:id name/APR/min/status edit
  (`routes/debts.ts` ~:686) and every Plaid refresh via `applyLiabilityToDebt`
  (~:309). Any later unrelated edit to any legacy debt could trigger this —
  the error is unbounded, growing with how long ago the debt was created.
- **(b) False positive.** A never-edited Jun 1 debt, first viewed Jun 15 with
  an APR edit that same day, is dated Jun 15 → $1,450 instead of the "true"
  $1,650 (the Jun 10 charge dropped).

### Decision (lead): revert to round 3's bounded rule

No read-time signal in the data separates a view-written first row from a real
balance change. The `updated_at` rule's error (a) is unbounded — it can move a
correctly-dated legacy debt's date all the way back to `created_at` on any
later, wholly unrelated edit. Round 3's rule — a debt's first history row
always counts as a change — has a bounded error instead: it can only date a
never-edited legacy debt's balance too early, at most back to its first
history row (usually the same day a debt is created, since it's typically
viewed right after). Round 5 reverts `lib/debtBalanceDate.ts`
(`lastBalanceChangeDayByDebt`, back to taking plain debt ids) and both
`last_change` CTEs in
`artifacts/api-server/scripts/sql/preview-debt-balance-provenance.sql` to
round 3's rule, byte-for-byte the same behaviour as `4ffd429d`.

### The bounded residual (accepted)

A never-edited legacy debt whose first `debt_balance_history` row is a page
view, not an edit, is dated by that view — dropping charges between the
debt's creation and the view. Pinned in
`amexAnchorDebtAsOf.integration.test.ts` ("(known residual)"): created Jun 1,
first history row a Jun 15 view, $200 charged Jun 10 → dated Jun 15, September
ends at $1,450 (not the "true" $1,650), with or without an APR edit landing
the same day as the view — the rule never reads `updated_at`, so an edit that
day changes nothing. Residuals list item 15 has the full writeup.

### Owner item (not implemented here)

The durable fix is a **one-time, owner-approved production backfill of
`last_balance_update` for legacy debts** — it stamps the real answer directly
and makes this function's first-row heuristic moot for backfilled debts. That
is a production write and needs the owner's explicit sign-off; it is
deliberately out of scope for this PR.

## Verification (round 5, head in the report)

Round 5 changes:
- Reverted the round-4 first-row rule in `lib/debtBalanceDate.ts` and both
  `last_change` CTEs of the preview SQL to round 3's rule; removed the now-
  unused `updatedAt` plumbing (`lastBalanceChangeDayByDebt` takes debt ids
  again; `routes/amex.ts`'s `AmexDebtRow` no longer selects `updatedAt`).
  Rewrote the `debtBalanceDate.ts` doc comment with the rule, the bounded
  residual, why `updated_at` was rejected, and the owner backfill item.
- Replaced the round-4 `updated_at` test cases in `amexAnchorDebtAsOf` and
  `previewDebtBalanceProvenanceSql` with the drift-fix case (locks in (a)) and
  the known-residual case (pins (b) as accepted); kept round 3's H3 cases and
  the empty-history fallback.
- `docs/reviews/2026-09-11-amex-updater-provenance.md`: this section, the
  updated figures table, and residuals item 15 (item 13 closed).
- `origin/main` moved (PR-C, `193af636`, recurring/forecast/ledger/
  billsSummary/reviewCount and generated clients) and was merged in; only
  generated `.map` files conflicted, resolved by regenerating via
  `pnpm --filter @workspace/api-spec run codegen`. No spec change from this PR.

Results:
- `pnpm run typecheck`: green.
- Web: `TZ=UTC` 140 files, 1148 passed / 3 skipped. `TZ=America/Chicago` 140 files,
  1149 passed / 2 skipped.
- API, full suite: 146 files, 1416 passed / 7 todo.
- Build + entry graph: OK, landing 574.8 KB against the 580 KB cap (unchanged —
  this PR touches no web code).
- Codegen: no spec change from this PR; PR-C's spec change
  (`recurringItemMoveResult`, `updateRecurringItemResponse`) came in on the
  merge and was regenerated as part of resolving the merge's generated-file
  conflicts.
- **The round-5 drift-fix test fails on `46668d6b`** (round 4's head):
  `amexAnchorDebtAsOf` "(round 5) a legacy raise on Sep 1 ... even after a
  later unrelated edit moves updated_at to Sep 10" — expected dated Sep 1 /
  $1,050, got dated Jun 1 (would price at $1,950). Verified by swapping in
  `46668d6b`'s `debtBalanceDate.ts` / `routes/amex.ts` / preview SQL, running
  just that test, then restoring the round-5 files.
  - Guards passing on both round 4 and round 5: the H3 repro ($1,050 with a
    null date), the stale bank date case, the empty-history fallback, and a
    later `last_balance_update` winning over history.

## Verification (round 4, head in the report)

Round 4 changes:
- The decided first-row rule, in `lib/debtBalanceDate.ts` (the Amex route passes each
  debt's `updated_at`) and in both `last_change` CTEs of the preview SQL, with
  household (America/Chicago) days in both.
- "failing since" in Recent activity is formatted in household time
  (`householdDateTimeLabel`, new in `lib/householdDay.ts` next to
  `householdDayLabel`, which the debt row lines now share).
- `origin/main` has not moved since PR-A2 (`6b355065`).

Results:
- `pnpm run typecheck`: green.
- Web: `TZ=UTC` 137 files, 1123 passed / 3 skipped. `TZ=America/Chicago` 137 files,
  1124 passed / 2 skipped.
- API, full suite: ROUND4_API_COUNTS.
- Build + entry graph: OK, landing 574.8 KB against the 580 KB cap.
- Codegen: no spec change; a re-run leaves the tree clean.
- **Round-4 tests fail on `46cafeb4`** — 2 API, 1 web:
  - `amexAnchorDebtAsOf`: the never-edited debt with a Jun 15 first view
    ($1,450 → $1,650).
  - `previewDebtBalanceProvenanceSql`: household E, the same case in SQL.
  - `plaidSyncHistoryFailureStreak`: "failing since Sep 11, 4:00 AM" in household
    time.
  - Guards passing on both: a legacy raise on the first history day ($1,050); the
    existing H3 cases ($1,050 twice, later date wins, empty history).

## Verification (round 3)

- `pnpm run typecheck`: green.
- Web: `TZ=UTC` 137 files, 1123 passed / 3 skipped. `TZ=America/Chicago` 137 files,
  1124 passed / 2 skipped.
- API, full suite: 144 files, 1351 passed / 7 todo before merging PR-A2. After
  merging `origin/main` `6b355065` (PR-A2), the merge ran clean:
  `SERVER_OWNED_PREFERENCE_KEYS` keeps `amexAnchor` and gains `defaultsSeededAt`;
  there were no schema or spec changes.
  - On the merged tree: 145 files, 1363 passed / 7 todo.
  - The settings / amex / debts files (11) pass, 107 tests.
  - Web on the merged tree is unchanged: 137 files, UTC 1123 / 3 skipped, Chicago
    1124 / 2 skipped.
  - Build is OK at 574.8 KB.
- Build + entry graph: OK, landing 574.8 KB against the 580 KB cap.
- Codegen: spec changed (`failureCount`, `firstFailedAt`); generated `src` and `dist`
  are committed and a re-run leaves the tree clean.
- **Round-3 tests fail on `c0eca735`** — 6 API, 2 web:
  - `amexAnchorDebtAsOf`: the H3 repro ($1,950 → $1,050) and the stale bank date
    ($1,750 → $1,050).
  - `debtBalanceProvenance`: PATCH with the same numbers written differently.
  - `plaidSyncAttemptBurst`: streak count and start.
  - `previewDebtBalanceProvenanceSql`, 2: the date-move columns for household C,
    and household D (H3).
  - `plaidSyncHistoryFailureStreak.test.tsx`, 2: "N times · failing since", and the
    summary counting every try.
  - Guards passing on both: a later `last_balance_update` wins over history; empty
    history falls back to `created_at`; a single failure shows no streak line.

## Verification (round 2)

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
    among them (as before with `updated_at`). A workbook-imported debt with no
    balance date and no history is dated by its creation.
12. **A write that skipped history, then a later view** (round 4). The restore
    script or the old Amex updater changed a balance without writing a history row.
    The next page view on a later day writes a row that differs from the previous
    one, so the balance is dated at that view. Charges between the write and that
    view are dropped; the gap is at most write → next view.
13. ~~**An edit after a legacy first-row change** (round 4, from the decided
    rule).~~ **CLOSED in round 5** — this was round 4's own bug, fixed by
    reverting the `updated_at` gate. See item 15 for round 5's residual, which
    replaces it.
14. **Account dedupe moves history** (round 4, NIT). `dedupePlaidAccounts` (~:240)
    repoints a losing debt's `debt_balance_history` rows onto the surviving debt, so
    the merged history can show an apparent balance change on a day nothing was
    typed, which dates the survivor at that day.
11. A caller that sends `lastBalanceUpdate` with a PATCH/POST balance keeps that date.
    The web never sends one.
15. **A never-edited legacy debt is dated by its first page view, not its creation**
    (round 5, KNOWN, ACCEPTED). Round 3's rule, restored in round 5: a debt's first
    `debt_balance_history` row always counts as a change. GET /debts writes a row
    for every active debt on every view, so a never-edited legacy debt's first row
    is usually just the day someone first looked, not a real balance change.
    Counting it drops the charges between the debt's creation and that first view
    (a Jun 1 debt first viewed Jun 15 with $200 of Jun 10 charges is dated Jun 15,
    dropping that $200; see the Figures table and
    `amexAnchorDebtAsOf.integration.test.ts` "(known residual)"). Bounded: at most
    creation → first history row, and in practice usually the same day since a
    debt is typically viewed right after it's created. Round 4's attempt to close
    this (gate the first row on `updated_at`) was rejected instead of kept, because
    its own error was unbounded (item 13, now closed) — `updated_at` is bumped by
    a PATCH /debts/:id name/APR/min/status edit and by every Plaid refresh via
    `applyLiabilityToDebt`, neither of which has anything to do with the balance.
    **The durable fix is a one-time, owner-approved production backfill of
    `last_balance_update` for legacy debts** (a production write, out of scope
    here — needs the owner's explicit sign-off before it runs).

## Owner decisions still open

- Explicit clicks still adopt the bank's balance, APR and minimum (Link on a debt,
  create-debt-from-Plaid onto a same-name manual debt). Confirm.
- A refresh-written `prefs.amexAnchor.balance` resumes advancing after merge; a typed-in
  one is kept until DELETE /amex/anchor. Confirm after reading query 2 on production.
