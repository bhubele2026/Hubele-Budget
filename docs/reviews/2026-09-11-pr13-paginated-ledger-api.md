# PR13 — Paginated ledger API

Plan PR13: the server half of the Chase ledger. The branch `feat/paginated-ledger-api` is one commit on `main`
`2874a7b` (PR4c). The page switch is PR14, so nothing on screen changes here.

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
  - The bank balance has decided by `isInSnapshot` since PR4b, and counts a replaced pending charge once since PR4c.

## What changed

- **Three endpoints** on a new router, `routes/transactionsLedger.ts`, with all the logic in `lib/bankLedger.ts`.
- **The spec** is in `lib/api-spec/openapi.yaml`; the generated `api-zod` and `api-client-react` are committed.
- **`GET /transactions` is byte-identical to `main`**, as are `lib/forecastLedger.ts`, `lib/cashSignal.ts` and
  `routes/spine.ts`.

### One scope, one register

- **The ledger holds the rows the bank balance counts.** The SQL is a twin of `isBankRow` (`lib/forecastLedger.ts`).
  A row is on the ledger when either:
  - its Plaid account is the one `resolveSnapshotAccount` returns, or one of that account's mask twins (same
    institution name ignoring case, same mask, type and subtype); or
  - it has no Plaid account (an empty string counts as none, as in JavaScript) and its source, ignoring case, is
    neither `amex` nor `plaid:*`.
- **One copy per Plaid transaction id.**
- **Balances are a register.**
  - Each balance is a running sum over all the account's rows, oldest first (`occurred_on, occurred_at nulls first,
    id`), plus an anchor.
  - The anchor makes the end of today equal `computeCashSignal(…, { horizonDays: 90 }).bankToday`. That is the
    spine's own call, so the snapshot rule and PR4c's pairing are reused, not rebuilt.
  - The balance after a row = today's balance − the sum of rows dated through today + the running sum, all in
    `numeric`.
- **What follows by construction:**
  - each running balance is the previous one plus the row's amount;
  - `balanceStart` plus the range's amounts equals `balanceEnd`;
  - no balance depends on the non-date filters or on the page.

### `GET /transactions/ledger`

| Parameter | Rule |
|---|---|
| `limit` | 1–100, default 50. `101`, `0`, `1.5`, `abc` and an empty value are 400. |
| `cursor` | Opaque: the previous page's `nextCursor`. |
| `from`, `to` | Real `YYYY-MM-DD` dates, `from` ≤ `to`. |
| `search` | Case-insensitive match on the description plus the category name; `%` and `_` are literal; at most 200 characters. |
| `reviewed`, `pending`, `uncategorized` | The strings `"true"` or `"false"`; anything else is 400. |
| `categoryId` | A uuid; cannot be combined with `uncategorized=true`. |
| `source`, `member` | Exact match. |
| `account` | Optional `plaid_accounts.id`. Must be the resolved account or one of its twins, otherwise 400. |

The response is `LedgerPage`:

```
rows           LedgerRow[]   Transaction, annotated as GET /transactions does, + runningBalance
nextCursor     string | null
limit          integer
matchingCount  integer       every filter, reviewed included
totals         { count, moneyIn, moneyOut, net }   every filter except reviewed
review         { reviewed, unreviewed }            every filter except reviewed
balanceStart   string | null the end of the day before `from` (before the first row without `from`)
balanceEnd     string | null the end of `to` (after the last row without `to`)
anchor         { today, todayBalance, snapshotBalance, snapshotAt, snapshotDay }
account        { via, plaidAccountIds }
```

- **Order:** `occurred_on desc, occurred_at desc nulls last, id desc`, the web's `compareNewestFirst`.
- **Cursor:** base64url JSON `{v, d, t, i}`, holding the day, the time in UTC to the microsecond (or null), and the
  id. A null time sorts after every real time on its day.

### `GET /transactions/balances?account&dates`

- **`dates`** is a comma-separated list of 1–120 real dates. Repeats are allowed, and the answer keeps the order asked.
- **The response** is `{ balances: [{ date, balance }], anchor, account }`.
- **A date's balance** is the running balance after the last row dated on or before it.

### `POST /transactions/bulk-review-matching`

- **Body:** `{ filter, reviewed, expectedCount }`. The filter is the ledger's, with JSON booleans and `account`.
- **One transaction:**
  1. Lock the matching rows in id order (`FOR UPDATE`, reading at most 1,001).
  2. More than 1,000 is 400 `too_many_rows`.
  3. A count other than `expectedCount` is 409 `matching_count_changed`, carrying `matchingCount`. Nothing is written.
  4. Otherwise set `reviewed` on the locked rows not already in that state.
- **Response:** `{ matched, updated, updatedIds }`.
- **Guards:**
  - An unknown filter key is 400, so a typo cannot widen the filter to every row.
  - A fractional `expectedCount` is 400.
- **It does not compute the bank balance.**

## ⚠️ Deviations from the plan

- **Manual rows are on the ledger.**
  - The plan says "resolveSnapshotAccount plus mask". The bank balance also counts manual rows: hand-typed rows, and
    the payments `routes/debts.ts` writes.
  - A register that leaves out a row the balance counts cannot reconcile, so they are in.
  - Today's page shows only the Plaid account's rows when one is linked. **PR14 decides** whether to show them.
- **Past days are a register; only today uses the server rule.**
  - The plan asked to reuse the server rule where feasible. It is reused for the anchor, so today equals `bankToday`
    exactly.
  - Earlier days are register arithmetic. Where the bank balance counts a row differently from its full amount on its
    date, the days before that row move and today does not (Residuals).
  - Replaying `isInSnapshot` and PR4c's pairing day by day would rebuild the forecast ledger in this module.
- **The boolean query parameters are strings.**
  - The generated `zod.coerce.boolean()` reads `"false"` as true.
  - A spec `enum` would add a runtime constant to the client.
  - The route accepts only `"true"` and `"false"`.
- **`via` is a plain string, not an enum**, for the same bundle reason.
- **`account` accepts only the snapshot's account and its twins.** Other checking accounts in the page's picker
  anchor on per-account snapshots under the day rule, and have no ledger yet.
- **Fixture detail.** Of the plan's 10 rows of +$100, one is among the five untimed rows and one is a deposit on the
  snapshot day.
- **No index or DDL** (see Query cost).

## Figures that should move

**None on screen**, because nothing in the web app changed. When PR14 moves the Chase page onto these endpoints:
- totals and running balances will cover every row, not the newest 1,000;
- today's Chase balance will be the spine's, and running balances will follow the bank balance's rules instead of the
  day rule;
- manual non-Amex rows will appear, unless PR14 hides them.

## Must not change

- **`GET /transactions`,** `lib/forecastLedger.ts`, `lib/cashSignal.ts`, `routes/spine.ts` and every file under
  `artifacts/h2budget/src`: identical to `main`.
- **Cash today, the forecast and spending:** no code on those paths changed, and the full API suite passes.
- **No new dependency, no DDL, no production access.**
- **The landing bundle:** +1 byte.

## Residuals

### Past days on the register versus the bank balance

Today is exact in every case. Before the row concerned, each day reads higher by the amount of that charge:

- **A charge held ahead** (`isInSnapshot` rule 3). In the fixture the snapshot day ends at 5,101.00, while `available`
  held 5,100.00.
- **A PR4c pair.** Both rows are listed at full amount, but the balance counts the charge once, or counts only the tip.
  In the edge fixture the start is 1,045.00, where counting the charge once would give 1,020.00.
- **A mask-twin row.** It is listed, but the bank balance does not count it.

### Cursor edge cases

- **Keyset paging.** Inserts and deletes do not shift pages.
  - A row inserted above the cursor, such as a new charge today, is not on later pages. A fresh first page shows it.
- **A changed sort key.** A row whose key changes between pages can be skipped or repeated: a date edit, or a Plaid
  re-key that rewrites `occurred_on` or `occurred_at`.
- **Not bound to filters or account, and not signed.**
  - A well-formed forged cursor only moves the start point within the caller's own household.
  - A malformed cursor is a 400.
- **Times round-trip exactly** to the microsecond, and ties break on the id.

### Read skew

- The anchor, the page and the aggregates are separate reads with no shared snapshot.
- A row written between them can leave one response's running balances off by that row until the next request.
- There is no `REPEATABLE READ` transaction, because `computeCashSignal` reads through the shared pool.

### Query cost, per ledger request

- `computeCashSignal`: the spine's full call, about nine queries with a 90-day expansion.
- Settings and account resolution: three queries.
- The page query: every account row, with `row_number` and a running-sum window.
- The aggregate query: the same rows, without the window.
- The page's full rows, rules and aliases: three queries.

That is two account-wide scans per page. The household filter is served by
`transactions_household_idx (household_id, occurred_on)`; at household scale (thousands of rows) this is
milliseconds.

- **Proposed, not added:** an index on `(household_id, plaid_account_id, occurred_on, occurred_at, id)`, if
  production shows the scans.
- **Balances:** one scan, plus one join per date (at most 120).
- **Bulk review:** one scan, and no cash signal.

### Other

- **Duplicate Plaid ids.**
  - The ledger keeps the smallest id per Plaid transaction id; `bankToday` keeps whichever copy it reads first.
  - They differ only with a duplicate id, which `transactions_plaid_txn_uq` forbids.
  - The index is confirmed in the schema and the test database, not in production.
- **Row annotation** (`matchedRuleId`, `displayName`, `merchantSignature`) is a copy of `GET /transactions`'s block,
  which stays untouched.
- **Without a snapshot balance, every balance is null.** `bankToday` is then the starting balance, which belongs to no
  day.
- **The fallback without a resolvable account is `isBankRow`'s manual rule.** It is broader than the page's
  `isChaseFallbackSource` (manual, chase, plaid:chase, empty).
- **Search does not reach display names or merchant aliases**, as on the page today.

## Tests

`__tests__/transactionsLedger.integration.test.ts` (14 tests).
- **Clock:** pinned to 2026-05-20 at noon in Chicago.
- **Snapshot:** 5,000.00, read at 10:00 on 05-15.

**Main fixture.**
- Checking: 250 × −1.00 and 10 × +100.00.
  - Five rows on 05-10 have no time, and one of them is a deposit.
  - Two timed rows share one instant.
- Amex: 30 rows, 15 on the Amex Plaid account and 15 manual rows with source `amex`.
- Two rows split the rules:
  - a +100.00 deposit that happened and arrived after the read, which the snapshot rule counts;
  - a −1.00 charge dated 05-17 that was in the ledger before the read, which it holds.
- Today = 5,000 + 100 − 19 = **5,081.00**; the day rule would give 4,980.00.

| Test | What it asserts |
|---|---|
| Pages of 100/100/60 | 260 unique ids, in the order computed independently. Page 1 ends inside the untimed group. Every page carries the same totals (1,000.00 in, 250.00 out, 750.00 net), review counts (0/260), start 4,331.00, end 5,081.00, anchor and account. Pages match the generated schema. |
| Untimed walk | Three at a time over 05-10: pages of 3, 3 and 2, in exact order. |
| Limits and cursors | Defaults to 50. `101`, `0`, `1.5`, `abc` and empty are 400; a garbage, a forged and an array cursor are 400. |
| Running balances | Each equals the next row's plus its amount. The newest is 5,081.00; the oldest is the start plus its amount. |
| Filtered page | Search finds only the row dated 2026-05-03, carrying the unfiltered running balance, start and end. Category names are searched; `%` and `_` are literal; `pending=true` works. |
| Amex | Never on any page; `source=amex`, `source=plaid:amex` and `search=amex` match 0. |
| Bad filters and accounts | Eight cases are 400; the ledger's own account is 200. |
| Balances equal the spine | `/spine` `bank.balance` 5,081.00 equals today's balance. 03-31 is 4,331.00; 05-03 matches the walk; 05-15 is 5,101.00 (the register). |
| Dates | 120 dates are fine. 121, empty, a trailing comma, 02-30, words and a missing parameter are 400. |
| Reviewing 20 rows | Through `/transactions/bulk-update`: `matchingCount` 240, review counts 20/240. Totals, start, end and every running balance are unchanged. |
| Bulk review by filter | 239 is 409 and writes nothing. A misspelt key or 240.5 is 400. 240 updates 240 rows, and the Amex rows are untouched. Repeating it matches 260 and updates 0. |
| More than 1,000 | 1,001 rows is 400, and none are reviewed. |
| Scope edges | The twin, the manual row and the empty-id row are on the ledger. `amex`, `PLAID:amex` and a same-mask credit card are not. The spine reads 930.00, counting the PR4c pair once, and equals the anchor and the newest running balance. Start is 1,045.00. The twin account is 200; the card is 400. |
| No snapshot | Rows and totals come back; every balance is null; `via` is unresolved. |

**On `main` all 14 fail**: the router, the library and the generated schemas do not exist, so the file cannot import.

**Mutations** (only this file run, each reverted):
- **Untimed rows last in the running-sum window** (the page puts them last in newest-first order, so the window
  must put them first). **1 of 14 fails**: the running-balance sequence. The +100.00 among the untimed 05-10 rows is
  what catches it; with identical amounts the order would not show.
- **A timed cursor no longer reaches its day's untimed rows.** **1 of 14 fails**: the three-at-a-time walk over
  05-10. The 100/100/60 walk does not catch it, because both its cursors are untimed.

## Verification

- **Full API suite** (local test database, rebased on `2874a7b`): **122 files, 943 pass, 8 todo**.
  - That is `main`'s 121 files and 929 (PR4c's note), plus this file's 14.
  - Before the rebase, on `b93c01e`: 121 files, 915 pass (901 + 14).
- **Web suite:** 118 files, 917 pass, before and after the rebase.
- **Typecheck:** clean. **Build:** exit 0.
- **Codegen:** re-run after the rebase; the working tree stayed clean.
- **Landing bundle:** **572,459 bytes (572.5 KB) of 580 KB**, against 572,458 on `main` before (`b93c01e`).
  - The +1 byte is the entry chunk's content hash.
  - The new generated hooks are not on the landing path, so they are tree-shaken.
  - The figure is the same after the rebase onto `2874a7b`.

## Left for PR14

- **Move the Chase page onto these endpoints:** paged rows and totals, running balances, `balances` for the trend
  chart, and bulk review for marking everything reviewed. Retire the 1,000-row pull.
- **Decide on manual rows** (show or hide), and how to mark a pending row PR4c replaced.
- **A ledger for the other checking accounts**, which anchor on per-account snapshots.
- **After PR14:** point `GET /transactions` at the shared annotation block.
- **PR4e still owns** moving the surfaces that stay on `accountBalance.ts` onto the server rule.
