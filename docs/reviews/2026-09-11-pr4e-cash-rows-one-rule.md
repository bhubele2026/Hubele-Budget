# PR4e — One cash-row rule for the ledger, "Why this number?" and the Sync reconciliation

Codex work-order point **1** (cash today, one rule), plan PR4e. Server only. Base: PR4c with its review fixes,
`62c7db0` (under review, not merged). Plan: `~/.claude/plans/h2-budget-work-serene-pebble.md`.

## The problem

**Two diagnostics of cash today counted rows by a different rule from cash today itself.**
- **Cash today** (`bankToday`, the curve, `spine.bank.balance`) comes from `buildForecastLedger`. Each row adds 0 when:
  - the snapshot already holds it (PR4b);
  - it is not on the snapshot's account;
  - it is the pending half of a pair (PR4c).

  Manual rows on the account count.
- **"Why this number?"** (`routes/bankBalanceExplain.ts` `sinceAnchor`) summed the Plaid account's rows dated after the
  snapshot day through today.
  - That included held rows and both halves of a pair.
  - It left out manual rows, and snapshot-day rows the ledger counts.
  - It was null whenever the account did not resolve.
  - The popover compares snapshot + net with the balance to the cent, so its "counted differently" note was routine.
- **The Sync's bank reconciliation** (`lib/plaidSync.ts` `ledgerSince`) used the same day sum to predict the bank's
  `available` from the pre-sync anchor. When a charge the anchor held, or an unlinked pair, made that prediction wrong,
  a manual Sync on an honest ledger:
  - logged drift;
  - ran a `/transactions/get` gap backfill;
  - returned `balanceDrift`, which shows the "doesn't match our records" toast.

## What changed

**One pure helper, `classifyCashRows`** (`lib/avalanche-core/src/cashRows.ts`, with `isBankRow`). This is the ledger's
per-row loop moved verbatim, carrying PR4c's review semantics from `62c7db0`.
- **Input:** rows, the anchor `{at, day}` or null, the snapshot account's external id, and today.
- **Output:**
  - per row, `reason` (`held | not_bank | superseded | duplicate | adjusted | counted`), `counts`, `contribution` and
    `replacedId`;
  - `throughToday {rowCount, net}`.
- **The rule, in order:**
  1. **Held:** held by the snapshot. A posted row is held only when its pending half is held too.
  2. **Not bank:** not on the account.
  3. **Superseded:** the pending half of a pair.
  4. **Duplicate:** a repeated Plaid transaction id (defensive; the id is unique).
  5. **Counted or adjusted:** the row adds its amount. It adds posted − pending instead when the pending half was a
     charge with evidence it was in the balance (`pendingChargeWasInBalance`).

**One row query, `lib/ledgerCashRows.ts`.**
- `ledgerActualRowsWhere` is the ledger's WHERE, moved verbatim.
- `toCashRow` is its row mapping.
- `classifyLedgerRowsThroughToday(anchor, account, today)` runs that query from anchor − 7 through **today + 7** and
  classifies the rows.

**Three callers.**
- **The ledger** calls the helper and walks the outcomes in query order. It adds `contribution` to `bankToday` and pushes
  actuals exactly as the loop did: same order, same float operations.
- **Explain:** `sinceAnchor` is the helper's `throughToday` over the ledger's rows, rounded to cents.
- **Sync:** `ledgerSince` is the helper's `throughToday.net` for the **pre-sync** `bankSnapshotAt` and its household day,
  on `checkingPlaidAccountId`. It is re-read after the backfill, as before.
  - `reconcileBankBalance`, the drift threshold and the toast are unchanged.
  - The new snapshot is still written before the reconciliation. The helper reads the stored rows, not the settings,
    so it is unaffected.

**Why today + 7 is exactly enough.** A posted row replaces a pending row dated at most 7 days before it, and posted
rows pair in date order. Rows after today + 7 can therefore neither supersede a row dated on or before today nor change
an earlier pair. The spine and explain ledgers use a 90-day window, which reads past that bound, so `throughToday.net`
is exactly what their `bankToday` adds. A unit test pins the case: a posted row dated after today supersedes today's
pending row.

**Spec:** a description on `BankBalanceExplain.ledger.sinceAnchor`. The generated diff is a JSDoc comment and a zod
`.describe()`; no validation change.

**Popover** (`bank-balance-why.tsx`):
- the doc comment is updated;
- the mismatch note now reads "The balance above and these lines do not add up to the cent."

## Decisions and deviations

- **`rowCount` counts rows that count** (`counted` and `adjusted`) dated through today. That is one per ledger actual,
  including a posted row that adds 0.00 because its pending half was in the balance. Held, off-account, superseded and
  duplicate rows are not counted.
- **`sinceAnchor` is present whenever the snapshot has a read time**, which is the ledger's own condition for rolling
  forward. It used to be null when the account did not resolve. The ledger still rolls manual rows then, so the line is
  now shown and ties.
- **The reconciliation counts manual rows on the account**, as the balance on screen does.
  - The prediction is therefore "what cash today would read on the pre-sync anchor".
  - A manual row that duplicates a Plaid row now raises drift. That drift is true: the displayed balance is off by that
    row.
- **The popover note's wording changed.** The task said to keep the note, and it is kept. Its old cause, "counted by
  different rules", is no longer true, so it names none. The web test asserts the new text and the absence of the old.
- **The helper has a sixth reason, `duplicate`,** for the ledger's defensive Plaid-id skip.
- **The query stays in the API server.** It needs the database. Only the per-row rule is in `avalanche-core`, where
  PR14's web ledger can reuse it.
- **Rebased mid-task** from `4f2969c` to `62c7db0`. The helper carries that commit's held-pair and
  `pendingChargeWasInBalance` rules, and the base's new cash-signal regressions pass unchanged. Those are R1/R1b
  (3000.00), R2 (945.00), R3 (945.00), both held (1000.00) and two pendings (930.00).
- **Clocks in the new integration tests follow the files they sit in.**
  - Explain fixtures use fixed August dates, all in the past.
  - Sync fixtures are relative to one read instant four days ago, with every day computed from its household day.
  - Neither depends on the time of day the suite runs.

## Figures that should move

- **"Why this number?", the rows-since line.** It now shows what the balance adds.
  - Rows the snapshot held and replaced pending rows leave the count.
  - Manual rows, and snapshot-day rows that count, join it.
  - Snapshot + net equals the balance to the cent, so the mismatch note shows only for a true mismatch.
  - **Worked example** (explain test, snapshot 4,726.97 read 07:00 CT on 08-20): the old line read **4 rows, −561.60**
    beside a balance of 4,429.06. It now reads **3 rows, −297.91**, and 4,726.97 − 297.91 = 4,429.06.

  | Row | Old line | New line |
  |---|---|---|
  | HY-VEE −442.91, 08-21 | counted | counted |
  | CASEY'S −30.00, 08-20, in the ledger before the read | — | held |
  | NETFLIX −15.49, 08-22, in the ledger before the read | counted | held |
  | Pending −48.20 (08-23) + posted −55.00 (08-24), unlinked | both counted | −55.00 once |
  | Manual +200.00, 08-25 | — | counted |
- **Sync, fewer false "doesn't match our records" toasts, and fewer extra `/transactions/get` backfills** for:
  - charges the pre-sync anchor held;
  - unlinked pending/posted pairs;
  - manual rows on the account;
  - snapshot-day rows the ledger counts.
- **Sync, `balanceDrift.ledger` and `unexplained`** are now figured against the ledger's rule. A really missing row
  reports exactly its own amount.
- **New, true toasts are possible** where the displayed balance itself is wrong: a manual row duplicating a Plaid row,
  or a PR4b/PR4c residual (a false pair, a re-mint hold).
- **Unchanged:** `bankToday`, the curve, the spine, and every figure on the Chase page.

**Not measured:** how often each case occurs for the household. That needs a read-only production query Brad approves.
The production database stays locked.

## Must not change

- **The ledger's output.** The golden file passes (11 of 11) under `CI=true`, and its snapshot file is not in the
  diff. Every existing cash-signal, spine-parity and household test passes unchanged, including the base's new PR4c
  regressions.
- **`bankToday` / spine parity:** `spineParity.integration.test.ts` passes.
- **Existing explain and sync expectations.** Explain's `sinceAnchor {rowCount: 1, net: "-442.91"}` is unchanged, because
  its one row counts under both rules. The ⭐ "reports the amount the ledger cannot explain" test is unchanged
  (169.90).
- **No new dependencies and no DDL.** Landing bundle 572.5 KB of 580, unchanged.

## Residuals

- **⚠️ The web Chase page still uses the day rule.**
  - **Code:** `lib/accountBalance.ts` (`computeBalanceAtEndOf` :33, `computeBalanceAtEndOfDate` :104) and
    `lib/chaseEndingBalance.ts` (`scopeChaseTransactions` :59, `makeChaseBalanceAtEndOf(Date)` :95/:142).
  - **Where it shows:** in `pages/transactions.tsx`:
    - the chart's today seed (`balanceAtEndOfDate(todayISO)` :706, which falls back to `cashProjection.bankToday` only
      when that is empty);
    - the period start and end stats (:669-670);
    - the weekly points (:726);
    - the running balance (:803).
  - **How it differs:** those figures ignore `isInSnapshot` and pairing, and drop manual rows once a Plaid account is
    linked. They also anchor per account, and use the browser's day rather than the household's.
  - **When it closes:** they can differ from `bankToday` by any held row, pair or manual row until PR14 moves the page
    to server balances.
- **A ledger whose window ends before today + 7.** `computeCashSignal` with a short horizon or an early `fromDate` (the
  forecast route accepts both) reads no posted row after its window. Its `bankToday` can therefore count a pending row
  that the 90-day ledger, explain and the reconciliation treat as superseded. This is PR4c behaviour, not changed here:
  the ledger's output must not move.
- **Explain reads the rows and the balance a moment apart.** A row landing between the two reads, or a household
  midnight between them, can still show the mismatch note, correctly.
- **The reconciliation inherits the ledger's residuals** (PR4b and PR4c notes). When the displayed balance is wrong
  because of one, the drift toast now says so. A drift caused by a manual row triggers a backfill that cannot fix it.
- **Row volume.** Explain now reads the household's forecast rows from anchor − 7 through today + 7, not one account's
  amounts. That is the same set the ledger already reads on every spine call. Explain has no 45-day anchor cap; the
  reconciliation does.

## Tests

- **New `lib/cashRows.test.ts`** (15):
  - `isBankRow`: a Plaid row belongs only to the resolved account; a manual row counts unless its source names a card.
  - Counted and held rows, including a held-ahead charge.
  - Rows off the account, including with an unresolved account.
  - Pairs:
    - tip adjusted when the pending half was held (−6.80);
    - held posted row with an unheld pending half (−55.00 in full);
    - both held (0);
    - a pending deposit (full);
    - a snapshot-day pending charge with no evidence (full);
    - neither half held;
    - a posted row dated after today superseding today's pending row;
    - a posted row adding 0.00 still counted.
  - A duplicate Plaid id; no anchor.
- **`__tests__/bankBalanceExplain.integration.test.ts`** (+2):
  - the worked example above: `{3, "-297.91"}`, balance 4429.06, and snapshot + net = balance in cents;
  - an unresolved account with a manual −84.06 and a Plaid −10.00: `{1, "-84.06"}`, balance 4200.00.
- **`__tests__/plaidBankSnapshotAutoRefresh.integration.test.ts`** (+5). A `transactionsGet` call counter was added to
  the existing mock. No test passes `forceRefresh`, so a call can only be the reconciliation's backfill. The cases:
  - **D1:** a held-ahead −25.00, bank 1000.00. No drift, no drift log, no backfill.
  - **D3:** an unlinked pair, neither half held, bank 945.00. No drift, no backfill.
  - The tip pair, pending half held, bank 993.20. No drift.
  - A manual −60.00, bank 940.00. No drift.
  - ⭐ A really missing +169.90 beside a held −25.00: drift `{1069.90, 900.00, 169.90}`, the drift log, and a backfill.
- **Failing before.** The base's `bankBalanceExplain.ts` and `plaidSync.ts` (`62c7db0`) were run with the new tests,
  then restored. **All 7 new integration tests fail; the 17 existing tests in both files pass.**

  | Test | Base returns |
  |---|---|
  | Explain, worked example | `{4, "-561.60"}` |
  | Explain, unresolved account | `null` |
  | D1 | drift, bank 1000.00 |
  | D3 | drift, bank 945.00 |
  | Tip pair | drift, bank 993.20 |
  | Manual row | drift, bank 940.00 |
  | Missing row | ledger **875.00**, unexplained **194.90** |

  The 15 unit tests cannot run on the base: the module is new.

## Verification

- **Full API suite** (local Postgres test database): **122 files, 951 pass, 8 todo.** The branch adds 22 tests and 1
  file, so the base comes to 121 files and 929; that figure is derived, not run separately.
- **Ledger-dependent files** (unit ×3, golden, cash signal, explain, sync auto-refresh, spine parity): **8 files, 150
  pass.** Golden 11 of 11 under `CI=true`.
- **Web suite:** **118 files, 917 pass.** The popover test was changed, not added.
- **Workspace typecheck:** exit 0. **Build:** exit 0.
- **Landing bundle guard:** **572.5 KB of 580** (172.6 KB gz), unchanged.
- **Codegen:** re-run after the commit leaves no diff.

## Left for later

- **PR14:** the web Chase page's balances move to server balances. `classifyCashRows` is already shared for the web
  ledger.
- **A short-window ledger:** reading posted rows through today + 7 regardless of the window would close the residual
  above, but it moves the ledger's output. It needs its own PR and golden entry.
- **Measuring** how often held-ahead charges, unlinked pairs and manual rows raised false drift in production. This
  needs an approved read-only query.
