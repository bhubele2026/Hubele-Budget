# PR4b — Cash today: a row counts unless the bank snapshot already holds it

Codex work-order point **1** (cash today, one rule). This is the second part of plan PR4, on top of PR4a (live,
`4e6e999`). Plan: `~/.claude/plans/h2-budget-work-serene-pebble.md`.

The branch is meant to be reviewed commit by commit:

| Commit | What it does |
|---|---|
| `999b90f` | Golden cases for the ledger paths PR4b–d touch (from PR4a's review). Recorded on PR4a's code; the original entries are byte-identical. |
| `25e86a9` | PR4a review NITs: the pre-window `assumption`, the ledger contract docs, one comment. No number change. |
| `52d27ef` | Pins `created_at` in every ledger test fixture. No behaviour change; the full API suite is unchanged. |
| `c7da213` | The rule as the plan specified it (`created_at` against the read), the Plaid sync re-stamp, and new golden, spec and sync tests. |
| refinement commit | The institution's own transaction time also counts as evidence (feed latency), plus this note. |

## The problem

**The ledger decided "already in the bank balance" by calendar day alone.**
- Every row dated on the snapshot day counted as already held.
- Every row dated after the snapshot day was added on top.

**A bank balance is read at an instant, not a day, so both halves went wrong.**
- **Cash overstated.** A purchase on the snapshot day that happened after the balance was read was ignored until the
  next snapshot. Sync in the morning and buy groceries at noon: Banking, Forecast and the spine kept the morning's
  figure all day.
- **Cash understated.** A Plaid row that already existed when the balance was read, but carries a later date, was
  added on top of a balance that held it. Examples are a pending authorisation dated by its expected posting day,
  or weekend activity dated Monday.

## What changed

- **One rule: `isInSnapshot(row, snapAt, snapDay)`**, in `lib/avalanche-core/src/snapshotInclusion.ts` and pure.
  - **Dated before the snapshot day:** held, as before.
  - **Dated on the snapshot day:** held when it is known to have existed by the read. That means it **happened**
    (`occurred_at`, the institution's time) **or reached the ledger** (`created_at`) at or before `snapAt`.
  - **A Plaid row dated 1–5 household days after the snapshot day:** held on the same evidence.
  - **Anything later, and manual rows dated after the snapshot day:** they count, as before.
- **Applied once, in the ledger** (`lib/forecastLedger.ts`).
  - With a snapshot, the actual-rows query now reads the snapshot day too, and each row passes `isInSnapshot`
    once.
  - `bankToday` and the curve take their rows from that one loop, so they cannot disagree about it.
- **The Plaid sync re-stamps the snapshot after its own backfill** (`lib/plaidSync.ts`).
  - A manual Sync reads the balance first, then can backfill rows the cursor missed: heal, stale cursor, or
    reconciliation. Those rows reach the ledger after the read, although the bank had them when it answered seconds
    earlier.
  - When the Sync read the balance and a backfill imported rows, `bankSnapshotAt` moves to that moment. Otherwise a
    backfilled row dated today would be counted twice.
  - A WHERE on the exact instant this Sync wrote means a newer snapshot is never overwritten. There is no extra
    Plaid call.
  - What it can wrongly hold is only a row that posts at the bank in the seconds between the read and the end of
    the backfill.
- **Test fixtures pin `created_at`** (`52d27ef`).
  - Postgres fills it with the real clock, not a test's pinned "now", so without it fixtures would change meaning
    with the date the suite runs. The household scenario's snapshot is dated October 2026.
  - `createdAtStartOfHouseholdDay` (00:00 Chicago on the row's own date) keeps every existing fixture's meaning
    under the rule.

## ⚠️ Feed latency — a deviation from the plan, and what remains

**The plan's rule** (built as specified in `c7da213`) decides by `created_at` alone: "a row dated on the snapshot
day is counted only if created after the snapshot".

**What that misses is feed latency.**
- Chase rows can reach Plaid, and so our ledger, hours or days after they happen. The sync code's own comments cite
  a 24–72 hour background poll.
- So a charge made at 08:00 and delivered after a 21:00 read was already inside that balance. By `created_at` alone
  it would look new and be counted twice.
- This is the same double count as a backfilled row, just delivered by the next webhook instead of the same Sync.

**The refinement.**
- When the institution supplied a real transaction time, the Plaid sync already stores it in `transactions.occurred_at`:
  Plaid `datetime`, else `authorized_datetime`, with midnight placeholders stored as null.
- A time at or before the read proves the bank had the row, whenever it arrived.
- A time after the read proves nothing on its own, because a charge authorised before the read can carry a later
  posting time. In that case the rule falls back to `created_at`.
- The refinement can only turn "counts" into "held" for rows with evidence they existed at the read. The plan's
  spec cases have no `occurred_at`, so their outcomes are unchanged.

**What remains, for the reviewer and for Codex.**
- **Rows with no real transaction time still decide by `created_at`.** A late-delivered charge with no time
  (common for Chase) can still be counted twice until the next snapshot.
- **The old rule's error was the opposite:** it missed every snapshot-day purchase after the read.
- **Which error is more frequent depends on the feed's latency and on how often a real time is supplied.** It cannot
  be measured without the production database, which is locked.
- **The sync's bank reconciliation still reports any difference** it cannot explain.
- **The mitigation is a Sync:** a new snapshot moves the read instant forward and settles both kinds of row.

## Decisions

- **Manual rows get the same-day case only.** There is no feed proving a typed balance included a row typed earlier
  with a later date.
- **Five household days** (`PLAID_HELD_AHEAD_DAYS`). Instants are compared as instants. Day bounds are household
  (America/Chicago) days.
- **Two other roll-forwards keep their day-based rules in this PR:**
  - the "Why this number?" breakdown (`routes/bankBalanceExplain.ts` `sinceAnchor`);
  - the sync's bank reconciliation (`plaidSync.ts` `ledgerSince`).

  The popover already says when its lines and the balance are counted by different rules. Aligning them is later
  work.
- **No snapshot:** unchanged.

## Figures that should move

**Live**, wherever the bank balance is shown or used: `bankToday`, the forecast curve and low point, and the
spine's bank balance on Banking, Forecast, Reports and "Why this number?".
- **Down** by the net of snapshot-day rows that happened after the balance was read and reached the ledger after it.
  They are now counted on the day they happen, not at the next snapshot.
- **Up** by Plaid rows that existed at the read and are dated 1–5 days after the snapshot day. They are no longer
  counted twice.
- **Unchanged:** any other row, and every household with no snapshot.

**Worked example** (golden case "PR4b golden — the snapshot rule"). The full household's balance was read at
10:00 CT on 05-08, plus five rows with no transaction time:

| Row | Before | After |
|---|---|---|
| −35 dated 05-08, reached the ledger after the read | not counted | counted |
| −22 Plaid, dated 05-10, existed at the read | counted | held |
| −18 Plaid, dated 05-10, arrived after | counted | counted |
| −90 Plaid, dated 05-14 (+6) | counted | counted |
| −12 manual, dated 05-09 | counted | counted |
| **`bankToday`** | **2643.00** | **2630.00** |

2785 − 22 − 18 − 90 − 12 = 2643.00 before. 2785 − 35 − 18 − 90 − 12 = 2630.00 after.

**Not measured:** live before/after figures for the household. The production database is locked and no signed-in
browser was used.

## Must not change

- **Every existing expectation.**
  - The 10 golden entries recorded before the rule are byte-identical with it.
  - The cash signal, household clock, forecast past rows, bank-balance explain, household scenario and spine parity
    suites pass unchanged, because their fixtures carry `created_at` from `52d27ef` and no `occurred_at`.
- **No-snapshot behaviour, the web app, the explain route and the reconciliation.**
- **The landing bundle:** 572.5 KB.

## Tests

- **New `lib/snapshotInclusion.test.ts`** (13)
  - **Arrival time:**
    - dated before the snapshot day;
    - same day, created before, at or after the read;
    - Plaid +2/+5 created before, and +2 created after;
    - Plaid +6;
    - manual +1;
    - a 21:30 Chicago read;
    - the +5 window across a month end.
  - **Transaction time:**
    - happened before the read and arrived after → held;
    - happened and arrived after → counts;
    - a later time does not override an earlier arrival;
    - Plaid +2 with an earlier time → held;
    - the +6 and manual windows unchanged;
    - a missing or unparsable time is no evidence.
- **New `__tests__/ledgerCreatedAt.test.ts`** (5): the fixture helper in both offsets, and on both clock-change days.
- **`cashSignal.integration.test.ts`** (+4) on a $1,000 balance read at 10:00 CT:
  - the plan's spec:
    - −$40 dated that day, created 09:00 → `bankToday` and `daily[0]` 1000.00;
    - created 14:00 → 960.00;
    - a pending Plaid −$25 dated two days ahead, existing at the read → 1000.00;
  - feed latency: −$40 that happened at 08:00 but reached the ledger at 14:00 → 1000.00.
- **`forecastLedger.golden.integration.test.ts`** (+1): the worked example. It asserts 2630.00, plus the full output.
- **`plaidSyncStaleCursorBackfill.integration.test.ts`** (+1): a manual Sync reads 2,500.00, then its stale-cursor
  backfill imports a −$40 row dated today.
  - The row's `created_at` is not after `bankSnapshotAt`, and `bankToday` stays 2500.00.
  - Without the re-stamp this test failed: the row reached the ledger 5 ms after the stamp.
- **Tests that fail on the code before them:**
  - the three cash-signal spec tests would fail on `4e6e999`, which excludes every snapshot-day row and adds every
    later one;
  - the latency test fails on `c7da213`, which counts the row;
  - the backfill test failed before the re-stamp.

## Verification

- **Full API suite (local Postgres test database):** **118 files, 864 pass, 8 todo**, on the final code. The count by
  commit:

  | Code | Files | Pass |
  |---|---|---|
  | PR4a | 116 | 835 |
  | `999b90f` | 116 | 840 |
  | `52d27ef` | 116 | 840 |
  | `c7da213` | 118 | 857 |
  | refinement | 118 | 864 |

  - `999b90f` added the 5 golden edge cases.
  - `52d27ef` pins `created_at` and changes nothing. The helper's own unit file was written after that run and is
    counted from the next row.
  - `c7da213` added 17: rule unit 7, helper unit 5, cash signal 3, golden 1, backfill re-stamp 1.
  - The refinement adds 7: 6 unit tests and the latency test.
- **Golden:** 11 of 11 pass under `CI=true`. The 10 entries recorded before the rule are byte-identical; only the
  worked-example entry is new.
- **Workspace typecheck and build:** pass.
- **Landing bundle guard:** **572.5 KB of 580**, unchanged.
- **Web suite:** **118 files, 917 pass**, run after the avalanche-core export was added. The later commits change
  only server code.
- **Failing-before checks:**
  - The re-stamp test was run on the code without the re-stamp and failed (`created_at` 5 ms after
    `bankSnapshotAt`).
  - The latency and rule tests fail by construction on the commits before them. Their expected values contradict
    the earlier rules.

## Carried from PR4a's review

- **The unique index.** `transactions_plaid_txn_uq` (global, on `plaid_transaction_id`) is created by
  `drizzle-kit push`; no SQL migration creates it. It was confirmed in the schema and the test database, **not in
  production**. If it were ever missing, one input changes: a duplicate id with one copy dated after today and read
  first would drop the other copy from `bankToday`.
- **Item kinds.** PR4a shipped ledger items as `actual | plan` with `eventKind: income | expense`, not the plan's
  `actual | income | bill | debt | avalanche | payoff | reserve`. Payoff and reserve items arrive with PR8.
- **Corrections to the PR4a note.**
  - `computeCashSignal` was about 560 lines; the file was 849.
  - "No server behaviour change" should read: one fewer query, and for a window ending before today the single read
    reaches today. No figure moved.
- **Still open from the PR3 close-out review:** a one-line comment on why the new Sync test in
  `use-plaid-sync.test.tsx` builds its own QueryClient. It will go with the next web change.

## Left for later PRs

- **PR4c** — a pending row superseded by its posted row leaves cash.
- **PR4d** — Plaid sync:
  - re-mint (two real same-amount charges both survive);
  - `occurredOnUserOverridden` honoured on re-mint;
  - backfill order around the balance read (the re-stamp here is the minimal fix PR4b needed).
- **Aligning the other roll-forwards** — the explain route's `sinceAnchor`, the sync reconciliation and the web
  `accountBalance.ts` (which needs `createdAt` and `occurredAt` in the API) — onto `isInSnapshot`.
- **Measuring latency** — how often `occurred_at` is null for the household's Chase rows, and how late they arrive.
  This needs a read-only production query Brad approves, and would show whether the remaining double-count risk is
  material.
- **PR9** — `lowestProjected` starts from a balance that leaves out day 0's own rows.
