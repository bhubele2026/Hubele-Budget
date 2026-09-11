# PR13 — Paginated ledger API

Plan PR13: the server half of the Chase ledger. The branch `feat/paginated-ledger-api` holds:
- the original commits `36211281` (code) and `46ae246` (note);
- a merge of `main` at `9e9deb8`, which brings in PR4c and PR4e;
- the review-fix commit and this note;
- a merge of `main` at `56596f3` (PR7), and the second review's fix commit.

The page switch is PR14, so nothing on screen changes here. The review of `46ae246` came back **REQUEST CHANGES**
(table under Review), and a second review of `dd8c1bb` followed (Second review). This note describes the branch after
both.

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
  the web app (identical to `main` at `56596f3`).

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
- **Pairing reads the rows `bankToday` reads** (second review, R2): every row dated through today and, after today,
  only rows flagged for the forecast (`inForecast`). Those go through one run; the unflagged rows after today go
  through a run of their own, so none of them replaces a pending row the bank balance counts. Each row is classified
  once.

| `balanceReason` | Moves the balance by |
|---|---|
| `counted` | its amount |
| `superseded` | 0: a pending row its posted row replaced (PR4c pairing, over the whole history) |
| `duplicate` | 0: a second row with the same Plaid transaction id |
| `not_bank` | 0: a mask-twin row; the bank balance reads only the snapshot's account |

- **Every row carries these:** `balanceAmount`, `countsInBalance`, `balanceReason`, and `replacedPendingId` on a posted
  row that replaced a pending one.
- **`totals` sum `balanceAmount`.**
- **`heldAhead` labels a row dated after the snapshot day that the snapshot already holds.** It is the anchored rule's
  `held`: `isInSnapshot` holds the row and, for a posted row that replaced a pending row, holds that pending row too.
  Pairing does not depend on the anchor, so the pairs above serve (second review, R3; no second run).
- **`stalePending` labels a row still pending and dated more than `STALE_PENDING_DAYS` (14) days before today**
  (second review, R1). A label only; see the open residual.
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
                             replacedPendingId, heldAhead, afterToday, stalePending
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
- **Two double counts are not fixed, deliberately.** Both are Brad's decisions (CLAUDE.md §1):
  - a logged debt payment beside its bank debit (a survey of it is running);
  - a leftover pending row that pairing cannot match to its posted row. It is labelled `stalePending` after 14 days;
    see Residuals.
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
  `artifacts/h2budget/src`: identical to `main` (`56596f3`).
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

### ⚠️ Open: a leftover pending row its posted row cannot replace (Brad's decision)

This is the second open double count; the first note called the logged payment the only one.

- **What happens.** PR4c's pairing (`canSupersede`) replaces a pending row only when the posted row is on the same
  account, dated within 7 days, at or above the pending amount and at most 1.30 × it + $1.00, with fuzzy-equal
  descriptions. A pair outside that stays two rows, and both count in full:
  - a gas hold that posts lower (−100.00 pending, −45.00 posted);
  - a hotel that posts above the cap (−200.00 pending, −380.00 posted);
  - a merchant name that changes (`SQ *BLUE BOTTLE` pending, `BLUE BOTTLE COFFEE SAN FRANCISCO CA` posted).
- **Why the row is still there.** The sync deletes a pending row when Plaid removes it or it vanishes from the feed,
  but neither the `removed` delete nor the vanished-pending sweep deletes a row the user has touched. So only a pending
  row categorised while pending survives beside its posting.
- **The effect.** Every register balance before the pending row reads higher by its amount, and money out counts it
  twice. The reviewer measured `balanceStart` and `totals.moneyOut` both 306.00 off on three such pairs.
- **Cash today does not move while the snapshot is fresh.** A Sync reads the balance after both rows, so
  `isInSnapshot` holds both and they add 0 to `bankToday`. Only the register, which puts every row on its own date,
  counts both.
- **What this PR does.** It labels the row and changes no number. `stalePending` is true on a row that is still
  pending and dated more than `STALE_PENDING_DAYS` (14) days before the household's today, whatever its
  `balanceReason`. PR14 will flag these rows.
- **Pending Brad's decision:** count a stale pending row (more than 14 days) as 0 in the register. Not implemented:
  CLAUDE.md §1 says stop and ask before changing a financial rule. If approved, it goes in `registerAmount` and
  `classifyCashRows` together, like the logged payment.

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

After today (second review, R2):
- **Any `totals` range that reaches past today can count a charge twice among rows dated after today**, until the
  later row's day arrives and it pairs. Balances are unaffected. Two shapes:
  - a pending row dated through today whose posted row is dated after today and not flagged counts today, as in the
    bank balance, while the posted row is listed at its amount with no balance. In the fixture, money out with no end
    date is 243.00, the coffee's 12.00 twice; through today it is 222.00, the start less today;
  - an unflagged and a flagged posting dated after today competing for one pending row both count while the pending
    row is 0: money out 20.00 for one 10.00 charge (third review).

  PR14 should pass `to` no later than today for the register view.
- **`heldAhead` can differ from the old anchored label only on rows dated after today**, which carry no balance. Rows
  through today see the same pending candidates under both runs. Two shapes (third review):
  - an unflagged posted row the snapshot holds, whose pending half it does not: now true, was false;
  - a flagged posting that now pairs with the pending row the unflagged posting used to take: now false, was true.
- **A flagged posting dated after today hides a real pending charge from today's balance** until its own date. The
  spine does the same, so the register mirrors it. It needs a Plaid posting flagged for the forecast, which is unusual;
  it belongs to the PR4c cash-row rule, not this PR.

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
- **The register load:** every row in scope (eleven columns), classified once in memory without an anchor, then
  `isInSnapshot` on the rows dated after the snapshot day for `heldAhead`. Before the second review it was classified
  twice, once without an anchor and once with it.
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

**Second review (R3), measured the same way on 5,000 rows with 500 pending**, through the mounted routes. The
figures in the responses were identical on every request.

| Request | `dd8c1bb` + merge (two runs) | One run |
|---|---|---|
| First page, four runs | 878, 910, 873, 886 ms | 457, 448, 445, 441 ms |
| 120 balances | 836 ms | 431 ms |

Both runs returned money out 243,834.00, start 246,053.00 and today 2,219.00.

The cost left is mostly pairing (`pairPendingWithPosted`), which grows with the pending rows.

### Other

- **The copy of a repeated Plaid id that counts** is the first in ledger order. `bankToday` counts the first it reads.
  The two differ only with a duplicate id, which `transactions_plaid_txn_uq` forbids (not confirmed in production).
- **Row annotation** is a copy of `GET /transactions`'s block, which stays untouched.
- **Without a snapshot time, every balance is null.** `balanceToday` is null when the snapshot has no time, even
  with a balance.
- **The fallback without a resolvable account is `isBankRow`'s manual rule,** which is broader than the page's
  `isChaseFallbackSource`.
- **Search does not reach display names or merchant aliases.**

## Tests

`__tests__/transactionsLedger.integration.test.ts` (22 tests: the 19 below the second review, unchanged, and its 3),
mounted through `routes/index.ts`.
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

**Second review fixture:**
- a $1,000.00 snapshot read 05-15 at 10:00 CT; bank balance 968.00;
- an unmatched gas hold (−100.00 pending, categorised; −45.00 posted);
- pending rows 15 and 14 days old;
- a held-ahead charge, and a posted Target row the snapshot rule holds on its own but whose pending half it does not;
- a pending −9.00 whose posted row is dated after today and flagged for the forecast;
- the review's repro: a pending −12.00 today, its posted row tomorrow, not flagged.

| Test | What it asserts |
|---|---|
| **R1: `stalePending`** | The gas hold and the 05-05 row are stale; 05-06 (exactly 14 days) is not; posted rows are not. The gas hold is still `counted` at −100.00. The review fixture's replaced pending row (04-20) is the only stale row there, at 0.00. |
| **R2: pairing after today** | Spine 968.00 = `balanceToday` = end balance = the pending coffee's running balance. The coffee is `counted` at −12.00; its posted row is `afterToday` with no pair. The flagged row's pending half is `superseded`. Start 1,190.00. Balances: 04-19 1,190.00; 05-15 1,030.00; 05-16, 05-18 and 05-19 980.00; today 968.00; 05-21 null. Through today: money out 222.00 = start − today. No end date: 243.00. |
| **R3: `heldAhead`** | For every row of the main, review, edge and second-review households, `heldAhead` equals the anchored `classifyCashRows` run's label. The held-ahead charge is labelled. The Target posted row, which `isInSnapshot` holds, is not. |

**On `dd8c1bb` + the merge**, the three new tests gave: R1 fails (no `stalePending`); R2 fails (the coffee
`superseded`; start 1,178.00; 05-15 1,018.00; 05-16 through today 968.00; money out 210.00 through today, 231.00 with
no end date); R3 passes, which confirms the helper reproduces the old label.

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

**After the second review**, on the fix commit, which sits on the merge of `main` at `56596f3`:

- **Full API suite** (local test database): **126 files, 1,058 pass, 7 todo.**
- **Ledger file plus spine parity, targeted:** 2 files, 34 pass. The 19 earlier ledger tests are unchanged.
- **Web suite:** 119 files, 933 pass.
- **Typecheck:** clean. **Build:** exit 0. **Entry-graph guard:** OK.
- **Codegen:** re-run after the changes; the generated files did not change.
- **Landing bundle:** **572.5 KB of 580 KB**, as before.
- **Protected paths:** `routes/transactions.ts`, `lib/forecastLedger.ts`, `lib/cashSignal.ts`,
  `lib/ledgerCashRows.ts`, `routes/spine.ts`, `lib/avalanche-core` and `artifacts/h2budget/src` are identical to
  `56596f3`.

**On the first review-fix commit** (`main` at `9e9deb8`): full API suite 123 files, 974 pass, 8 todo; web 118 files,
917 pass; typecheck, build, entry-graph and codegen clean; landing 572,459 bytes.

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

## Second review

**`dd8c1bb`, a second independent review.** `main` at `56596f3` (PR7) is merged first; the fixes are one commit on top.

**The merge.** Only the three generated `.d.ts.map` files conflicted; codegen and typecheck rebuilt them. PR7 added
`pfcDetailed` to `Transaction`, which the ledger row copies, so the merge commit carries the regenerated
`api-zod/src/generated/api.ts` (+6) and `dist/generated/api.d.ts` (+5) with the maps.

| Finding | Before | After |
|---|---|---|
| **HIGH R1:** a leftover pending row its posted row cannot replace counts beside it; the note called the logged payment the only open double count | One open double count named. Nothing marks such a row. The reviewer measured `balanceStart` and money out both 306.00 off. | **(a)** The note names the second (Residuals): which pairs, why only a row categorised while pending survives, and why cash today does not move while the snapshot is fresh. **(b)** `stalePending` on every row (spec: required boolean): pending and dated more than `STALE_PENDING_DAYS` (14) days before today. No number moves. **(c)** Tested. **(d) Pending Brad's decision:** count a stale pending row as 0 in the register. Not implemented (CLAUDE.md §1). |
| **LOW R2:** the register paired across today; `bankToday` reads only forecast-flagged rows after today | Fixture: a pending −12.00 today, its posted row tomorrow. The pending row `superseded`; start 1,178.00; the end of 05-19 968.00, 12.00 low; money out through today 210.00. | Pairing reads the rows `bankToday` reads. The pending row `counted`; start 1,190.00; 05-19 980.00; through today 222.00. Today 968.00, the spine's, in both. |
| **LOW R3:** two classification runs per request | 878–910 ms per page, 836 ms for 120 balances (5,000 rows, 500 pending) | One run; `heldAhead` from `isInSnapshot`. 441–457 ms per page, 431 ms for 120 balances, with identical figures. The 19 earlier tests pass unchanged; `heldAhead` equals the old run's label on every fixture row. |
| **NIT:** "without a snapshot balance" | | "without a snapshot time" (Other). |

**⚠️ Deviation on R2.** The brief said to pair only rows dated through today. The bank balance also reads future rows
flagged for the forecast, and pairs them. Pairing only rows through today would count a pending row whose flagged
posted row is dated after today, which the bank balance does not count. The start and every day before that pending
row would then read high by its amount: 9.00 on 05-15 through 05-18 in the fixture, where the test asserts 980.00.
So the register pairs through today plus the flagged rows after today: the same set `bankToday` classifies, above its
lower bound. The residual it leaves is under Residuals, "After today".

## Left for PR14 and after

- **PR14 — move the Chase page onto these endpoints:**
  - paged rows and totals, running balances, `balances` for the trend chart, and bulk review;
  - retire the 1,000-row pull;
  - show `heldAhead`, `afterToday`, `stalePending` and rows that do not count;
  - do not hide rows the server lists.
- **Brad:** how a logged debt payment and its bank debit count. Any rule changes `classifyCashRows` and
  `registerAmount` together.
- **Brad:** whether a stale pending row (more than 14 days) counts 0 in the register.
- **A ledger for the other checking accounts.**
- **After PR14:** point `GET /transactions` at the shared annotation block.
