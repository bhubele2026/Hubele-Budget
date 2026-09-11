# PR13 — Paginated ledger API

Plan PR13: the server half of the Chase ledger. The branch `feat/paginated-ledger-api` holds:
- the original commits `36211281` (code) and `46ae246` (note);
- a merge of `main` at `9e9deb8`, which brings in PR4c and PR4e;
- the review-fix commit and this note.

The page switch is PR14, so nothing on screen changes here. The review of `46ae246` came back **REQUEST CHANGES**
(table at the end); this note describes the branch after the fixes.

## The problem

- **The Chase page loads the whole household and works it out in the browser.**
  - `pages/transactions.tsx` asks `GET /transactions` for two years back to a year ahead, capped at 1,000 rows.
  - It then scopes the rows to the account, filters and totals them, and computes running balances from whatever
    arrived.
- **Past 1,000 rows it goes wrong silently.** The server answers newest first and cuts at the limit, so the oldest
  rows drop off. Money in and out, the ending balance and every running balance move without a word. CLAUDE.md §2
  bans exactly this.
- **Its balances use a day rule the bank balance no longer uses.**
  - `lib/accountBalance.ts` counts every row dated after the snapshot day.
  - The bank balance has decided by `isInSnapshot` since PR4b, has counted a replaced pending charge once since PR4c,
    and runs one per-row rule (`classifyCashRows`) since PR4e.

## What changed

- **Three endpoints** on a new router, `routes/transactionsLedger.ts`, with all the logic in `lib/bankLedger.ts`.
- **The spec** is in `lib/api-spec/openapi.yaml`; the generated `api-zod` and `api-client-react` are committed.
- **`GET /transactions` is untouched**, as are `lib/forecastLedger.ts`, `lib/cashSignal.ts`, `routes/spine.ts` and
  the web app (identical to `main`).

### Scope: settled by the server

- **A row is on the ledger when the bank balance reads it** (`isBankRow`):
  - its Plaid account is the one `resolveSnapshotAccount` returns, or
  - it has no Plaid account (an empty string counts as none) and its source, ignoring case, is neither `amex` nor
    `plaid:*`.
- **Mask twins are listed too:** same institution (ignoring case), mask, type and subtype. The Chase page has always
  shown them as one account (#462).
- **Manual rows are in, because the bank balance counts them.** The server settles the scope. A client that hides a
  row the register counts breaks the running-balance chain, so PR14 must not hide rows client-side.

### What each row moves the balance by: the cash rule, over the whole history

- **The rule is PR4e's `classifyCashRows`,** run over every row in scope, with no snapshot anchor. It runs in
  `loadRegister`, one read per request.

| `balanceReason` | Moves the balance by |
|---|---|
| `counted` | its amount |
| `superseded` | 0: a pending row its posted row replaced (PR4c pairing, over the whole history) |
| `duplicate` | 0: a second row with the same Plaid transaction id |
| `not_bank` | 0: a mask-twin row; the bank balance reads only the snapshot's account |

- **Every row carries these:** `balanceAmount`, `countsInBalance`, `balanceReason`, and `replacedPendingId` on a posted
  row that replaced a pending one.
- **`totals` sum `balanceAmount`.**
- **A second, anchored run only labels `heldAhead`:** a row dated after the snapshot day that the snapshot already
  holds.
- **`registerAmount` is the single place a new per-row rule plugs in.** One is expected (the open residual below).

### One register, through today

- **The opening balance** = `computeCashSignal(…, { horizonDays: 90 }).bankToday`, the spine's own call, minus the
  balance amounts of every row dated through today.
- **The balance after a row** = opening + the running sum of balance amounts in ledger order (`occurred_on, occurred_at
  nulls first, id`), in integer cents.
- **What follows by construction:**
  - the end of today is the spine's `bank.balance`;
  - each running balance is the next older one plus the row's `balanceAmount`;
  - no balance depends on the non-date filters or on the page.
- **After today there is no balance.**
  - A row dated after today is listed with `afterToday: true` and `runningBalance: null`.
  - `balanceStart`, `balanceEnd` and `balances` for any day after today are null.

### `GET /transactions/ledger`

| Parameter | Rule |
|---|---|
| `limit` | Plain digits, 1–100, default 50. `101`, `0`, `1.5`, `abc`, empty, `1e1`, `0x10` and `+5` are 400. |
| `cursor` | Opaque: the previous page's `nextCursor`. |
| `from`, `to` | Real `YYYY-MM-DD` dates from year 1000, `from` ≤ `to`. |
| `search` | Case-insensitive match on the description plus the category name; `%` and `_` are literal; at most 200 characters. |
| `reviewed`, `pending`, `uncategorized` | The strings `"true"` or `"false"`; anything else is 400. |
| `categoryId` | A uuid; cannot be combined with `uncategorized=true`. |
| `source`, `member` | Exact match. |
| `account` | Optional `plaid_accounts.id`. Must be the resolved account or one of its twins, otherwise 400 (another household's account included). |

A NUL byte in any query value is a 400.

The response is `LedgerPage`:

```
rows           LedgerRow[]   Transaction (annotated as GET /transactions does) +
                             runningBalance, balanceAmount, countsInBalance, balanceReason,
                             replacedPendingId, heldAhead, afterToday
nextCursor     string | null
limit          integer
matchingCount  integer       every filter, reviewed included
totals         { count, moneyIn, moneyOut, net }   balance amounts; every filter except reviewed
review         { reviewed, unreviewed }            every filter except reviewed
balanceStart   string | null the end of the day before `from` (before the first row without `from`)
balanceEnd     string | null the end of `to`, default today
balanceToday   string | null the spine's bank balance
anchor         { today, todayBalance, snapshotBalance, snapshotAt, snapshotDay }
account        { via, plaidAccountIds }
```

- **Order:** `occurred_on desc, occurred_at desc nulls last, id desc`.
- **Cursor:** base64url JSON `{v, d, t, i}`. The time is validated by a round trip, so `2026-02-30T…` is refused.

### `GET /transactions/balances?account&dates`

- **`dates`:** 1–120 real dates from year 1000.
- **Response:** `{ balances: [{ date, balance }], anchor, account }`.
- **A date's balance** is the running balance after the last row dated on or before it.
- **Null** for a date after today, and for every date without a bank snapshot.

### `POST /transactions/bulk-review-matching`

- **Body:** `{ filter, reviewed, expectedCount }`, with the ledger's filter.
- **One transaction:**
  1. Lock the matching rows in id order (`FOR UPDATE`, reading at most 1,001). More than 1,000 is 400
     `too_many_rows`.
  2. Select the matching rows again in a new statement. A different set is 409 `matching_rows_changed`: a row moved
     while the lock waited. The locking statement picks rows from its own, older snapshot, so without this a row that
     no longer matched could be marked.
  3. A count other than `expectedCount` is 409 `matching_count_changed`.
  4. Otherwise set `reviewed` on the locked rows not already in that state.
- **Response:** `{ matched, updated, updatedIds }`.
- **Refused with 400:** an unknown filter key, a fractional `expectedCount`, and any filter value that fails the
  checks above.
- **It does not compute the bank balance.**

## ⚠️ Deviations from the plan

- **Manual rows are in scope.** The plan says "resolveSnapshotAccount plus mask", but the bank balance counts manual
  rows, so the register must too. The server settles this; PR14 must not hide rows client-side.
- **Past days are a register; only today uses the snapshot rule.** Today equals `bankToday` exactly. Earlier days
  are the running sum of balance amounts, which differs from replaying `available` in the ways listed under
  Residuals.
- **A logged debt payment beside its bank debit counts twice.** This is not fixed, deliberately. How a payment logged
  in the app and its ACH are treated is Brad's decision (CLAUDE.md §1), and a survey of it is running.
- **Future rows are labelled, not capped.** They stay listed, and no balance is given for them or for any day after
  today.
- **The boolean query parameters are strings,** and `via` and `balanceReason` are plain strings. The generated
  `zod.coerce.boolean()` reads `"false"` as true, and spec enums would add runtime constants to the client.
- **`account` accepts only the snapshot's account and its twins.**
- **Fixture detail.** Of the plan's 10 rows of +$100, one is untimed and one is a deposit on the snapshot day.
- **No index or DDL.** The review showed the proposed index could not serve the `OR (plaid_account_id is null …)`
  condition; the proposal is withdrawn.

## Figures that should move

**None on screen**, because nothing in the web app changed.

**Against `46ae246`, on the review's history fixture:** a $1,000.00 snapshot read 05-15 at 10:00 CT, today 05-20,
bank balance 990.00.

| Figure | `46ae246` | Now | Review's figure |
|---|---|---|---|
| `balanceStart` | 2,210.00 | **2,170.00** | 1,670.00 |
| Balance, end of 04-21..04-24 | 2,030.00 | 2,030.00 | 1,530.00 |
| `totals.moneyOut` | 1,420.00 | **1,380.00** | 880.00 |
| Newest running balance / end balance | 790.00 (the future −200.00 counted) | **null** for the future row; 990.00 at the end of today | 990.00 |
| `balances` for 06-30 | register arithmetic | **null** | null |

- **Where the $40 went:** the replaced pending −40.00 no longer counts.
- **The remaining $500:** in every row that differs, it is the logged "Payment — Amex" beside its ACH, which is the
  open decision.

**When PR14 moves the page:**
- totals and running balances will cover every row, on these amounts;
- today's Chase balance will be the spine's;
- manual non-Amex rows will be listed.

## Must not change

- **`GET /transactions`,** `lib/forecastLedger.ts`, `lib/cashSignal.ts`, `routes/spine.ts` and every file under
  `artifacts/h2budget/src`: identical to `main` (`9e9deb8`).
- **Cash today, the forecast and spending:** no code on those paths changed, and the full API suite passes.
- **No new dependency, no DDL, no production access.**
- **The landing bundle:** unchanged by this branch (Verification).

## Residuals

### ⚠️ Open: a logged debt payment beside its bank debit (Brad's decision)

- **What happens.** `routes/debts.ts` writes a manual −X "Payment — <debt>" row when a payment is logged. When the
  bank's own ACH for that payment also arrives, both count in the bank balance today, and both move the register.
- **The effect is not confined to the snapshot window.** Every balance before the pair reads X higher, and money out
  counts X twice. In the review's fixture that is the $500.00 in the table above.
- **Where a rule would go.** `registerAmount` in `lib/bankLedger.ts`, as one more reason that moves a row by 0, and in
  `classifyCashRows` at the same time, so the bank balance and the register stay one rule.

### Past days on the register versus the bank balance

Today is exact in every case. Earlier days differ in three ways:

- **A charge held ahead** (`heldAhead: true`). It is dated after the snapshot day and already inside the snapshot
  balance, and the register puts it on its own date. The days in between read higher than the bank showed, by that
  charge; in the review's fixture the snapshot day ends at 1,030.00 against the 1,000.00 read. With a stale snapshot
  that can be up to five days. The label is there so PR14 can say so.
- **A posting that adds only its tip in the bank balance** (PR4c, `adjusted`). The register takes the posted row in
  full and the pending row at 0: the right history, but not the bank balance's arithmetic for that pair.
- **Pairing window.** Pairing over the whole history can match a posted row with a different pending row than the
  bank balance's shorter window does (the lower edge `classifyCashRows` documents). The spine's figure does not move.

### Cursor edge cases

- **Keyset paging.** Inserts and deletes do not shift pages. A row inserted above the cursor is not on later pages; a
  fresh first page shows it.
- **A changed sort key.** A row whose key changes between pages can be skipped or repeated: a date edit, or a Plaid
  re-key that rewrites `occurred_on` or `occurred_at`.
- **Not bound to filters or account, and not signed.** A well-formed forged cursor only moves the start point within
  the caller's own household. A malformed one is a 400.

### Read skew

- The anchor, the register load, the page and the aggregates are separate reads, with no shared snapshot.
- A row written between them is listed with `runningBalance: null` if the register missed it, or can leave one
  response's balances off by that row until the next request.

### Query cost

**Per ledger request:**
- `computeCashSignal`: the spine's full call.
- Account resolution.
- **The register load:** every row in scope (ten columns), classified twice in memory, once without an anchor and once
  with it.
- **The page query:** a filtered keyset read with no window.
- **The aggregate query:** one pass over the rows in scope, with the non-counting rows passed in as a small JSON list.
- The page's full rows, rules and aliases.

That is linear in the account's rows; nothing is evaluated once per row. `/transactions/balances` is the register load
plus a binary search per date. Bulk review is one scan and a re-select, with no cash signal.

**Measured** on this Mac: local Postgres, 5,000 rows on one checking account, one request at a time, through the
mounted routes.

| Request | Before `ANALYZE` | After `ANALYZE` |
|---|---|---|
| First page (three runs) | 81, 53, 55 ms | 57, 66, 66 ms |
| Page 2 by cursor | 62 ms | — |
| Filtered page (`search` + `reviewed`) | 82 ms | 80 ms |
| 120 balances | 52 ms | 55 ms |
| `/spine`, for comparison | 17 ms | 7 ms |

- **The review measured `46ae246` at 1.2–1.6 s per page on 5,000 rows without `ANALYZE`.**
- **"Before `ANALYZE`" is not guaranteed cold.** Autovacuum may have analysed the table first. The figures do not move
  with `ANALYZE`, which is what a plan with no per-row aggregate predicts.
- **The cost grows with the account's whole history,** because the register reads every row. That is the price of H1.
- **No production measurement was made.**

### Other

- **The copy of a repeated Plaid id that counts** is the first in ledger order. `bankToday` counts the first it reads.
  The two differ only with a duplicate id, which `transactions_plaid_txn_uq` forbids (not confirmed in production).
- **Row annotation** is a copy of `GET /transactions`'s block, which stays untouched.
- **Without a snapshot balance, every balance is null.**
- **The fallback without a resolvable account is `isBankRow`'s manual rule,** which is broader than the page's
  `isChaseFallbackSource`.
- **Search does not reach display names or merchant aliases.**

## Tests

`__tests__/transactionsLedger.integration.test.ts` (19 tests), mounted through `routes/index.ts`.
- **Clock:** pinned to 2026-05-20 at noon in Chicago.

**Main fixture:**
- 250 × −1.00 and 10 × +100.00 on checking, with five untimed rows on 05-10 (one of them a deposit) and two timed rows
  at the same instant.
- 30 Amex rows.
- A +100.00 deposit after the read, which counts, and a −1.00 charge held ahead.
- Today = **5,081.00**; the day rule would give 4,980.00.

| Test | What it asserts |
|---|---|
| Pages of 100/100/60 | 260 unique ids in independently computed order. Page 1 ends inside the untimed group. Every row is `counted` with `balanceAmount` equal to its amount, and only the held-ahead row is labelled. Totals, review counts, start 4,331.00, end 5,081.00, `balanceToday` and anchor are identical on every page. |
| Untimed walk | Three at a time over 05-10, in exact order. |
| Limits and cursors | Defaults to 50. `101`, `0`, `1.5`, `abc`, empty, `1e1`, `0x10` and `+5` are 400; bad cursors are 400. |
| Running balances | The chain holds on balance amounts. Newest 5,081.00; oldest is the start plus its amount. |
| Filtered page | Search reaches only the 2026-05-03 row, carrying the unfiltered balances. Category names are searched; `%` and `_` are literal; a space is ordinary; `pending=true` works. |
| Amex | Never on any page. |
| Bad filters and accounts | Eight cases are 400; the ledger's own account is 200. |
| Balances equal the spine | `/spine` 5,081.00 equals today's balance. 03-31, 05-03 and 05-15 (5,101.00, the register) match; **05-21 and 06-30 are null**. |
| Dates | 1–120 accepted; 121, empty, a trailing comma, 02-30, words and a missing parameter are 400. |
| **Inputs that reached Postgres** | Year 0000 in from, to, dates, the cursor day and the bulk filter; cursor time `2026-02-30T10:00:00.000000Z` and year 0000; NUL in search, source, member, account, dates and each bulk filter string: all 400, nothing written. |
| **History fixture** | Spine 990.00. `balanceStart` 2,170.00, money out 1,380.00. The pending row is `superseded` at 0.00; the posted row names it as replaced; the logged payment is `counted`; the held-ahead row is labelled; the chain holds; `balances` for 04-09 through 05-19. |
| **Future rows** | The 05-25 row is `afterToday` with a null balance. The newest dated row, `balanceEnd` and `balanceToday` equal the spine. `to=06-30` gives a null end; `from=05-22` a null start (05-21 gives 990.00); later dates in `balances` are null. |
| **`source=plaid`** | Six rows; money out 680.00 on balance amounts. The running balances, start and end are the unfiltered register's. |
| Reviewing 20 rows | `matchingCount` 240; totals and balances unchanged. |
| Bulk review by filter | 239 is 409 and writes nothing; a misspelt key or 240.5 is 400; 240 updates 240 rows; a repeat updates 0. |
| More than 1,000 | 400, and none reviewed. |
| **Concurrent bulk review** | Another transaction moves a matching row out of range and holds its lock. Bulk review waits for that lock (seen in `pg_stat_activity`), then answers 409 `matching_rows_changed` with `matchingCount` 4, and nothing is reviewed. |
| Scope edges | The twin row is `not_bank` at 0.00; the pending coffee is `superseded`. Spine 930.00 equals `balanceToday` and the newest balance. **`balanceStart` is 1,000.00, the snapshot balance itself**, because every row is dated after the snapshot and none was in it. The totals are 70.00 out. Another household's account is 400 on GET and bulk. |
| No snapshot | Rows and totals come back; every balance is null. |

**On `46ae246`** (the new test file run against that commit's `lib/bankLedger.ts` and route, with this branch's
generated schemas):

**16 of 19 fail. The 3 that pass** are bad filters and accounts, 1–120 dates, and more than 1,000 rows.

- **Behaviour the old code does not have:**
  - history fixture: start 2,210.00, money out 1,420.00;
  - future rows: newest balance 790.00; balances after today given;
  - `source=plaid` on balance amounts;
  - the inputs that returned 500;
  - concurrent bulk review: the moved row is reviewed and the answer is 200;
  - scope edges: the twin row counts, so the start is not 1,000.00.
- **Fields the old response lacks** (`balanceToday`, `balanceAmount` and the rest, which the schema now requires):
  - the two paging walks, limits and cursors (which also fails on `1e1`), running balances, filtered page, Amex, the
    balances-equal-the-spine test (which also fails on after-today dates), no snapshot.
- **Cascades:**
  - reviewing 20 rows stops at its first page, before marking any;
  - so bulk review by filter starts with 0 reviewed instead of 20.

## Verification

All on the review-fix commit, which merged `main` at `9e9deb8`:

- **Full API suite** (local test database): **123 files, 974 pass, 8 todo**. That is `main`'s 122 files and 955
  (PR4e's note) plus this file's 19.
- **Web suite:** 118 files, 917 pass.
- **Typecheck:** clean. **Build:** exit 0. **Entry-graph guard:** OK.
- **Codegen:** re-run on the committed tree; the working tree stayed clean.
- **Landing bundle:** **572,459 bytes (572.5 KB) of 580 KB**, the same byte count as `46ae246`. The PR4c and PR4e
  files the merge brought in do not reach the landing path.
- **Protected paths:** `routes/transactions.ts`, `lib/forecastLedger.ts`, `lib/cashSignal.ts`,
  `lib/ledgerCashRows.ts`, `routes/spine.ts`, `lib/avalanche-core` and `artifacts/h2budget/src` are identical to
  `9e9deb8`.
- **`main` has moved on** to `56596f3` (PR7) since the merge; it is not merged here.

## Review

**`46ae246`: REQUEST CHANGES.** The money findings were reproduced through the mounted routes. Paging, routing,
household isolation and the bulk guards were verified sound.

| Finding | Done |
|---|---|
| **HIGH H1:** duplicates anywhere in history double-count money out and raise every earlier balance | Each row's balance amount comes from `classifyCashRows` over the whole history. A replaced pending row, a repeated id and a twin row count 0, and totals use the same amounts. `countsInBalance`, `balanceReason` and `replacedPendingId` are on every row. The review's fixture is a test: start 2,210.00 → 2,170.00, money out 1,420.00 → 1,380.00. **The logged payment beside its ACH is not changed (Brad's decision)**; it is the open residual, and `registerAmount` is where the rule would go. The note no longer says the error is confined to the snapshot window. |
| **HIGH H2:** manual-row scope cannot be left to PR14 | Manual rows stay in scope, as the bank balance counts them. The server settles scope; this note says PR14 must not hide rows client-side. The `source=plaid` test shows the balances stay the register's. |
| **MEDIUM M1:** future-dated rows break "end = spine" | New `balanceToday`. Future rows are labelled `afterToday` with no running balance. `balanceEnd` defaults to today. Start, end and `balances` are **null** for any day after today. Tested. |
| **MEDIUM M2:** inputs that pass validation return 500 | Years from 1000; the cursor time is round-tripped; a NUL byte in any string (query values, bulk filter, account) is refused. A 400 test covers each. |
| **MEDIUM M3:** quadratic page query | No SQL window or `cross join sums` remains. Running sums come from the single register pass, the page query is a filtered keyset read, and totals are one aggregate. The index proposal is dropped. Measured under Query cost. |
| **LOW L1:** bulk review can mark a row that no longer matches | The matching ids are re-selected in a new statement after locking; a different set is 409 `matching_rows_changed` and rolls back. Tested with a real lock wait. |
| **LOW L2:** the test mounts routers opposite to production | Mounted through `routes/index.ts`. |
| **LOW L3:** test gaps; `balanceStart` true by construction | Covered: future rows, history duplicates, the 500 inputs, a cross-household account, concurrent bulk review. The edge test asserts 1,000.00, the snapshot balance. |
| **LOW L4:** note overstatements | Error scope, cost, "PR14 decides" and the index are rewritten above. |
| **NIT:** `limit=1e1` / `0x10` accepted | Plain digits only; tested. |
| **NIT:** `moneyIn` counts zero-amount rows | `balance_amount > 0`. |
| **NIT:** held-ahead charge on a stale snapshot | Labelled `heldAhead`, and explained under Residuals. |

## Left for PR14 and after

- **PR14 — move the Chase page onto these endpoints:**
  - paged rows and totals, running balances, `balances` for the trend chart, and bulk review;
  - retire the 1,000-row pull;
  - show `heldAhead`, `afterToday` and rows that do not count;
  - do not hide rows the server lists.
- **Brad:** how a logged debt payment and its bank debit count. Any rule changes `classifyCashRows` and
  `registerAmount` together.
- **A ledger for the other checking accounts.**
- **After PR14:** point `GET /transactions` at the shared annotation block.
