# PR4d — A Plaid re-mint only adopts a row whose old id is gone

Codex work-order point **1** (cash today), plan PR4 ("tighten the re-mint check so two real same-amount charges both
survive"). This PR goes **before PR4c**, as PR4b's second-look reviewer asked. PR4b is live (`cdc5ecc`). Plan:
`~/.claude/plans/h2-budget-work-serene-pebble.md`.

## The problem

**The sync's re-mint check (#720) could merge two real charges.**
- Plaid sometimes re-issues a transaction's id for the same posting (after cursor resets and forced re-links). To
  avoid a duplicate, the sync adopts an existing row when one matches on the same account, the same amount and a
  date within ±2 days, with a different Plaid id.
- **Two real charges match that too:** parking, coffee, a $100 ATM withdrawal.
- The check moved the first charge's row onto the second charge's id and date. One real charge vanished from the
  ledger, from spending and from cash.
- **Since PR4b it can also overstate cash.** The moved row keeps its old `created_at`, so the snapshot rule holds it as
  "already in the balance". The PR4b reviewer reproduced this: a balance of 1,000.00 read after the first −$25
  showed **1000.00** instead of **975.00**.

Same-account, same-amount collisions within two days are ordinary, so this was not a rare case.

## What changed

**One helper, `lib/remintMatch.ts` `pickRemintCandidate`.** The ±2-day query now returns every candidate, not the
first. A candidate is adopted only when its path supplies evidence that the old id **no longer exists at Plaid**.
Among qualifying candidates the nearest date wins, then the row id (a stable pick). If none qualifies, the incoming
row is a separate transaction and is inserted.

**The evidence, by path** (`lib/plaidSync.ts`):

| Path | A candidate's old id is gone when |
|---|---|
| Cursor sync (`syncPlaidItem`) | Plaid **removed** it in this sync, **or** the sync started from a null cursor (Plaid replays the whole history in `added`) and did not send it — **and** no posted row in the batch names it as its `pending_transaction_id` |
| Gap backfill (`runGapBackfillForItem`) | the list is complete (the walk did not stop at the 20-page cap), the row's date is inside `[startStr, today]`, its id is not in the list, no posted row in the list names it as its pending row, **and** the user has not moved its date |

**In both paths, nothing moves another row onto an incoming id a row already holds.** That is an update of that row.
The guard covers the re-mint, the pending→posted re-key, the first-sync merge and the backfill's manual merge; each of
them would collide on the unique index (`23505`).

**A gone row goes to the incoming row nearest its date, not the first in the list.** A candidate is not adopted while a
later, unprocessed row in the same batch is strictly nearer its date. That row must be on the same account with the
same amount, not on file when the batch started, and not naming a pending row. Equal distances keep list order.

- **Why the backfill needs the window test.** Heal, reconcile and `routes/plaid.ts:820` backfills start the day after
  the newest stored row (`overlapDays` 0), so older rows are outside the list and their absence proves nothing. The
  stale-cursor fallback uses `overlapDays: 1`, which keeps #720's existing re-mint case inside the window.
- **Why an incremental cursor sync needs `removed`.** `/transactions/sync` returns only changes. A distinct older
  charge is never in the delta, so absence there proves nothing.

**Two related write-path fixes, from PR4b's residuals:**
- **A re-mint honours a manual date edit** (`occurredOnUserOverridden`), with the same `CASE` the upsert and the
  pending→posted re-key already use. Both re-mint updates used to overwrite the date.
- **The time first seen is kept.**
  - The cursor re-key of a pending row onto its posted row, and the cursor upsert of an id already on file, write
    `occurred_at = COALESCE(existing, incoming)`.
  - The backfill re-key no longer writes `occurred_at`; the backfill has no time and wrote null.
  - Why: PR4b's snapshot rule reads `occurred_at` as when a charge happened. A posting time after the balance read
    replacing an authorisation time before it made a held charge count ("pending delivered late").

## Figures that should move

- **Ledger, spending and cash:** a second real charge with the same amount within two days of another now stays as its
  own row. Cash goes down by it and spending goes up by it, where before one of the two vanished.
- **Cash today:** the PR4b overstatement is gone in the cases reviewed: a separate charge dated ahead (1000.00 →
  **975.00**), and a pending charge that posts in the same batch as a separate same-amount charge, in either order
  (1000.00 → **975.00**).
- **Sync reliability:** an incoming id already on file no longer throws `23505` in the re-mint, the pending→posted
  re-key, the first-sync merge or the backfill's manual merge.
  - Cursor: the sync failed ("Couldn't reach Plaid") and the cursor never advanced, so the item was stuck.
  - Backfill: the rest of the account and its vanished-pending sweep were skipped. That was partly older behaviour,
    and partly a new risk from this PR's first commit.
- **`occurred_at`** on a posted row now keeps the authorisation time when the pending row had one. The Chase ledger
  orders rows within a day by it, so a few rows can reorder within their day. No amount changes.
- **Not recovered automatically:** charges merged before this PR stay merged. A cursor sync never re-sends them. A
  backfill whose window covers their date does restore them, because the surviving row now carries the other
  charge's id, which is in the list.

## Residuals

- **A genuine re-mint without evidence inserts a duplicate.** Two cases:
  - an incremental cursor sync where Plaid re-issues an id without a `removed` event;
  - a backfill where the old row is dated before the window.

  Cash is then **understated** by the charge, the safe direction, until the dedupe pass collapses the pair. The pass
  only collapses rows with the same date, amount and fuzzy description; a re-mint that also moved the date stays
  doubled, **and no path cleans it up.** Once both ids are on file, the old row is never adopted or removed. Cash stays
  understated by that charge until the user deletes the row.
  - **When the pass runs:**
    - after each cursor sync's upsert, only for accounts that sync touched (`plaidSync.ts` ~1779). This is *before*
      that sync's own backfills, so a duplicate a backfill inserts is not collapsed in the same sync;
    - on the first Forecast load per user per server process (`routes/forecast.ts:290`), so after every deploy or
      restart;
    - from the Settings cleanup button (`POST /forecast/dedupe-transactions`) and the admin endpoint.
  - **So a backfill duplicate lasts** until the next cursor sync touching that account, the next restart's first
    Forecast load, or the button.
- **The dedupe pass itself merges two real same-day charges at the same merchant for the same amount**
  (`lib/dedupeTransactions.ts`, key: account, date, amount, fuzzy description). This is older behaviour and is not
  changed here. Two identical coffees on one day still show as one.
- **The first time is kept.** If the first real time Plaid sent was itself wrong, a later correction is ignored.
  - A whole-hour value on file counts as a placeholder and may be replaced (`keepFirstRealTime`). `pickRealTime`
    itself only drops 00:00:00 UTC, so whole-hour values are stored.
  - The snapshot rule already ignores them; the hourly behaviour clock and `debtPending` read them.
- **Null-cursor evidence during a historical pull.** Only brand-new items and "reset cursor"
  (`routes/plaid.ts:2254`) start from a null cursor. If Plaid is still building the history, a row within two days of
  the oldest date Plaid sent can read as gone and be adopted.
- **Page cap.** When `/transactions/get` stops at 20 pages (10,000 rows), that account gets no re-mint adoption and no
  vanished-pending sweep for that run, and a warning is logged. This path has no test, because it needs 10,000 rows.
- **Dedupe churn (read in code, not reproduced).** When the dedupe pass collapses a same-date re-mint pair, the
  survivor keeps the dead old id: `mergeStatePatch` only copies the loser's id when the survivor has none. A later
  `modified` for the new id re-inserts it, and the next pass deletes it again.
- **Same-day, same-amount separate charges.** "Both stay" is proven only for different days. On the same day, the
  dedupe pass collapses them right after the cursor upsert (above).
- **Batch tie-break limits** (updated by PR4d-2, `docs/reviews/2026-09-11-pr4d2-remint-tie-break.md`).
  - An exact tie goes to the earlier-dated row. When the tie is truly ambiguous, this errs toward understating cash.
    Two rows on the same date are left to list order; either pick moves cash the same way.
  - A row can defer to a later, nearer row that never adopts. Each of these leaves a duplicate, and cash is
    understated:
    - the later row adopts a different gone row;
    - the backfill's manual merge consumes it first;
    - the first-sync merge or cutoff skip consumes it first;
    - it is a later copy of an id handled earlier. PR4d-2 counts only the first copy as a claimant.

## Review

**First review, `6e33497`: REQUEST CHANGES.** Every finding was reproduced by the reviewer.

| Finding | Done |
|---|---|
| HIGH: a pending id that just posted reads as gone, so a separate same-amount charge in the same batch takes its row before the posted row re-keys it (cash 1000.00 vs 975.00; certain on the backfill's newest-first list) | `successorIds` from the batch's `pending_transaction_id` are never gone, on both paths. Three tests. |
| MEDIUM: a re-mint onto an id already on file throws `23505`. Backfill: the rest of the account and its sweep are skipped. Cursor: the sync fails and the cursor is stuck | No re-mint when a row already holds the incoming id. Cursor and backfill tests. |
| LOW: backfill "gone" by a stored date the user moved | Rows with `occurredOnUserOverridden` are never gone on the backfill path. Test. |
| LOW: the 20-page cap is silent | Gone-evidence and the sweep are off when the walk stops at the cap; a warning is logged. Untested (needs 10,000 rows). |
| LOW: null-cursor edge during a historical pull | Disclosed in Residuals. |
| LOW: the note was wrong about placeholders; `COALESCE` kept a whole-hour placeholder | `keepFirstRealTime` treats a whole-hour value on file as a placeholder. Note corrected. Test. |
| NIT: missing tests; dedupe churn; import order | Tests added; churn and same-day collapse disclosed; import moved below the local imports. |

**Second look, `16b7720`: REQUEST CHANGES.** The round-1 fixes were verified. Two older bugs remain in the rewritten
code; both were reproduced.

| Finding | Done |
|---|---|
| MEDIUM: a genuine re-mint plus a separate same-amount charge in one batch — the first in list order takes the gone row (cash 1000.00 vs 975.00; certain on the backfill, also cursor and null cursor) | The batch tie-break above (`laterRowIsNearer`). Three tests, one per path. |
| MEDIUM-LOW: the pending→posted re-key had no same-id guard (`23505`: the backfill abandons the account; the cursor stays stuck) | One same-id lookup per incoming row guards the re-key, the re-mint, the first-sync merge and the backfill's manual merge. Cursor and backfill tests; the first-sync merge guard is untested. |
| Side effect: OLD and NEW both on file with different dates stay doubled, and no path cleans them up | Disclosed in Residuals; no automatic delete. |

## Must not change

- PR4b's snapshot rule and the forecast ledger (no change to `snapshotInclusion.ts` or `forecastLedger.ts`).
- The pending→posted adoption by `pending_transaction_id`, which still runs first and needs no evidence.
- #720's re-mint case: a stale-cursor backfill that finds the old id missing still adopts in place, with no
  duplicate.
- The web app and the landing bundle.

## Tests

- **`lib/remintMatch.test.ts`** (8). `laterRowIsNearer`: a later, nearer row wins; never an earlier row, an equal
  distance or itself; rows that cannot claim are ignored. `pickRemintCandidate` (5): no adoption while the old id exists; adoption when it is gone; a live candidate
  skipped for a gone one; nearest date, then id; the evidence check receives the whole candidate, and rows with no
  Plaid id are never offered.
- **`__tests__/plaidSyncRemintDistinctCharges.integration.test.ts`** (22):
  - cursor, incremental: two real −$25 charges a day apart both stay;
  - cursor, genuine re-mint (old id in `removed`): adopted in place;
  - cursor, null cursor: a replayed id is kept; an id not replayed is adopted;
  - a re-mint keeps a manual date edit;
  - a posted row re-keyed onto its pending row keeps the authorisation time, with amount −$27.50;
  - an update to the same id keeps a time on file, and fills a missing one;
  - backfill, overlap 1: both ids listed → both stay;
  - backfill, overlap 1: the old id missing inside the window → adopted;
  - backfill, overlap 0: a row before the window is never adopted;
  - the PR4b reviewer's case through the ledger: `bankToday` **975.00**;
  - a whole-hour time on file is replaced by a later real time;
  - a pending id with a posted successor in the same batch, three ways (cursor with the separate charge first, cursor
    with the posted row first, and the backfill's newest-first list): the pending row is re-keyed by its posted row,
    the separate charge is new, and `bankToday` is **975.00**;
  - cursor: an id already on file next to a removed same-amount pending — no failure, the cursor advances;
  - backfill: an id already on file — the account's later rows still land;
  - backfill: a row whose date the user moved is never treated as gone;
  - a genuine re-mint plus a separate same-amount charge listed first, on the backfill, the cursor (`removed`) and a
    null-cursor replay: the re-mint takes the old row, the separate charge is new, and `bankToday` is **975.00**;
  - pending P and posted S (naming P) both on file: the backfill's later rows still land; the cursor advances.
- **Failing before.**
  - Against `main` (`cdc5ecc`), **8 of the first 10 integration tests fail**. The two that pass are the guards that must
    keep adopting: a genuine re-mint with the old id in `removed`, and a backfill whose full window no longer lists
    the old id.
  - Against the second commit (`16b7720`): **all 5 tests added for the second look fail.**
  - Against this PR's first commit (`6e33497`): **6 of the 7 tests added for the review fail.** The one that passes is the cursor case with the posted row
    first: the posted row re-keys the pending row before the separate charge is handled, so that commit was already
    right in that order. It is kept to pin both orders.

## Verification

- **Plaid sync tests plus the helper's unit file** (16 files): **101 pass**.
- **Full API suite:** **120 files, 897 pass, 8 todo** (889 at `16b7720`, plus 3 unit and 5 integration tests).
- **Typecheck and build:** API typecheck clean; workspace build exit 0.
- **Landing bundle guard:** 572.5 KB of 580, unchanged.
- **Web suite:** not run; no web or shared-library change.

## Left for later

- **PR4c** — a pending row superseded by its posted row leaves cash.
- **PR4d, still open** — backfill order around the balance read.
- **PR4e** — the web `accountBalance.ts`, the explain route and the sync reconciliation onto `isInSnapshot`.
- **Recovering already-merged charges** — needs a read-only production query Brad approves to find them, then a
  backfill over their dates.
