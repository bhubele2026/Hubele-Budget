# WP1 — one checking balance model (lane 1)

Branch `fin/wp1-checking-model`, from `origin/main` 8b869e79, with `origin/fin/integration` (e94016de, WP7a) merged in. Not merged to main. Not deployed.

- **Implemented:** the spine and cash-signal additions, the spec and codegen, the parity rows, one staleness constant, the pure web model and its hook, and two surfaces (SummaryRow, Reports bank tile).
- **Not in this package:** AccountsPanel, `Accounts.tsx` and `AccountSummary` belong to lane 2, which uses the hook below. The web `bankState.ts` is also lane 2's: see "For the lead to route".
- **Tested:** unit and integration tests, plus fixture before/after for `normal`, `stale` and `empty` on `/home` and `/reports`.
- **Enabled:** nothing. There is no flag, and no AI, SMS, sync or automation setting changed.

## Root cause (verified in the 8b869e79 tree)
- **Two balances for one account, with no label saying which is which.**
  - The dashboard's figure is the snapshot rolled forward: `forecastLedger.ts:562-594` (`bankToday`), served at `spine.ts:148`.
  - The selector and the account detail show the raw snapshot, with no date: `Accounts.tsx:91-100`, `AccountSummary.tsx:50-55`.
  - No single response held both halves (snapshot, what rolled since), the effective balance and the account's id.
- **The account had no id.** The cash signal's `account` was `{name, mask, subtype, via}` (`cashSignal.ts:453-458`). AccountsPanel therefore matched checking by mask (`AccountsPanel.tsx:113-116`), and `"" === ""` matched any account that has no mask.
- **The count came from a second request.** SummaryRow's "Includes N entries since the … snapshot" read `/forecast/bank-balance-explain` (`SummaryRow.tsx:60-65`, `queries.ts:65-68`), and only when the snapshot was from an earlier day.
- **The Reports label came from a different source.** The Reports bank tile named the account from the forecast bundle's remembered snapshot (`reportsShared.tsx:318-342`), which is a second, heavy request (`reports.tsx:90`), not from the account whose rows roll the balance forward.
- **Two staleness thresholds:** 36 h on the web (`bankState.ts:4`) and 48 h on the API (`bankFreshness.ts:50`).

## What changed
### API and spec
- **`ForecastLedger.cashThroughToday`** is `classifyCashRows`' `throughToday`, which the ledger already computed. These are the exact rows summed into `bankToday`; it is `{0, 0}` without a snapshot.
- **`bankBalanceParts(ledger)`** (`lib/cashSignal.ts`) gives `snapshot {balance, at, source}` and `sinceSnapshot {net, count, through}`.
  - Both are formatted like `bankToday` (`r2`). It adds no new figure.
  - `snapshot` is null without a snapshot or without its read time. `sinceSnapshot` is null when nothing rolls.
  - `source` is normalised as freshness does it: anything not from Plaid was typed in.
- **The spine's `bank`** gains `snapshot`, `sinceSnapshot` and `account`. `account` is the cash signal's.
- **`CashSignalAccount`** gains `rowId` and `externalId`: required, and null when unresolved.
- **Spec:** new `SpineBankSnapshot` and `SpineSinceSnapshot`. Codegen is CI-style, and `git status` is clean after a re-run.
- **`@workspace/avalanche-core/freshness`** is a new subpath holding `PLAID_FEED_QUIET_MS` (48 h) and `MANUAL_SNAPSHOT_STALE_MS`. The API's `bankFreshness.ts` imports and re-exports them, so its values are unchanged.

### Web
- **`lib/bankBalance.ts`** (pure):
  - `bankBalanceView(spine.bank)` → `{balance, snapshot (+ household day), since, account}`. `balance` is null with no bank balance at all. A field missing from an older payload reads as null.
  - `isSpineAccount(acct, account, all)` matches by row id or Plaid `account_id`. A mask decides only when there are no ids, the mask is not empty, and exactly one account in `all` carries it.
  - `entriesWord`, `sinceSnapshotWords` ("Includes 2 entries since the Oct 5 snapshot") and `snapshotWords` ("Snapshot $3,458.98 · Oct 2 · +20 entries").
- **`hooks/useBankBalanceView.ts`** wraps `useSpine()` and makes no request of its own. It returns `{ view, state, refetch }`, and `view` keeps its identity while the spine's bank is unchanged.
- **SummaryRow:**
  - The account chip and the since-line come from the spine.
  - `useBankExplainQ` is deleted. The checking cell no longer reads the cash signal.
  - The "Why this number?" popover is unchanged and still asks the diagnostic when it is opened.
- **Reports bank tile:**
  - The label reads the spine's account and the snapshot's source.
  - The hub no longer requests `/api/forecast?days=90`.
  - With no bank balance, the figure is "—", as on the dashboard.
- **`forecastReconcile.ts`:** a comment says why it keeps the raw snapshot. It compares the plan with what the bank said at that moment.

### How lane 2 consumes it
- `const { view } = useBankBalanceView()`.
- "Cash held" / "Balance today" = `view.balance`.
- The chip line = `snapshotWords(view)`.
- `isCash = identity.kind === "checking" && isSpineAccount({ id: acct.id, accountId: acct.accountId, mask: acct.mask }, view?.account, allAccounts)`.
- An `AccountEntry` has `rowId` (internal) and `plaidAccountId` (external): pass `{ id: e.rowId, accountId: e.plaidAccountId }`.

## Figures and words that move (fixture, before → after)
Before was `origin/fin/integration` e94016de; after is this branch. The page text was diffed word by word.

| Scenario · page | Before | After | Why |
|---|---|---|---|
| normal · /home, /reports | — | identical (only the version label differs) | same figures; the label and count now come from the spine |
| stale · /home | "$4,788.37 · Total Checking ••5526 · … · Includes 1 entry since the Oct 6 snapshot" | identical | the since-line now reads `spine.bank.sinceSnapshot` (count 1, net −24.00), which equals the explain route's `sinceAnchor` |
| stale · /reports | "BANK BALANCE $4,788.37 · Plaid · Total Checking ··5526" | identical | the label is the spine's account |
| **empty · /reports** | **"BANK BALANCE $0.00 · No checking snapshot yet"** | **"BANK BALANCE — · No checking snapshot yet"** | with no snapshot, `bankToday` is the starting balance (0). The dashboard already says "no bank balance" in words; Reports now follows the same rule |

- **Spine payload (stale):** `balance` 4,788.37 = `snapshot.balance` 4,812.37 (Oct 6, Plaid) + `sinceSnapshot.net` −24.00 (1 entry, through 2026-10-09). The account is `{rowId, externalId, "Total Checking", "5526", "checking", "pointer"}`, equal to the cash signal's.
- **Label rule change (not hit by the base fixtures; unit-tested):** the since-line now also shows for a same-day snapshot when an entry counted after the read. Before, it showed only when the snapshot day was before today, because the count cost a request. A posted row that adds $0.00 counts as an entry, as on the explain route.
- **Reports label:** it names the resolved account rather than the snapshot's remembered name and mask. These are identical in every fixture. They differ only when the remembered label is stale.
- **Requests:**
  - `/reports` makes one fewer request (the forecast bundle).
  - `/home` with an earlier-day snapshot makes one fewer request (the explain diagnostic).
  - The cash-signal request is unchanged, because other panels read it.

## Bundle
- **Landing JS:** 621,793 → **621,851 bytes** (+58). The cap is 622,000 and is unchanged, so 149 bytes remain.
- **Why it rose despite dropping `useBankExplainQ`:**
  - `BankBalanceWhy` (eager, in the checking cell) still imports the generated explain hook, so dropping the dashboard's wrapper frees only the wrapper.
  - The view and the since-line words outweigh what left.
  - `isSpineAccount` and `snapshotWords` are tree-shaken off the open path until lane 2's eager AccountsPanel uses them. Checked in the build: "since the ${" is in the entry chunk, "Snapshot ${" is in no chunk.
- ⚠️ Lane 2 will need bytes freed first. A candidate: lazy-load `BankBalanceWhy`'s popover body, which alone carries the explain hook and its prose.

## Tests
- **`spineParity.integration.test.ts`:**
  - The bank key lock now has ten keys.
  - New: a bank-scoped banned-key scan (`/owed|debt|credit|limit/i`, any depth).
  - New: `bank.account` == cash-signal `account`, ids included.
  - New: `snapshot` / `sinceSnapshot` == explain `snapshot` / `sinceAnchor`.
  - New: `snapshot + sinceSnapshot == balance` to the cent, which is not vacuous after the 1st.
- **`cashSignal.test.ts`:** `bankBalanceParts` for a rolled snapshot, cent rounding, a same-day zero, "-0.00" never shown, source normalisation, no snapshot, and no read time.
- **`cashSignal.integration.test.ts`:** the account shape now carries its ids.
- **Golden snapshot:** only `rowId` and `externalId` added (26 insertions, 0 deletions).
- **Web:**
  - `lib/bankBalance.test.ts`: the view, the household day, none / zero / unresolved / old payload, the `isSpineAccount` matrix (empty mask, twins, no ids) and the words.
  - `hooks/useBankBalanceView.test.tsx`.
  - `dashboard.test.tsx`: the since-line from the spine (incl. same-day and no snapshot), and the account named without a cash-signal read.
  - `reportsHubKitRestyle.test.tsx`: label from the spine, no forecast request, Manual / unresolved, no balance → "—", loading / failed.

## Gates (head of this branch)
- Root `pnpm run typecheck`: clean.
- Web vitest:
  - UTC: 207 files, 1,893 passed, 3 skipped.
  - America/Chicago: 1,894 passed, 2 skipped.
- API suite on `h2budget_test_fin_1`: 239 files, 2,596 passed, 2 todo.
- `pnpm run build` + `check-entry-graph`: OK at 621.9 KB.
- `pnpm audit --prod`: 1 high, already ignored.
- Merge with `fin/integration`: only generated `.d.ts.map` files conflicted, and they were regenerated from the merged spec. Git's merge of `openapi.yaml` is byte-identical to `merge-openapi.py`'s output.

## For the lead to route
- **Lane 2, `pages/next/dashboard/bankState.ts:4`:** replace `STALE_MS = 36 h` with `PLAID_FEED_QUIET_MS` from `@workspace/avalanche-core/freshness` (48 h).
  - That moves words: a bank last synced 36–48 h ago reads "synced N h ago" / "Up to date" instead of "out of date" in the header, the accounts list and Settings.
  - It belongs in lane 2's before/after table.

## Unverified
- **Brad's real data:**
  - whether the Plaid snapshot account is the one the selector shows (the ids now say);
  - his live count of entries since the Oct 2 snapshot.
- **A long-lived tab** holding a spine payload from before this deploy is handled by `?? null`, so it reads "not known". That is not exercised end to end.
