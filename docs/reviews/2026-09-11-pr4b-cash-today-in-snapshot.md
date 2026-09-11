# PR4b — Cash today: a row counts unless the bank snapshot already holds it

Codex work-order point **1** (cash today, one rule). This is the second part of plan PR4, on top of PR4a (live,
`4e6e999`). Plan: `~/.claude/plans/h2-budget-work-serene-pebble.md`.

The branch is meant to be reviewed commit by commit:

| Commit | What it does |
|---|---|
| `999b90f` | Golden cases for the ledger paths PR4b–d touch (from PR4a's review). Recorded on PR4a's code; the original entries are byte-identical. |
| `25e86a9` | PR4a review NITs: the pre-window `assumption`, the ledger contract docs, one comment. No number change. |
| `52d27ef` | Pins `created_at` in every ledger test fixture. No behaviour change; the full API suite is unchanged. |
| `c7da213` | The rule as the plan specified it (`created_at` against the read), a Plaid sync re-stamp, and golden, spec and sync tests. |
| `4cc83d1` | The institution's transaction time as extra evidence. |
| review-fix commit | **The rule as shipped** (below): evidence rule on the snapshot day, charges only ahead of it, placeholder times ignored. The sync re-stamp is removed. |

`c7da213` and `4cc83d1` are superseded by the review-fix commit. Read the last commit for the shipped code.

## The problem

**The ledger decided "already in the bank balance" by calendar day alone.**
- Every row dated on the snapshot day counted as already held.
- Every row dated after the snapshot day was added on top.

**A bank balance is read at an instant, not a day, so both halves can go wrong.**
- **Cash overstated.** A purchase on the snapshot day that happened after the balance was read is ignored until the
  next snapshot.
- **Cash understated.** A Plaid charge that already existed when the balance was read, but is dated a few days later,
  is added on top of a balance that held it. Pending charges are inside `available`; when a charge posts, the sync
  re-keys the pending row onto the posted one, and the posted row can carry a later date.

## The rule as shipped

**`isInSnapshot(row, snapAt, snapDay)`**, in `lib/avalanche-core/src/snapshotInclusion.ts` and pure:

1. **Dated before the snapshot day:** held, as before.
2. **Dated on the snapshot day:** held, unless **both** of these are true:
   - `occurred_at` (the institution's own time) is a real time after the read;
   - `created_at` (when the row reached the ledger) is after the read.
3. **A Plaid charge (`amount < 0`) dated 1–5 household days after the snapshot day:** held when `created_at` is at or
   before the read, or `occurred_at` is a real time at or before the read.
4. **Everything else counts:**
   - deposits dated after the snapshot day;
   - charges dated six or more days after;
   - Plaid charges dated ahead that reached the ledger after the read with no earlier time;
   - manual rows dated after the snapshot day.

**A "real time"** is a parsable instant that is not on a whole UTC hour. Midnight in any whole-hour offset,
Chicago's included, is a placeholder Plaid documents institutions sending. Stored data is unchanged; the rule simply
does not treat those values as evidence.

**Applied once, in the ledger** (`lib/forecastLedger.ts`).
- With a snapshot, the actual-rows query now reads the snapshot day too, and each row passes `isInSnapshot` once.
- `bankToday` and the curve take their rows from that one loop, so they cannot disagree about it.

**`lib/plaidSync.ts` is byte-identical to `main`.** The re-stamp from `c7da213` is gone. Rows a Sync backfills after
reading the balance carry no evidence of being new, so rule 2 holds them.

## ⚠️ Deviation from the plan: why arrival alone does not count a row

**The plan's rule:** "a row dated on the snapshot day is counted only if created after the snapshot".
`c7da213` built exactly that. Review showed it adds double counts that PR4a never made, on the normal path:
- **Feed latency.** Chase rows reach Plaid, and so the ledger, hours or days after they happen. The sync's own
  comments cite a 24–72 hour background poll. A charge made at 08:00 and delivered after a 10:00 read was already
  inside that balance. By arrival alone it looks new, and after nearly every Sync that day's purchases would count
  twice.
- **The Sync's own backfill.** A manual Sync reads the balance first, then backfills rows the cursor missed. Those rows
  arrive seconds after a balance that held them. A re-stamp of `bankSnapshotAt` patched this, but compared the
  database clock with the app clock inside a few milliseconds and could move the snapshot past midnight.
- **Posting times.** `occurred_at` is Plaid `datetime` (often a posting time), else `authorized_datetime`. A pending
  charge in the ledger at the read, re-keyed onto its posted row, keeps its `created_at` and takes a posting time
  after the read. Its authorisation was inside `available`. Time alone would count it twice, which is why rule 2
  needs both.

**So a snapshot-day row counts only on positive evidence: a real time after the read, on a row the ledger did not
have at the read.**

**The plan's spec test changes accordingly.**
- "A −$40 row created at 14:00 → $960" becomes "−$40 that **happened** at 14:07 and arrived at 14:10 → $960".
- "Created at 14:00 with no transaction time" is now **$1,000**, and has its own test.

## What the rule changes compared with PR4a

Outcomes change in only two cases, each decided on evidence:

| Case | PR4a | PR4b | Cash |
|---|---|---|---|
| Snapshot-day row with a real time after the read that arrived after the read | held | counts | moves by the row, on the day it happens |
| Plaid charge dated 1–5 days after the snapshot day, in the ledger at the read (or with a real time before it) | counts | held | a double count removed |

Every other row is decided exactly as PR4a decided it.

**Residuals in those two cases:**
- **Counts, but the bank may already have it.** An authorisation from before the read that the ledger never saw
  pending, posted the same household day with a posting time after the read. The row is new to us, so no stored field
  can show it.
- **Held, but the anchor may not include it.** When Plaid returns no `available` balance, the snapshot is `current`,
  which leaves pending charges out. A charge pending at the read and dated ahead is then held although the balance did
  not include it.
- **Clock skew.** `created_at` is the database clock and `snapAt` the app clock.
  - Rule 3 compares them across the days between a pending row and its posting.
  - In rule 2 the comparison can only stop a row counting.

## What remains, stated plainly

These are PR4a's behaviours, and PR4b does not change them. Some are common.

- **Most Chase rows carry no transaction time.** A purchase after the read with no time is not counted until the next
  Sync, so cash is overstated in the meantime. The common case is unchanged; PR4b only improves rows with a real
  time.
- **A Plaid charge dated ahead** that happened before the read, arrived after it and has no time is counted on top.
- **Deposits dated ahead** count even if already in `available`, for example a posted weekend deposit dated Monday.
- **A pending deposit dated on the snapshot day** that existed at the read is held, although `available` leaves it
  out.
- **Typed balances** (`routes/forecast.ts`):
  - manual rows dated on the snapshot day are held whenever they were typed;
  - rows dated after it count whenever typed, including debt-payment rows written by `routes/debts.ts`.
- **Webhook and cron heal backfills** do not move the snapshot. Their rows fall under the same rules.
- **A backfilled or re-keyed row loses `occurred_at`.** Backfill inserts write null, and the re-key overwrites it with
  the incoming value. Under this rule a missing time only ever means "held" on the snapshot day, and "decide by
  arrival" ahead of it. It cannot create a double count. Preserving the value is sync write-path work for PR4d.
- **How often each case occurs is not measured.** That needs a read-only production query Brad approves. The
  production database stays locked.

## ⚠️ Surfaces still on the day rule (disclosed, not aligned in this PR)

The plan put the web `accountBalance.ts` in PR4's scope. It is deferred, because the web needs `created_at` and
`occurred_at` in the API (spec plus codegen). Until then these figures can differ from `bankToday` by exactly the two
changed cases above:

- **Banking → Chase.**
  - `pages/transactions.tsx:706` seeds the trend chart's today point from the web `balanceAtEndOfDate(todayISO)`
    (`lib/accountBalance.ts`, day rule). It falls back to `cashProjection.bankToday` only when that is empty, while the
    following points come from `cashProjection.daily`.
  - The ending balance and the period start and end balances use the same day rule.
  - **The gap disappears once a newer snapshot moves past the rows' dates.**
- **"Why this number?"** (`routes/bankBalanceExplain.ts` `sinceAnchor`). It already shows its note when its lines and
  the balance are counted differently.
- **The sync's bank reconciliation** (`plaidSync.ts` `ledgerSince`). A row decided differently can show up in its drift
  log; nothing is written from that log.

**The web app's code is unchanged; its Chase figures are the ones that can disagree.** The shared
`lib/avalanche-core` gains the rule and its export. Web tests and the bundle guard were re-run.

## Review findings and what was done

| Finding | Done |
|---|---|
| MEDIUM: the five-day hold ignores whether a row is money in or out | Rule 3 is charges only. Pending-deposit tests: unit, and a cash-signal test (+$2,000 dated the next day, existing at the read → 3000.00). |
| MEDIUM: the re-stamp mixes clocks within milliseconds | Re-stamp removed; `plaidSync.ts` equals `main`. Backfilled rows are held by rule 2. The stale-cursor test stays and fails on the previous rule. |
| MEDIUM: the Banking page contradicts the ledger, undisclosed | Disclosed above, with the deviation from the plan. |
| LOW: the re-stamp can cross midnight | Gone with the re-stamp. |
| LOW: `pickRealTime` placeholders in other offsets | The rule ignores whole-hour UTC times. Stored values unchanged. |
| LOW: backfill and re-key lose `occurred_at` | Cannot cause a double count under this rule (above). Write-path fix in PR4d. |
| LOW: `datetime` preferred over `authorized_datetime` | The rule no longer depends on which it is. An earlier time proves existence either way; a later time counts only together with a later arrival. The order is unchanged because it would change stored values. |
| LOW: remaining risk broader than stated | Rewritten above. |
| NIT: no tests for the WHERE guard or midnight | The WHERE guard is gone. The 21:30 Chicago read and the month-end window are unit-tested. |
| Note overstatements | Corrected. Pending rows are dated by the day they occurred; there is no "seconds" claim; the web and avalanche-core are addressed above; reconciliation is described as a log only; measurement needs an approved production read. |

## Figures that should move

**Live**, wherever the bank balance is shown or used: `bankToday`, the forecast curve and low point, and the
spine's bank balance on Banking, Forecast and Reports.
- **Down** by snapshot-day rows with a real time after the read that arrived after it.
- **Up** by Plaid charges dated 1–5 days after the snapshot day that were in the ledger at the read.
- **Unchanged:** every other row, and every household with no snapshot.

**Worked example** (golden case "PR4b golden — the snapshot rule"). The full household's balance was read at 10:00 CT
on 05-08 (15:00Z), plus seven rows:

| Row | PR4a | PR4b |
|---|---|---|
| −35 dated 05-08, real time 18:23Z, arrived 18:30Z | held | **counts** |
| −15 dated 05-08, arrived 05-09, no time | held | held |
| −22 Plaid charge dated 05-10, in the ledger at the read | counts | **held** |
| +500 Plaid deposit dated 05-10, in the ledger at the read | counts | counts |
| −18 Plaid charge dated 05-10, arrived after the read | counts | counts |
| −90 Plaid charge dated 05-14 (+6) | counts | counts |
| −12 manual, dated 05-09 | counts | counts |
| **`bankToday`** | **3143.00** | **3130.00** |

2785 − 22 + 500 − 18 − 90 − 12 = 3143.00 before. 2785 − 35 + 500 − 18 − 90 − 12 = 3130.00 after.

**Not measured:** live before/after figures for the household. The production database is locked and no signed-in
browser was used.

## Must not change

- **Every existing expectation.**
  - The 10 golden entries recorded before the rule are byte-identical with it. Only the worked-example entry changed
    with the review fix.
  - The cash signal, household clock, forecast past rows, bank-balance explain, household scenario and spine parity
    suites pass unchanged, because their fixtures carry `created_at` from `52d27ef` and no `occurred_at`.
- **No-snapshot behaviour, `plaidSync.ts`, the explain route and the reconciliation.**
- **The landing bundle:** within its cap (below).

## Tests

- **`lib/snapshotInclusion.test.ts`** (14):
  - before the snapshot day;
  - on the day with no time, whenever it arrived;
  - a time before the read;
  - a time and arrival after the read (charge and deposit);
  - a later time on a row the ledger had at the read (charge and deposit) → held;
  - whole-hour and unparsable times;
  - Plaid charges at +2 and +5 existing at the read, arriving later with an earlier time, arriving later with no time,
    and at +6;
  - a pending deposit ahead;
  - a manual row ahead;
  - a 21:30 Chicago read;
  - the window across a month end.
- **`__tests__/ledgerCreatedAt.test.ts`** (5): the fixture helper in both offsets, and on both clock-change days.
- **`cashSignal.integration.test.ts`** (+6), on a $1,000 balance read at 10:00 CT:
  - −$40 dated that day, arrived 09:00 → 1000.00;
  - happened 14:07, arrived 14:10 → 960.00 in `bankToday` and `daily[0]`;
  - arrived 14:00 with no time → 1000.00;
  - happened 08:12, arrived 14:00 → 1000.00;
  - a pending Plaid −$25 dated two days ahead, existing at the read → 1000.00;
  - a pending +$2,000 dated the next day, existing at the read → 3000.00.
- **`forecastLedger.golden.integration.test.ts`** (+1): the worked example. It asserts 3130.00, plus the full output.
- **`plaidSyncStaleCursorBackfill.integration.test.ts`** (+1): a manual Sync reads 2,500.00, then its stale-cursor
  backfill imports a −$40 row dated today that arrives after the read. `bankToday` stays 2500.00.
- **Failing before.** Run against `4cc83d1`'s rule with `plaidSync.ts` as on `main`, **7 of 74 fail**:
  - the no-time late arrival;
  - the pending deposit (cash signal and unit);
  - the golden worked example;
  - the stale-cursor backfill;
  - the no-time unit case;
  - the placeholder unit case.

## Verification

- **Full API suite (local Postgres test database):** **118 files, 867 pass, 8 todo**, on the final code. The count by commit:

  | Code | Files | Pass |
  |---|---|---|
  | PR4a | 116 | 835 |
  | `999b90f` | 116 | 840 |
  | `52d27ef` | 116 | 840 |
  | `c7da213` | 118 | 857 |
  | `4cc83d1` | 118 | 864 |
  | review fix | 118 | 867 |

  The review fix adds 3: two cash-signal tests (the plan's case split in two, plus the pending deposit) and one unit
  test.
- **Golden:** 11 of 11 pass under `CI=true`.
- **Workspace typecheck and build:** pass.
- **Landing bundle guard:** **572.5 KB of 580, unchanged**.
- **Web suite:** **118 files, 917 pass**, on the final code, including the avalanche-core change.

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
- **PR4d** — Plaid sync write path:
  - re-mint (two real same-amount charges both survive);
  - `occurredOnUserOverridden` honoured on re-mint;
  - backfill order around the balance read;
  - preserve `occurred_at` on backfill insert and re-key.
- **PR4e** — move the web `accountBalance.ts`, the explain route's `sinceAnchor` and the sync reconciliation onto
  `isInSnapshot`. The web part needs `created_at` and `occurred_at` in the API.
- **Measuring latency** — how often `occurred_at` is null for the household's Chase rows, and how late they arrive.
  This needs a read-only production query Brad approves.
- **PR9** — `lowestProjected` starts from a balance that leaves out day 0's own rows.
