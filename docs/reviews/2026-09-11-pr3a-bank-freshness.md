# PR3a — The server decides when the bank balance is stale

Codex work-order point **12**: never show missing or stale data as if it were current. This is the server half
of plan PR3. PR3b (web) follows and puts it on screen. Plan: `~/.claude/plans/h2-budget-work-serene-pebble.md`.

## The problem

- **The spine told screens nothing about trust.** Its `bank` object carried only `balance` and `asOfDate`.
- **The Banking screen judged freshness itself**, in `BankSnapshotFreshness` (`command-center.tsx`), from the
  snapshot's timestamp alone.
- **A failed refresh looked like a fresh balance.** Nothing surfaced that the last sync failed until the numbers
  were visibly wrong.
- **The obvious signal is the wrong one.** `plaid_items.last_sync_error` is also written by the liabilities
  refresh ("Liability refresh failed: …"). Reading it would mark the bank stale over a credit-card hiccup.
- **The explain endpoint was untyped** (`additionalProperties: true`), so no screen could use it safely.

## What changed

- **`lib/bankFreshness.ts`:** `computeBankFreshness(householdId, ownerUserId, now)` returns
  `{source, lastContactAt, lastFailureAt, stale, staleReason}`.
- **`lib/plaidReauthCodes.ts`** adds `BANK_FEED_DEAD_CODES`.
- **`GET /spine`:** `bank` gains those five fields.
- **`GET /forecast/bank-balance-explain`** adds `freshness`, the same object from the same function.
- **`lib/api-spec/openapi.yaml`** adds a `BankFreshness` schema, a fully typed `BankBalanceExplain` and the five
  `Spine.bank` fields. The regenerated client is committed.

## The rule

| Reason | When |
|---|---|
| `refresh_failed` | The newest `transactions` or `balance` attempt for the item behind the snapshot account failed, or the item's error code means the feed is gone. Immediate, for either source. |
| `old` | A Plaid snapshot older than 48 hours. |
| `manual_old` | A typed-in balance older than 7 days. |

- **Precedence:** failure outranks age.
- **No snapshot is not stale.** It stays `status: no_data`, as before.
- **`BANK_FEED_DEAD_CODES`:**
  - `ITEM_LOGIN_REQUIRED` and `INVALID_ACCESS_TOKEN`, from the existing reauth list.
  - `USER_PERMISSION_REVOKED` and `USER_ACCOUNT_REVOKED`, which arrive by webhook.
  - Not `PENDING_EXPIRATION` or `PENDING_DISCONNECT`, although the reauth list has them. They ask for a
    reconnect before a date, and the feed keeps working until then.
- **`lastContactAt`** is the item's `last_synced_at`, stamped by the last successful transactions sync.
- **`lastFailureAt`** is when the newest unrecovered attempt failed. It is null for a failure known only from a
  webhook's error code.
- **Which account:** `resolveSnapshotAccount`, the same resolution the roll-forward uses, so "the feed behind
  the balance" is the feed that actually moves it.

## Figures that should move

**None on screen.** PR3b is the first to display these fields. The API payloads grow:
- `/spine` `bank`: five more fields.
- `/forecast/bank-balance-explain`: `freshness`.

## Must not change

- **Every number the spine carries**, to the cent. Spine parity still passes.
- **The landing law:** no debt words in the payload. The scan still passes.
- **No Plaid call on the spine path.** Every read is one of our own tables.
- **No DDL and no writes.**

## Tests

- **New `bankFreshness.integration.test.ts`:** 10 cases, each with a pinned `now` and its own household.
  - No snapshot: not stale.
  - A Plaid snapshot is fresh at 47 hours and `old` at 49.
  - A typed-in balance is fresh at 6 days and `manual_old` at 8. There is no Plaid account, so only the age
    rule applies.
  - A balance re-read that fails a moment after a successful sync: `refresh_failed` on a 1-hour-old snapshot,
    with `lastFailureAt`.
  - A failure followed by a newer success of the same kind: recovered.
  - A failed transactions sync: `refresh_failed`.
  - A liabilities failure plus a "Liability refresh failed" `last_sync_error`: not stale.
  - `ITEM_LOGIN_REQUIRED`: `refresh_failed`. `PENDING_EXPIRATION`: not stale.
  - A typed-in balance on a revoked feed: `refresh_failed`.
  - The dead-feed codes leave out both pending warnings, and the limits are 48 hours and 7 days.
- **`spineParity.integration.test.ts`:** the spine's five fields equal the explain endpoint's `freshness`.
  - It is not vacuous: the fixture is a typed-in balance whose item has never synced, so `source` is manual
    and there is no contact or failure.
- **`bankBalanceExplain.integration.test.ts`:** a real response parses against the generated
  `GetForecastBankBalanceExplainResponse`. A Plaid snapshot from Aug 20 that never synced since is `old`.

## Verification

- **Workspace typecheck:** passes.
- **Codegen:** the new schema types and the `Spine.bank` fields. The old untyped
  `GetForecastBankBalanceExplain200` is replaced by `BankBalanceExplain`, and nothing in the web app used it.
  - Its two compiled `dist` files were tracked, and a build never deletes output for a removed source, so
    they would have stayed behind as orphans. They are removed. No other generated file is orphaned.
- **Web full suite:** 109 files, 802 pass. No web code changed.
- **API tests:**
  - `bankFreshness`: 10 pass. Spine parity: 12 pass. The explain route: 4 pass.
  - Full suite: **113 files, 807 pass plus 8 pending**, on an isolated database with the Mac held awake.
    That is one file and twelve tests more than PR2b: the ten freshness cases, the spine parity check and
    the explain shape.
- **Build:** passes. **Landing bundle guard:** 571.3 KB of 580, unchanged.

## Cost

- **Account resolution.** Each spine request now resolves the snapshot account three times instead of two:
  cash signal, review count and freshness.
- **Extra reads.** Up to five small ones: settings, the account, the item, and the newest attempt of each kind
  (on the `(plaid_item_id, attempted_at)` index).
- **Logging.** `resolveSnapshotAccount` logs when the stored pointer does not resolve, so affected households
  get that line once more per request.

## Deviations from the plan

- **PR3 is split.** 3a is the server (this PR) and 3b the web, as PR2 was.
- **No separate `snapshotAt` on the spine.** `bank.asOfDate` already is the snapshot time. One fact keeps one
  name.
- **A dead feed also marks a typed-in balance stale.** The plan tied `refresh_failed` to Plaid snapshots. But
  today's balance adds Plaid rows on top of any snapshot, and those stop arriving when the feed dies.

## Left for PR3b

- **Data states:** `dataState()`, `useSpine` state/error/refetch, and `useReviewInboxCount` returning
  `number | null`.
- **Freshness on screen:** a freshness line and refresh banner that read these fields, replacing
  `BankSnapshotFreshness`.
- **The $0 sweep,** and the "Why this number?" popover built on the typed explain response.
