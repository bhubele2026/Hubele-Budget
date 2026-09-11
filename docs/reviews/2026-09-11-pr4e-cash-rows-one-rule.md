# PR4e — One cash-row rule for the ledger, "Why this number?" and the Sync reconciliation

Codex work-order point **1** (cash today, one rule), plan PR4e. Server only. Base: PR4c with its review fixes,
`62c7db0` (under review, not merged). Plan: `~/.claude/plans/h2-budget-work-serene-pebble.md`.

| Commit | What it does |
|---|---|
| `3176d71` | The helper, the three callers, spec description and codegen, the popover note, tests. |
| `24a8ce1` | This note, first version. |
| `dcc7202` | Review fixes (table below): the reconciliation sums Plaid rows only; window and spec wording; two stale comments; five tests. |
| review-note commit | This note, updated. |

**Update (follow-up to the approval, `fix/pr4e-review-nits`).** Non-blocking review notes; tests and this note only,
no source change.
- **Wording:** a logged payment beside its bank debit does not keep cash today low "until the row is removed". It does
  until a manual Sync or a typed balance taken after both rows are stored, and the feed can bring it back (see
  residuals). The case B test now shows the first part: cash today reads 0.00 before its Sync and 500.00 after.
- **Edge test:** the explain today + 7 case put its posted row at today + 6, so a window ending at today + 6 also
  passed. It now sits at exactly today + 7 and fails with that bound. The row at today + 8 is a decoy.
- **C1 test:** a hand-typed check the bank cleared before the feed delivered it is now pinned through `syncPlaidItem`.
  The first manual Sync reports drift −60.00 and re-anchors at 940.00 (read back from the settings row). A second
  Sync, and a third after the feed delivers the check, report none. Cash today reads 940.00 throughout. A disclosed
  residual rather than a goal.
- **Second review round** (approved at `bc574f0`): the re-anchor is asserted, because the old anchor less the check
  also reads 940.00. "Until the next manual Sync" was too strong. The reason given, that both rows are dated before
  the Sync's day, was wrong for rows dated on that day.

## Review findings and what was done

The independent review of `24a8ce1` returned REQUEST CHANGES. It confirmed that `bankToday` does not move, that explain
ties to the cent, and that the move is verbatim (checked over 20,000 random ledgers).

| Finding | Done |
|---|---|
| **MEDIUM:** the Sync reconciliation counted manual rows, so every payment logged on the Avalanche page raised a false drift toast (reproduced: A {1000, 500, 500}; B {500, 0, 500} plus a backfill) | The reconciliation now sums only the counted outcomes of rows with a Plaid account (`plaidRowsThroughToday` in `lib/ledgerCashRows.ts`). Explain and the ledger are unchanged. Cases A and B are integration tests: no drift in either, and no `/transactions/get` call in either. Both fail on `24a8ce1`. |
| **LOW:** "complete" is wrong at the anchor − 7 end | Reworded in `cashRows.ts` and `ledgerCashRows.ts`: the lower edge is the ledger's bound, not a complete one. A unit test pins the reviewer's example (all rows −5.00; from anchor − 7, −55.00). Listed under residuals. |
| **LOW:** the spec promised the tie unconditionally | The `sinceAnchor` description is qualified: the snapshot has a balance and both are read at the same moment. It names the read race and household midnight. Codegen re-run. |
| **NIT:** stale comment in `bank-balance-why.tsx` | "the snapshot has no read time". |
| **NIT:** stale doc in `reconcileBankBalance.ts` | Describes the helper-based, Plaid-rows-only net. |
| **Missing tests** | (E) a typed snapshot through explain; a pair split across the today + 7 edge through explain; cases A and B through `syncPlaidItem`. |

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
  classifies the rows. Besides the helper's result it returns `plaidRowsThroughToday`: the same total over rows with a
  Plaid account only.

**Three callers.**
- **The ledger** calls the helper and walks the outcomes in query order. It adds `contribution` to `bankToday` and pushes
  actuals exactly as the loop did: same order, same float operations.
- **Explain:** `sinceAnchor` is the helper's `throughToday` over the ledger's rows, rounded to cents. Manual rows count,
  as they do in the balance.
- **Sync:** `ledgerSince` is `plaidRowsThroughToday.net` for the **pre-sync** `bankSnapshotAt` and its household day, on
  `checkingPlaidAccountId`. It is re-read after the backfill, as before.
  - `reconcileBankBalance`, the drift threshold and the toast are unchanged.
  - The new snapshot is still written before the reconciliation. The helper reads the stored rows, not the settings,
    so it is unaffected.
  - A manual row never pairs and never carries a Plaid id, so leaving manual rows out moves no Plaid row's outcome.

**The window, stated precisely.**
- **Upper edge, today + 7:** exactly enough. A posted row replaces a pending row dated at most 7 days before it, and
  posted rows pair in date order, so rows after today + 7 cannot change an outcome dated on or before today. The spine
  and explain ledgers use a 90-day window, which reads past that bound, so `throughToday.net` is exactly what their
  `bankToday` adds. Tests pin this at the unit level (a posted row after today supersedes today's pending row) and
  through explain (a posted row at exactly today + 7 replaces today's pending row, beside a decoy posted row at
  today + 8 that can never take it).
- **Lower edge, anchor − 7:** the ledger's bound, not a complete one. A pending row dated before it can change a pair
  after the anchor through pairing order. Every caller reads the same bound, so all agree with the ledger (see
  residuals).

**Spec:** a description on `BankBalanceExplain.ledger.sinceAnchor`. The generated diff is a JSDoc comment and a zod
`.describe()`; no validation change. The description qualifies the tie: the snapshot has a balance and both are read at
the same moment.

**Popover** (`bank-balance-why.tsx`):
- the doc comments are updated;
- the mismatch note now reads "The balance above and these lines do not add up to the cent."

## Decisions and deviations

- **`rowCount` counts rows that count** (`counted` and `adjusted`) dated through today. That is one per ledger actual,
  including a posted row that adds 0.00 because its pending half was in the balance. Held, off-account, superseded and
  duplicate rows are not counted.
- **`sinceAnchor` is present whenever the snapshot has a read time**, which is the ledger's own condition for rolling
  forward. It used to be null when the account did not resolve. The ledger still rolls manual rows then, so the line is
  now shown and ties.
- **⚠️ The reconciliation leaves manual rows out, although cash today counts them.** This is a review fix; `24a8ce1`
  counted them.
  - **Why:** "Log payment" on the Avalanche page (`routes/debts.ts:860-873`) writes a `source: "manual"` checking row
    with no Plaid account for every debt payment. The sync merges manual rows only on an account's first sync (#361),
    and dedupe is per Plaid account, so that row stays for good.
  - **What counting it did:** before the bank debits the payment, the prediction is low by the payment. After the
    debit arrives, the payment counts twice. Either way, one false toast per logged payment, and a backfill Plaid cannot
    use.
  - **The prediction is therefore** "what the bank feed's own rows add to the pre-sync anchor, by the ledger's rule".
- **The popover note's wording changed.** The task said to keep the note, and it is kept. Its old cause, "counted by
  different rules", is no longer true, so it names none. The web test asserts the new text and the absence of the old.
- **The helper has a sixth reason, `duplicate`,** for the ledger's defensive Plaid-id skip.
- **The query stays in the API server.** It needs the database. Only the per-row rule is in `avalanche-core`, where
  PR14's web ledger can reuse it.
- **Rebased mid-task** from `4f2969c` to `62c7db0`. The helper carries that commit's held-pair and
  `pendingChargeWasInBalance` rules, and the base's new cash-signal regressions pass unchanged. Those are R1/R1b
  (3000.00), R2 (945.00), R3 (945.00), both held (1000.00) and two pendings (930.00).
- **Clocks in the new integration tests follow the files they sit in.**
  - Explain fixtures use fixed August dates, except the today + 7 case, which uses the household's today.
  - Sync fixtures are relative to one read instant four days ago, with every day computed from its household day.
  - None depends on the time of day the suite runs.

## Figures that should move

- **"Why this number?", the rows-since line.** It now shows what the balance adds.
  - Rows the snapshot held and replaced pending rows leave the count.
  - Manual rows, and snapshot-day rows that count, join it.
  - With a snapshot balance and both read together, snapshot + net equals the balance to the cent, so the mismatch note
    shows only for a true mismatch.
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
  - unlinked pending/posted pairs, with or without the pending half held;
  - Plaid snapshot-day rows the ledger counts.
- **Sync, manual rows (payments logged on the Avalanche page):** stay out, as on the base. No new toast.
- **Sync, `balanceDrift.ledger` and `unexplained`** are now figured by the ledger's rule over Plaid rows. A really
  missing row reports exactly its own amount.
- **New, true toasts are possible** where a PR4b/PR4c residual (a false pair, a re-mint hold) makes the ledger's
  Plaid-row figure wrong.
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
- **The lower edge of the row window (anchor − 7) is the ledger's, not a complete one.**
  - A pending row dated before it can change a pair after the anchor through pairing order.
  - Example (unit test): pending −54 at anchor − 9, posted −55 at anchor − 3, pending −50 at anchor − 5, posted −55 at
    anchor + 2. Over all rows the last posted row adds −5.00; from anchor − 7 it adds −55.00.
  - The ledger, explain and the reconciliation all read the same bound, so they agree. The ledger can be off against
    the bank in such a case. This is a PR4c limit; widening the bound moves the ledger's output.
- **A ledger whose window ends before today + 7.** `computeCashSignal` with a short horizon or an early `fromDate` (the
  forecast route accepts both) reads no posted row after its window. Its `bankToday` can therefore count a pending row
  that the 90-day ledger, explain and the reconciliation treat as superseded. This is PR4c behaviour, not changed here:
  the ledger's output must not move.
- **When the explain tie can break**, and the note then shows, correctly:
  - a row lands between the two reads;
  - a household midnight falls between them;
  - the snapshot has a read time but no balance, so the ledger rolls from the starting balance and the popover shows
    its no-snapshot line.
- **The reconciliation and manual rows.**
  - A checking transaction recorded only by hand (a typed check the feed has not delivered) is left out of the
    prediction. It shows as one drift report, on the first manual Sync after the check clears, whether or not the feed
    ever delivers it: that Sync re-anchors. That is the base's behaviour.
  - The balance on screen still counts a logged payment's manual row beside the bank's own debit. Cash today is low by
    that payment until a manual Sync (or a balance typed on the forecast page, `routes/forecast.ts:792`) taken after
    both rows are stored.
    - **Why that snapshot holds both:** a row dated before its day is always held. A row dated on its day is held
      unless both its transaction time and its stored time fall after the read, so a row with no transaction time is
      held.
    - **It can come back.** Suppose the Sync reads 500.00 after the bank took the debit but before the feed delivered
      it. The manual row is held. The feed then delivers the −500.00 debit dated the day after the read, with no
      transaction time. That row counts, so cash today reads 0.00 against a bank of 500.00 until another manual Sync.
      Dated on the read day instead, it is held and cash today reads 500.00.
    - This was true before PR4e and is not changed here. The reconciliation does not report it, because it compares
      the bank with the feed's rows.
- **The reconciliation inherits the ledger's other residuals** (PR4b and PR4c notes). When the Plaid-row figure is wrong
  because of one, the drift toast says so.
- **Row volume.** Explain now reads the household's forecast rows from anchor − 7 through today + 7, not one account's
  amounts. That is the same set the ledger already reads on every spine call. Explain has no 45-day anchor cap; the
  reconciliation does.

## Tests

- **New `lib/cashRows.test.ts`** (16):
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
  - The lower-edge limit (−5.00 over all rows, −55.00 from anchor − 7).
- **`__tests__/bankBalanceExplain.integration.test.ts`** (+4):
  - the worked example above: `{3, "-297.91"}`, balance 4429.06, and snapshot + net = balance in cents;
  - an unresolved account with a manual −84.06 and a Plaid −10.00: `{1, "-84.06"}`, balance 4200.00;
  - **(review E)** a typed snapshot of 2,500.00 with a held −40.00, a Plaid −60.00 and a manual −25.00: `{2, "-85.00"}`,
    balance 2415.00, tie in cents;
  - **(review)** a pending −30.00 today replaced by a posted −32.00 at exactly today + 7, beside a posted −31.00 at
    today + 8: `{1, "-442.91"}`, balance 4284.06.
- **`__tests__/plaidBankSnapshotAutoRefresh.integration.test.ts`** (+6). A `transactionsGet` call counter was added to
  the existing mock. No test passes `forceRefresh`, so a call can only be the reconciliation's backfill. The cases:
  - **D1:** a held-ahead −25.00, bank 1000.00. No drift, no drift log, no backfill.
  - **D3:** an unlinked pair, neither half held, bank 945.00. No drift, no backfill.
  - The tip pair, pending half held, bank 993.20. No drift.
  - **(review A)** a logged −500.00 payment, bank 1000.00. No drift, no backfill.
  - **(review B)** the same payment plus the Plaid −500.00 debit, bank 500.00. No drift, no backfill.
  - ⭐ A really missing +169.90 beside a held −25.00: drift `{1069.90, 900.00, 169.90}`, the drift log, and a backfill.
- **Failing before.** Each older version's code was swapped in with the new tests, run, and restored.

  **On `24a8ce1`** (its `cashRows.ts`, `ledgerCashRows.ts` and `plaidSync.ts`), **2 fail, 41 pass** across the unit, explain and
  sync files.
  - The failures are review A (drift, bank 1000.00) and review B (drift).
  - E, the today + 7 edge case and the lower-edge unit test pass there, as they should. They pin behaviour `24a8ce1`
    already had, and the reviewer asked for them as coverage.

  **On `62c7db0`** (its `bankBalanceExplain.ts` and `plaidSync.ts`), **8 fail, 19 pass** across the explain and sync
  files:

  | Test | Base returns |
  |---|---|
  | Explain, worked example | `{4, "-561.60"}` |
  | Explain, E | `{2, "-100.00"}` |
  | Explain, today + 7 edge | `{2, "-472.91"}` |
  | Explain, unresolved account | `null` |
  | D1 | drift, bank 1000.00 |
  | D3 | drift, bank 945.00 |
  | Tip pair | drift, bank 993.20 |
  | Missing row | ledger **875.00**, unexplained **194.90** |

  Review A and B pass on `62c7db0`, whose day sum also left manual rows out. The 16 unit tests cannot run there: the
  module is new.

## Verification

All from the worktree root, on `dcc7202`.

- **Full API suite** (local Postgres test database): **122 files, 955 pass, 8 todo.** `24a8ce1` had 951; the review
  adds 5 tests and replaces 1. The branch adds 26 tests and 1 file, so the base comes to 121 files and 929; that figure
  is derived, not run separately.
- **Ledger-dependent files** (unit ×4 including `reconcileBankBalance`, golden, cash signal, explain, sync
  auto-refresh, spine parity): **9 files, 163 pass.** Golden 11 of 11 under `CI=true`.
- **Web suite:** **118 files, 917 pass.**
- **Workspace typecheck:** exit 0. **Build:** exit 0.
- **Landing bundle guard:** **572.5 KB of 580** (172.6 KB gz), unchanged.
- **Codegen:** re-run after the review commit leaves no diff.

## Left for later

- **PR14:** the web Chase page's balances move to server balances. `classifyCashRows` is already shared for the web
  ledger.
- **A logged payment beside its bank debit:** both count in cash today until a manual Sync or a typed balance taken
  after both rows are stored, and the feed can bring the double count back after one (see residuals). It predates
  PR4e. Closing it needs a merge or match between "Log payment" rows and the feed's debits, which is sync write-path
  work.
- **Window edges:** reading from before anchor − 7, or posted rows through today + 7 regardless of the window, would
  close the two window residuals above, but it moves the ledger's output. It needs its own PR and golden entries.
- **Measuring** how often held-ahead charges and unlinked pairs raised false drift in production. This needs an
  approved read-only query.
