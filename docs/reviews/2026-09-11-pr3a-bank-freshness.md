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
- **Truthful attempt rows** (after review; see "Where the rows come from"):
  - `lib/plaidSync.ts` writes the `balance` attempt row under the same condition as the balance call.
  - `POST /forecast/refresh-bank` and `POST /forecast/bank-snapshot` record their balance re-reads.

## The rule

| Reason | When |
|---|---|
| `refresh_failed` | The newest `transactions` or `balance` attempt for the item behind the snapshot account failed, or the item's error code means the feed is gone. Immediate, for either source. |
| `old` | A Plaid balance whose feed has gone quiet: no balance re-read and no successful sync for 48 hours. |
| `manual_old` | A typed-in balance older than 7 days. |

- **Precedence:** failure outranks age.
- **No snapshot is not stale.** It stays `status: no_data`, as before.
- **Recovery is per kind.** A newer success of the same kind recovers a failure. A balance re-read does not
  recover a failed transactions sync, because rows still are not arriving.
- **`PRODUCT_NOT_READY` is not a failure.** A new link answers it while Plaid prepares. The sync logs it as
  `success=false` for the Recent activity panel, and those rows are skipped here.
- **`BANK_FEED_DEAD_CODES`:**
  - `ITEM_LOGIN_REQUIRED` and `INVALID_ACCESS_TOKEN`, from the existing reauth list.
  - `USER_PERMISSION_REVOKED` and `USER_ACCOUNT_REVOKED`, which arrive by webhook.
  - Not `PENDING_EXPIRATION` or `PENDING_DISCONNECT`, although the reauth list has them. They ask for a
    reconnect before a date, and the feed keeps working until then.
- **Why `old` reads the feed, not only the anchor.**
  - Nothing re-reads the balance in the background any more: the Plaid crons are gone, and only the owner's
    Sync and the two Refresh routes call `/accounts/balance/get`.
  - Free webhook syncs still land rows on top of the anchor. A balance re-read three days ago plus rows an hour
    ago is a current roll-forward.
  - Judging the anchor alone would have marked every healthy feed `old` 48 hours after the last manual Sync.
- **A live feed does not refresh a typed-in number.** `manual_old` goes by the snapshot's own age.
- **`lastContactAt`** is the item's `last_synced_at`, stamped by the last successful transactions sync.
- **`lastFailureAt`** is when the newest unrecovered attempt failed. It is null when failure is known only from
  an error code with no attempt row.
- **Which account:** `resolveSnapshotAccount`, the same resolution the roll-forward uses.

## Where the rows come from

What the rule reads, after the review's fixes:

| Writer | Row |
|---|---|
| `syncPlaidItem` (any origin) | `transactions` success, or failure (`PRODUCT_NOT_READY` failures are skipped) |
| `syncPlaidItem`, manual Sync on an anchored snapshot whose account resolves (by pointer or recovery) to this item | `balance` success or failure — **only when the balance call ran** |
| `POST /forecast/refresh-bank`, for the bank snapshot account | `balance` success, `no_balance`, or failure with Plaid's code |
| `POST /forecast/bank-snapshot` from a Plaid account | `balance` success, `no_balance`, or failure with Plaid's code |

**Dead-feed codes with no attempt row** come from several places:
- ITEM webhooks
- `markItemMalformedToken` (the forecast balance routes, link-token/update, the malformed-token sweep)
- the liabilities refresh

For those, `staleReason` is `refresh_failed` and `lastFailureAt` is null.

## Figures that should move

**No money figure moves, and nothing on screen reads these fields yet** (PR3b is first). Two visible changes:
- **Settings → Recent activity:**
  - Webhook syncs no longer log a "balance" row, since they never re-read the balance.
  - A Refresh from the Forecast or Chase page now logs one.
- **The API payloads grow:**
  - `/spine` `bank`: five more fields.
  - `/forecast/bank-balance-explain`: `freshness`.

## Must not change

- **Every number the spine carries**, to the cent. Spine parity still passes.
- **The landing law.** The payload scan skips `bank`, so the bank object's shape is now locked to its seven
  fields.
- **No Plaid call on the spine path.** Every read is one of our own tables.
- **When Plaid is called.**
  - The Sync's balance-call condition is the same expression as before, now named `balanceRefreshAttempted`.
  - The routes' calls are untouched; only the attempt rows moved.
- **No DDL.**

## Tests

- **`bankFreshness.integration.test.ts`:** 17 cases, each with a pinned `now` and its own household. The
  fixtures follow `plaidSync`'s real write order.
  - **Age:**
    - A balance re-read 3 days ago with a sync an hour ago stays fresh.
    - A feed quiet for 49 hours is `old`.
    - A fresh re-read counts even after a 60-hour-old sync.
    - A never-synced Plaid balance is fresh at 47 hours and `old` at 49.
    - A typed-in balance is fresh at 6 days and `manual_old` at 8.
    - A live feed does not refresh a typed-in balance.
  - **Failure:**
    - A failed balance re-read is `refresh_failed` at 1 hour old.
    - Failure outranks age.
    - A webhook sync after a failed re-read does not hide it.
    - A newer success of the same kind recovers.
    - A later balance success does not recover a failed transactions sync.
    - A failed transactions sync is `refresh_failed`.
    - `PRODUCT_NOT_READY`, on a new link or a healthy feed, is not a failure.
    - A liabilities failure is not stale.
    - `ITEM_LOGIN_REQUIRED` is stale, but `PENDING_EXPIRATION` is not.
    - A typed-in balance on a revoked feed is stale.
  - **Constants:** the dead-feed codes and the 48-hour and 7-day limits.
- **New `plaidSyncBalanceAttempt.integration.test.ts`** (4):
  - A webhook sync makes no balance call and writes no balance row.
  - A manual Sync with the pointer gone but the account found by mask calls Plaid and records it.
  - A failed re-read records Plaid's code.
  - An item that does not own the snapshot account records nothing.
- **New `bankBalanceRouteAttempts.integration.test.ts`** (8):
  - `refresh-bank` records success, an outage, a reconnect error and `no_balance`, and records nothing for a
    non-snapshot account.
  - `bank-snapshot` records success, a failure and `no_balance`.
- **`spineParity.integration.test.ts`:** the spine's five fields equal the explain endpoint's `freshness`, and
  the bank object's keys are locked.
- **`bankBalanceExplain.integration.test.ts`:** a real response parses against the generated
  `GetForecastBankBalanceExplainResponse`, and a Plaid snapshot from Aug 20 that never synced since is `old`.

## Verification

- **Workspace typecheck:** passes.
- **Codegen:** the new schema types, the `Spine.bank` fields, and after review only description wording.
  - The old untyped `GetForecastBankBalanceExplain200` is replaced by `BankBalanceExplain`, and nothing used it.
  - Its two tracked `dist` files would have stayed behind as orphans, since a build never deletes output for a
    removed source. They are removed. No other generated file is orphaned.
  - `lib/api-zod/dist/generated/api.d.ts` also carries reorder-only hunks in unrelated responses. That is
    compiler noise.
- **Affected API tests:** 4 attempt files, 22 pass. `bankFreshness` and spine parity: 29 pass.
- **Full API suite:** **115 files, 826 pass plus 8 pending**, on an isolated database with the Mac held awake.
  That is two files and 19 tests more than `fab2a9d`: seven more freshness cases, four sync attempt cases and
  eight route attempt cases.
- **Full web suite (clock in UTC):** 109 files, 802 pass. No web code changed.
- **Build:** passes. **Landing bundle guard:** 571.3 KB of 580, unchanged.

## Cost

- **Account resolution.** Each spine request now resolves the snapshot account three times instead of two:
  cash signal, review count and freshness.
- **Extra reads.** Up to five small ones: settings, the account, the item, and the newest attempt of each kind
  (on the `(plaid_item_id, attempted_at)` index).
- **Logging.** `resolveSnapshotAccount` logs when the stored pointer does not resolve, so affected households
  get that line once more per request.
- **One more insert per Refresh tap,** in the two balance routes.

## Deviations from the plan

- **PR3 is split.** 3a is the server (this PR) and 3b the web, as PR2 was.
- **No separate `snapshotAt` on the spine.** `bank.asOfDate` already is the snapshot time.
- **A dead feed also marks a typed-in balance stale.** Its roll-forward rows stop arriving.
- **`old` reads the feed, not the anchor's age.** The plan said "more than 48 hours". Decided after review,
  for the reason given under "The rule".

## Independent review, and what was done

A separate reviewer read `fab2a9d`, and the verdict was **changes needed**. It confirmed these areas were clean:
- **No stuck state.** Every dead-feed code is cleared by a successful sync, a relink, LOGIN_REPAIRED, a cursor
  reset or a liabilities success.
- **Attempt ordering and pruning** are sound.
- **The spine path** makes no Plaid call.
- **The spec** matches the route exactly.
- **No web code or test** type-checks against the new fields yet.
- **The clock-dependent assertions** are safe.

1. **MEDIUM — fixed. A `balance` row did not mean a balance call was made.**
   - `plaidSync` wrote the row under its own condition. A webhook sync logged "balance: success" over a real
     failure, and a manual Sync whose account resolved by mask called Plaid but logged nothing.
   - The row now uses the call's condition, `balanceRefreshAttempted`.
2. **MEDIUM — fixed. The two balance routes wrote no attempt rows.** A successful Refresh after a failed Sync
   stayed `refresh_failed`, and a failed Refresh was never recorded. Both routes now record the bank snapshot
   account's re-read.
3. **MEDIUM — fixed. `PRODUCT_NOT_READY` counted as a failure,** so a new link read `refresh_failed`. Those rows
   are skipped.
4. **LOW (design) — decided. `old` fired on healthy feeds** 48 hours after the last manual Sync. It now reads
   the feed's last contact.
5. **LOW — fixed. The tests did not catch several wrong implementations:**
   - an age-first rule
   - a newest-attempt-across-kinds rule
   - an age rule based only on the last sync
   - idealised write orders
   
   Each now has a case that fails under it.
6. **NIT — fixed.**
   - This note no longer says `lastFailureAt` is null only for webhook codes.
   - It no longer claims the landing scan covers `bank`; the new shape lock does.
   - It names the reorder-only compiler hunks.

## Left for PR3b

- **Data states:** `dataState()`, `useSpine` state/error/refetch, and `useReviewInboxCount` returning
  `number | null`.
- **Freshness on screen:** a freshness line and refresh banner that read these fields, replacing
  `BankSnapshotFreshness`.
- **The $0 sweep,** and the "Why this number?" popover built on the typed explain response.
