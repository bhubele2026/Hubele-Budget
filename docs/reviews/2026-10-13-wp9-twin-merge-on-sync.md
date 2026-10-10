# WP9: twin accounts are merged only when a bank sync runs

Branch `fin/wp9-twin-merge-on-sync`, from `origin/fin/integration`. WP5d is merged in, and integration 18dfe9c6 after it.

The owner's decision (2026-10-10): duplicate Plaid accounts (same institution and last four) are merged **only when a bank sync runs, never on a page read**.

- **Implemented:** everything below, on the branch.
- **Tested:** unit and integration tests, and the harness on `dupmask`.
- **Deployed:** no.
- **Enabled:** nothing is behind a flag. No AI, SMS or automation setting changed. No bank sync was made: Plaid is mocked everywhere.

## Root cause (base tree)
Three read paths wrote account rows, merging twins through `dedupePlaidAccountsForUser`:
- **GET `/amex/anchor`** (`routes/amex.ts`, #416): a one-shot heal gated by `preferences.amexCleanupDoneAt`. This is the one the harness caught. The fixture stamps the other gate, so opening the Amex page or a card's account page merged the `dupmask` twin.
- **GET `/forecast`**, and **`listCheckingAccounts`** (also behind `/forecast`): `runAutoDedupeIfNeeded`, once per user, gated by `forecast_settings.auto_dedupe_ran_at` (#411).

So a figure depended on which page was opened first. In `dupmask`, 18 figures moved after the pages opened:
- checking $4,812.37 → $4,752.37;
- low point $2,106.95 → $2,046.95;
- "Checking covers" $1,518.93 → $1,458.93;
- since-snapshot $0.00 → −$60.00.

The cause: the twin's −$60 ATM row joined the snapshot account mid-session.

## What changed
- **Reads are read-only for account rows:**
  - the Amex heal is removed;
  - `runAutoDedupeIfNeeded` is removed from `/forecast` and `listCheckingAccounts`, so the Chase picker still shows one row per institution + mask by collapsing in its response, with no write;
  - `runAutoDedupeIfNeeded` and `markAutoDedupeRan` are deleted; their gate is no longer read;
  - `auto_dedupe_ran_at` and `amexCleanupDoneAt` stay in storage, unread (additive-only).
- **The sync merges:** `syncPlaidItem` runs `dedupePlaidAccountsForUser(item.userId)` right before the cross-account transaction dedupe.
  - The item's own user is used because its accounts are that user's, so a member's Sync click still merges the owner's twins.
  - Both sync triggers reach it: the owner's Sync (POST `/plaid/sync`) and Plaid's webhook (the scheduler → `syncPlaidItemSerialized`).
  - It is non-fatal, and idempotent: a clean household writes nothing.
- **Logged and counted:**
  - `SyncResult.accountsMerged`, plus `PlaidSyncResult.items[].accountsMerged` in the spec;
  - a `plaid_sync_attempts` row of new kind `account_merge`, with `success=true` and the summary in `errorMessage` ("Merged 1 duplicate account; 1 transaction moved to the account that stays."), following `pending_cleanup`'s convention;
  - the spec enum gains `account_merge`; codegen.
- **Web:**
  - the Sync toast appends "Merged N duplicate account(s)." to whichever result toast shows;
  - Settings → Recent activity labels the kind "Duplicate accounts merged".
- **Left as they were (write paths, not page reads):**
  - POST `/plaid/exchange` still merges right after a link or re-link, which is where twins are born, and it starts that bank's first sync;
  - POST `/forecast/dedupe-plaid-accounts` remains the explicit maintenance button.
- **Not in this package's scope:** GET `/forecast` still runs its once-per-process transaction dedupe and the snapshot-identity label heal. Neither writes account rows, and the harness runs the transaction heal at boot. Both are worth a later owner decision.

## Figures that move
- **On a page read: none, ever.** That is the point.
- **Harness `dupmask`:**
  - "figures moved by opening the pages": **18 → 0**;
  - boot-time figures: all 57 reconcile rows identical before and after;
  - warnings after the pages opened: 4 → 1 (the drift warnings went).
  - The 2 failing MUSTs (`hook.saturday`, `label.payoffVsPlan`) fail identically before and after; they belong to other packages.
- **On real data:** a twin that a page read used to merge now merges on the next Sync or webhook instead. The figures it moves (a twin's rows joining the account that stays) move then, and the toast and sync log say so.

## Tests
- **New `plaidAccountTwinsOnSync.integration.test.ts`**, on the `dupmask` shape:
  - two passes over 12 GETs (`/forecast`, cash-signal, explain, spine, `/plaid/items`, liability-accounts, `/amex/anchor`, weekly-payoff, transactions, ledger, balances, dashboard) leave `plaid_accounts`, every row's account, the snapshot pointer, the account snapshots and spine `bank.balance` unchanged;
  - a sync merges the twin (Capital One ••5526 untouched), returns `accountsMerged: 1`, writes one `account_merge` row, and moves the balance by −$60;
  - a second sync merges and logs nothing.
- **`amexAnchorOneShotHeal`** now pins the reverse: twins stay through two reads, and no preference is written.
- **`settingsPreferencesServerKeys`:** `amexCleanupDoneAt` is marked retired. It stays server-owned and must never be written again.
- **`use-plaid-sync` +2:** merge sentence summed over items; on an empty sync; absent when 0.
- **Removed:** `autoDedupePlaidAccountsGate`, along with the functions it tested.
- **Mutation checks:** restoring the Amex heal fails all 5 read-only and sync cases; dropping the sync merge fails the sync cases.
- **Gates on the merged tree:**
  - root typecheck passes;
  - API: 248 files, 2712 passed, 1 skipped, 2 todo;
  - web: 214 files; UTC 2046 passed + 3 skipped, Chicago 2047 passed + 2 skipped;
  - build passes; landing JS 620.0 KB (+0.2 KB, the toast sentence; cap 622);
  - `pnpm audit --prod`: 0 high except the known ignored `braces` advisory.

## Not verified
- Real Plaid: mocked in every test and in the harness.
- Whether Brad's household holds twins today. A read-only count would answer it: `plaid_accounts` grouped by institution, mask and name.
