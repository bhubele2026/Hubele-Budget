# WP9b: reads that wrote, snapshots moved by last four, a schedule's 0

Branch `fin/wp9b-reads-and-nulls`, from `origin/fin/integration` (e5501abb, which has WP9 and WP10).

Three batch-2 review findings.

- **Implemented:** all three, on the branch.
- **Tested:** integration tests. The six cases that pin a change fail on integration's code (checked by swapping its four source files back in) and pass here. Full gates below.
- **Deployed:** no.
- **Enabled:** nothing. No AI, SMS, sync or automation setting changed.

## 1. GET /forecast ran the transaction dedupe (a read that wrote)
- **Was:** the first GET /forecast per user per process ran `dedupeTransactionsForUser` and `dedupeTransactionsAcrossAccountsForUser` (`FORECAST_DEDUPE_DONE` gate, #475-followup). So the first page read after a boot could delete rows.
- **Now:** gone, with its gate and the unused import. GET /forecast changes no transaction rows.
- **Where the passes still run:**
  - a bank sync (`syncPlaidItem`): the per-account pass over every account the sync touched, then the cross-account pass;
  - Settings' "Clean up duplicate transactions" (`POST /forecast/dedupe-transactions`): the per-account pass over every account.
- **Note:** a duplicate already sitting on an account no sync touches now waits for the Settings button or a sync that touches it. Before, a boot plus a page read collapsed it.

## 2. A sync could move a snapshot by last four, unlogged
- **Was:** the trailing #429 backfill in `dedupePlaidAccountsForUser` ran on every sync. It moved ("salvaged") a removed account's balance snapshot onto a live account with the same last four, trying name first, then institution, then the first mask match. Example: a removed Chase ··5526 reading could land on Capital One 360 ··5526. Nothing logged it.
  - It also judged "live" by the syncing user's accounts only. A household member's card, whose reading sits in the owner's map, looked like an orphan.
- **Rule now:** a snapshot moves ONLY inside `mergeLoserIntoSurvivor`, when its account is merged into that twin. That is the merge the sync logs as `account_merge`.
  - The salvage is deleted.
  - The trailing pass only drops keys whose `plaid_accounts` row no longer exists at all. Liveness is checked by id across every user, so a member's account keeps its reading. Nothing reads a dead key: the server's `accountSnapshotOf`, goals and the web's `deriveEffectiveSnapshot` all look readings up by live account ids.
- **Logged with the merge:**
  - `accountSnapshotsRepointed` counts a move only when the merged account's reading is what the survivor now shows (its own newer reading wins otherwise, and nothing moved);
  - `accountMergeSummary` names it: "Merged 1 duplicate account; 1 transaction and 1 balance snapshot moved to the account that stays." When the bank balance's own account was the one merged away, the line says "the bank balance";
  - dropped dead keys with no merge get a server log line ("none moved"), not a sync-log row.
- **Same rule on the other callers** (POST /plaid/exchange, Settings' account clean-up), since they share the function.

## 3. The avalanche schedule said bankBalance 0 with no snapshot
- **Was:** `Number(signal.bankToday) || 0`, so 0 after WP10 made `bankToday` null.
- **Now:** null when `bankToday` is null; otherwise the same number as the spine (rounded to cents).
- **Spec:** `AvalancheSchedule.bankBalance` is `["number", "null"]` with a description. Codegen; a second run leaves git clean.
- **Web:** the schedule card does not read `bankBalance`. Nothing changes on screen.

## Figures that move
- **API, no snapshot:** `/forecast/avalanche-schedule` `bankBalance` 0 → null.
- **On screen:** nothing.
- **Sync log:** a merge that moves a reading now says so.
- **Data:** a sync no longer copies a removed account's reading onto another account.

## Tests
- **`plaidAccountTwinsOnSync.integration`** (WP9's read-only test), extended:
  - new first case, "GET /forecast changes no transaction rows". It seeds the per-account shape (one posting twice on Capital One 360) and the cross-account shape (a twin left on a removed account). Two GETs leave every column of every row unchanged. The old code deleted one of each.
  - the sync case: the twin's reading moves onto the account that stays and the `account_merge` line names it. The removed account's reading (same name and last four, newest of all) is dropped, not moved. The sync's cross-account pass collapses the twin the reads left alone.
  - the second sync: a removed account's reading that matches both live ··5526 accounts by last four only. No merge, no log row, nothing moved. Capital One 360 still has no snapshot on GET /plaid/items.
- **`dedupePlaidAccounts.integration`:**
  - the #429 case is renamed to the new rule (same assertions);
  - new case: an orphan Chase ··5526 reading stays off Capital One ··5526, and a household member's card keeps its reading.
- **`bankNullWithoutSnapshot.integration`** (WP10): the schedule's `bankBalance` is a fifth reader, parsed with the generated response schema. It is null in both no-snapshot households and 4812.37 with a snapshot.
- **Gates:**
  - root typecheck passes;
  - API: 252 files (1 skipped), 2732 passed, 1 skipped, 7 todo;
  - web (a generated type changed): 216 files; UTC 2062 passed + 3 skipped, Chicago 2063 passed + 2 skipped;
  - build passes; landing JS 620.3 KB (cap 622); entry graph OK;
  - `pnpm audit --prod`: 1 high, the known ignored `braces` advisory;
  - codegen re-run leaves git clean.

## Not verified
- The harness was not run: this package moves no figure on any page it reconciles, since the fixture heals transactions at boot and never syncs.
- Live data.
