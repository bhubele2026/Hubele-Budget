# PR4d-2 — Re-mint ties go to the earlier-dated row; the first-sync guard gets its test

A small follow-up to PR4d (live, `5662ef2`). PR4d's third look **approved** `3a8125c` with two LOWs and two NITs; this
PR carries them, before PR4c. Plan: `~/.claude/plans/h2-budget-work-serene-pebble.md`. PR4d's note:
`docs/reviews/2026-09-11-pr4d-remint-distinct-charges.md`.

## The problem

**An exact tie in the batch tie-break could still overstate cash** (LOW, reproduced by the reviewer on `3a8125c`
and `16b7720`, so older than PR4d's last commit).
- On the backfill, OLD (−25) is dated the snapshot day and was on file before the read.
- Plaid re-mints it as NEW, dated a day earlier. A separate −25 charge X is dated a day later. Both are one day from
  OLD, and X is listed first (newest first).
- `laterRowIsNearer` kept list order on a tie, so X took OLD's row and kept its pre-read `created_at`. The snapshot
  rule held X, and held NEW by its date.
- **`bankToday` read 1000.00; the true figure is 975.00.** PR4d's note said ties keep list order without saying
  which way cash moves.

## What changed

- **Ties go to the earlier-dated row** (`lib/remintMatch.ts` `laterRowIsNearer`).
  - The snapshot already holds rows dated before its day, so the earlier-dated row is the safer owner of the old row.
  - In the reviewer's case, NEW takes OLD's row and X is inserted after the read, so cash is **975.00**.
  - In the mirror case, the re-mint dated later and the separate charge earlier, the separate charge takes the old row
    and the re-mint is inserted. Without institution times, cash is **understated** by 25.00 when the earlier-dated
    row is on or before the snapshot day. After the snapshot day the two offset to the true figure.
  - ⚠️ **With institution times a tie can still overstate** (case T1 under Review). This is rare; the tie is not
    broken on time evidence yet.
  - Two rows on the same date are left to list order. Without times, either pick moves cash the same way.
- **Only the first copy of an id counts as a claimant** (`RemintBatchEntry.firstCopy`, set by `remintBatchEntries`).
  A later copy, from `added` then `modified` across poll walks, only updates the row the first copy wrote.
- **The batch scan runs last** in both evidence predicates (`plaidSync.ts`). The result is the same with less work: it
  is the only check that grows with the batch, O(n²). The reviewer measured a 3,000-row same-amount import at 8.7 s
  with it first and 7.1 s with it last.
- **PR4d's note** now states the tie direction and lists every way a deferral can leave a duplicate (all
  understated).

## Figures that should move

- **Cash today:** the exact-tie case above, 1000.00 → **975.00**. Other ties now follow the earlier-dated rule instead
  of list order. Without times they understate or come out right. With times, case T1 overstates.
- **Nothing else.** The check order and the first-copy rule change no outcome in the tests. The first-copy rule only
  stops a later copy of an id from blocking an adoption, which left a duplicate (understated).

## Tests

- **`lib/remintMatch.test.ts`** (+1, and one assertion changed):
  - an exact tie goes to the earlier-dated row whatever the list order, and a same-date tie keeps list order;
  - a later copy is not a claimant.
  - **Changed:** "never defers on an equal distance" now reads "never defers on a tie with a later-dated row". The old
    assertion used an earlier-dated later row, which the new rule defers to by design.
- **`__tests__/plaidSyncRemintDistinctCharges.integration.test.ts`** (+3):
  - the reviewer's tie on the backfill: NEW takes OLD's row, X is new, `bankToday` **975.00**;
  - first sync, control: a manual row merges with a Plaid id that is not on file;
  - first sync, guard: a Plaid id already on file is never merged onto a manual row, and the cursor advances.
- **Failing before:** run against `main` (`5662ef2`), **the tie test fails**. The two first-sync tests pass there; that guard already
  shipped in PR4d (the reviewer showed it pins the cursor on `16b7720`), so they stay as regression guards.

## Verification

- **Plaid sync tests plus the helper's unit file** (16 files): **105 pass**.
- **Full API suite:** **120 files, 901 pass, 8 todo** (897 on `main`, plus 1 unit and 3 integration tests).
- **Typecheck and build:** API typecheck clean; workspace build exit 0.
- **Landing bundle guard:** 572.5 KB of 580, unchanged.
- **Web suite:** not run; no web or shared-library change.

## Review

**`ffb4c05`: APPROVE**, with one LOW to fix before merge (done here, wording only) and two NITs. The reviewer built
tie arrangements on the cursor path (snapshot read four days ago, 1,000.00, all rows −25; S = the separate charge,
R = OLD's re-mint):

| Case | Cash | True | |
|---|---|---|---|
| T1: OLD dated snapshot day +2, on file before the read with an authorisation time; S at +1; R at +3 carrying that time | **1000.00** | 975.00 | overstated |
| T2: OLD on the snapshot day; S at −1; R at +1; no times | 975.00 | 1000.00 | understated |
| T3: as T1 with no times | 975.00 | 975.00 | correct |

- **T1:** the re-mint's inherited pre-read authorisation time makes the snapshot rule hold it. Nothing offsets the
  separate charge that won the tie, which also keeps a pre-read `created_at`. It needs a bank that sends times (Chase
  rows mostly don't), a re-keyed row dated 2–4 days after the snapshot day and a same-amount charge a day on the
  other side, all in one cursor batch. The backfill writes no time, so it cannot happen there.
- **Wording corrected:** the docstring, this note and PR4d's limits no longer say "never overstated". The NITs are
  folded into the mirror-case and same-date lines above.
- **Not done: a time-evidence tie-break.** Prefer the incoming row whose real time equals the candidate's `occurred_at`.
  That needs a time on `RemintBatchEntry` and `occurredAt` in the candidate select. Listed below.

## Left for later

- **A time-evidence tie-break for re-mints** (T1 above): on a tie, prefer the incoming row whose real time matches the
  candidate's `occurred_at`.

- **PR4c** — a pending row superseded by its posted row leaves cash (design in the scratchpad: the pair's contribution
  depends on which half the snapshot held, and a false pair can overstate).
- **PR4d, still open** — backfill order around the balance read; an optional untouched-delete for an OLD/NEW pair both
  on file with different dates.
