# PR-C — Editing a one-time bill keeps its identity (owner decision 9)

Branch `fix/one-time-bill-move`, base `df2adda`, with `origin/main` merged at `6b355065` (PR-A `1a0c1f71` and PR-A2; both clean).

| Round | Commit | Reviewer |
|---|---|---|
| 1 | `d684757f` | |
| 2 | `ef8ebe44` | REQUEST CHANGES |
| 3 | `ffb8e112` | REQUEST CHANGES (third look) |
| 4 | this commit | |

## Owner decision

> Moving the same obligation should preserve its notes, review history, and resolution state. Never rewrite the date of an actual bank payment. Revalidate a match if the edited date makes it questionable. If the user intends a new obligation, create a new occurrence with a new answer. Distinguish "Move this bill" from "Create another bill." Rescheduling must not resurrect a paid bill or silently mark a new bill paid.

## The bug

Resolutions are keyed on `<itemId>|<occurrenceDate>`. A one-time bill's only occurrence is its `anchor_date`. `PATCH /recurring-items/:id` overwrote that date and left every answer on the old date. `resolutionRemap` never maps one-time bills, so a paid bill came back unpaid (and, once past, overdue), and a skipped bill came back on the curve.

## What changed

### Server: `lib/oneTimeBillMove.ts`

The PATCH runs in one transaction, with the item row and all of its resolution rows locked `FOR UPDATE`.

**When it runs.** A one-time bill that stays one-time and whose date, amount or kind changed. The comparison is between the item row before the update and after it.

**Answers follow the bill.** Every answer on the old date moves to the new date:
- matched, partial, skipped, missed, dismissed;
- "Not this" (`not_match`);
- a pending review.

An answer written on the date a Forecast "Move" sent the bill to (pre-PR6) moves too.

**Forecast Moves are replaced.** A Forecast "Move" (`rescheduled`) on the old date is deleted, and so is one left on the new date: the edit now carries the date.

**Pairs are re-checked** against the new due date and the new signed amount (income positive, as `expandItem` does).

- **Date.** The row must sit inside the matcher's candidate window (`rowInMatchWindow`: 10 days before to 14 after) and have the plan's sign.
  - ⭐ **Round 4 exception:** a live match or partial the user accepted **outside** that window before the edit keeps its answer, as long as the edit does not move the date further from the row (|new date − row date| ≤ |old date − row date|).
  - Example: due 8/10, paid 9/19 (40 days late), corrected to 8/12 (38 days) → still matched. Corrected to 8/05 (45 days) → needs review.
  - A confirmed decision is respected for dates the way owner question 4 respects it for amounts.
  - An answer stranded on the new date gets no such allowance; it was not the bill's live answer.
- **Match.**
  - When the amount changed, it stays paid only if its row pays the new amount in full (`rowPaysPlanInFull`, round 3): short by at most max($1, 1%), over by at most max($25, 10%). That is the off-curve band; per decision 13, only tier-1/2 proof pays. This replaced the round-2 max($25, 25%) tolerance.
  - A date-only move keeps a match accepted at a different amount (owner question 4; *reviewer recommends accepting*).
- **Partial.**
  - It still pays part when its row leaves more than $1 of the new amount unpaid.
  - When the amount changed, the new amount must also be within max($25, 25%) of the old amount (round 3).
- **A pair that no longer pays** becomes `needs_review` (a match) or `needs_review_partial` (a partial), keeping `matched_txn_id`. That only happens where Forecast Review can show it: the new date inside the register (first of last month through today + the forecast horizon), and the row a checking row in the forecast. Otherwise the match is cleared and the bill is unresolved on its new date.
- **A pair whose bank row no longer exists** is cleared.
- **A pending review** never turns paid on its own because of an edit.

**One decision per key.** Priority:
1. a live answer that still holds;
2. a stranded pair that still pays;
3. the live pending review;
4. a stranded pending review that Review can show.

The rest are deleted.

**The PATCH reports what happened.** The response carries `moveResult: { carried, needsReview, cleared }` when answers were re-checked or dropped (additive OpenAPI; codegen committed). The Bills toast says it:
- "1 match needs review.";
- "Its match was cleared, so the bill shows unpaid.".

### ⭐ Pending reviews are never lost to time or a pause (round 4)

- **Archiving restores, never deletes.** `archiveExpiredOneTime` runs on every load of Forecast, Bills and the bill list. When it archives a past bill that still holds a review, it restores the user's last answer, keeping the bank row:
  - `needs_review` → `matched`;
  - `needs_review_partial` → `partial`.

  The bill is inactive and past, so the curve cannot change, and its month's actual reads what the user answered.
  - ⚠️ Round 3 deleted the review here. Simply opening Forecast erased a match, and August actual fell from 300.00 to 0.00.
- **A pause keeps the review.** PATCH `active: "false"` alone no longer drops it. While the bill is paused, every reader (ledger, `computeReviewCount`, the `/forecast` bundle) reads the review as the user's last answer through one helper, `readPausedReview`:
  - Review count 0;
  - off the curve with the paused bill;
  - the row held as the answer held it;
  - the register shows it as matched or partial.

  Stored rows are unchanged, so resuming the bill brings the review back as it was.
- **Pending reviews are dropped** (`clearPendingReviews`) only when:
  - the bill stops being one-time;
  - it is deleted;
  - it is edited while paused. An edit already reports this through `moveResult`; the pause toggle reports nothing, so it no longer drops anything.

### Server: readers of the two review statuses

`needs_review` and `needs_review_partial` are text statuses; no DDL.
- **On an active bill:**
  - the ledger treats them as unresolved: the plan is on the curve (or overdue by the usual rules), and the pair holds its row;
  - `reviewCount` counts the row as unreviewed;
  - Bills `actual` counts only `matched`.
- **On a paused bill:** read as the last answer, as described above.
- **`archiveExpiredOneTime`:** a review on the bill's current date keeps it active while Review can show it; otherwise the 60-day rule applies, and archiving restores the answer.
- **`POST /forecast/resolutions`:**
  - "Not this" clears either review status on the identical pair.
  - Matched and partial writes clear them as plan neighbours.
  - A Forecast Move keeps both.

Recurring (non-one-time) edits are not re-checked; `resolutionRemap` still maps them at read time.

### Web

- **Register:** both statuses are unresolved on both sides. The plan carries `probablyPaid.needsReview` ("match" / "partial"), never off the curve; the row stays pending, with the plan as its pair.
- **Strip and plan row:**
  - "Match needs review" has Confirm and Not this.
  - "Partial payment needs review" has Partial as its primary answer, Confirm full secondary, and Not this.
- **Row state and cache:** `rowDecisionsByTxn` and `applyResolutionWrite` mirror the server.
- **Bills editor, one-time items:**
  - Once the date changes, the default save reads "Move this bill".
  - Create another bill appears only once the date, name or amount differs, and always creates an active bill.
  - The Help chip says a far move or a new amount asks for review.
  - The save's toast reports `moveResult`.
- **Pause toggle:** unchanged ("Paused"). It no longer drops anything, so there is nothing more to say.

### ⚠️ Merge coupling with PR-B (`feat/match-evidence-tiers`)

Whichever PR lands second fixes these:
1. **`planMatch.test.ts`:** the pin tests call `matchPlansToRows` through one helper (`pairOne`). PR-B's required `items` is a one-line edit there.
2. **Review `ProbablyPaid` objects:** built in exactly one place in `forecastMatch.ts`, plus one fixture helper in `needsReviewStrip.test.tsx`. PR-B's required `tier` is added in those two spots.
3. **The pins themselves:** `rowInMatchWindow`, `rowWithinMatchAmount` and `rowPaysPlanInFull` are pinned to `matchPlansToRows`'s candidate window, loose tolerance and off-curve band.

## Figures that move

Test fixture: today is Sat 2026-09-19 (unless stated), the snapshot is $2,000, and a $300 one-time "Roof repair" is matched to a −$300 checking row dated 9/19.

### Round 1: `df2adda` → `d684757f`

| Scenario | `df2adda` | Now |
|---|---|---|
| Due 9/20, moved to 9/25 | Back on the curve: 9/25 balance 1,700.00 | Still matched: 2,000.00; Review count 0; Bills September actual 300.00 |
| Due 9/20, moved to 10/20 | Row hidden from Review; Bills counted it paid (300.00) | Needs review: 10/20 balance 1,700.00; Review count 1; Bills 0.00 |
| Skipped bill moved | −300 back on the curve | Still skipped |
| Partial ($200) moved to 9/22 | −300 | −100 remainder |

### Round 2: `d684757f` → `ef8ebe44`

| Finding | `d684757f` | `ef8ebe44` |
|---|---|---|
| H1: 9/28 and $3,000 in one save | Matched; 9/28 balance 2,000.00 | Needs review; −1,000.00 |
| M1: two decisions on one key | Off the curve | One review; −300 on 10/01 |
| M2a/b: moved before the register, or paid by a card row | Unanswerable review | Match cleared |
| M3: partial moved far, then answered | Confirm wrote a full match: 2,000.00 | Partial: 1,900.00 |
| L1: matched row deleted | Match carried | Dropped |

### Round 3: `ef8ebe44` → `ffb8e112`

| Item | `ef8ebe44` | `ffb8e112` |
|---|---|---|
| Bill raised to $376, same date | Matched ($76 silently paid) | Needs review; −376 on 9/20 |
| $200 partial, then a Forecast Move | Partial review deleted | Kept beside the move; −300 on 10/22 |
| $200 partial, bill re-amounted to $10,000 | Partial: −9,800 | Needs review; −10,000 |
| Review on a deleted bill | Orphan dragged another $300 bill to 9/21 (1,700.00) | Cleared; 9/21 balance 2,000.00 |
| A match cleared by a move | No trace | `moveResult.cleared = 1`; toast says so |

### Round 4: `ffb8e112` → this commit

| Item | `ffb8e112` | Now |
|---|---|---|
| 1: due 8/10, paid 9/19, corrected to 8/12 | Needs review; on 10/12 loading Forecast archived the bill and deleted the review; August actual 0.00 | Still matched; archived later with its match, like the no-edit control (August 300.00) |
| 1: same bill corrected to 8/05, further from the row (control) | Needs review | Needs review |
| 2: that 8/05 review, archived on 10/12 | Review deleted; August actual 0.00 | Restored to `matched`; August actual 300.00 |
| 2: edge, on 9/30 a paid bill moved to 8/01, then Forecast loaded on 10/01 | Review deleted; August 0.00 | Restored to `matched`; August 300.00 |
| 2: a partial review archived | Deleted | Restored to `partial` |
| 3: pause a bill whose match needs review (10/20) | Review deleted (`moveResult.cleared = 1`, toast only "Paused"); resume: −300 on 10/20, row back in Review | Review kept; while paused Review count 0, 10/20 balance 2,000.00, bundle reads "matched"; resume: review back, count 1, −300 on 10/20 |
| 3: edit saved on a paused bill (control) | Review dropped; toast reports "cleared" | Same |

## Must not change

- Recurring-bill edits: stored answers keep their dates, and the read-time remap is unchanged (tested).
- Bank transaction rows: never written; date, amount and description asserted unchanged.
- Ledger behaviour for every existing status, and for reviews on active bills. The golden, overdue-evidence and probably-paid suites are green.
- `matchPlansToRows` is not edited.
- Spine parity: the spine calls the same `computeReviewCount`.
- No DDL, no new dependency. The OpenAPI change is additive only.
- Open path stays at 574.4 KB (cap 580).

## Verification (round 4)

- `pnpm run typecheck`: green.
- Web, full suite:
  - `TZ=UTC`: 138 files, 1137 passed / 3 skipped.
  - `TZ=America/Chicago`: 138 files, 1138 passed / 2 skipped.
- API, full suite against a private test DB: 141 files, 1372 passed / 7 todo. The extra files came in with main.
- Codegen: rerunning it over the committed output changes nothing. The only change this round is the `RecurringItemMoveResult` description.
- `pnpm run build` plus `check-entry-graph`: OK, 574.4 KB.
- New and changed tests this round, all in `oneTimeBillMove.integration.test.ts` (now 46 tests):
  - 2 for the date allowance;
  - 4 for restore on archive (replacing the round-3 "archive clears" test);
  - 3 for pause (replacing the round-3 "pause clears" test, and dropping the pause line from the `moveResult` test).

**Fails before `ffb8e112`** (with main merged, `4cd8000f`; that source run with this commit's tests):
- `oneTimeBillMove.integration.test.ts`: **8 of 46 fail**. That is every round-4 test except the 8/05 control. The "edit saved on a paused bill" test fails there too, because the pause step had already deleted the review; it is kept as the round-4 control for edits.

**Earlier rounds:**

| Round | Against | API | Pin / toast | Web |
|---|---|---|---|---|
| 3 | `ef8ebe44` | 9 of 9 new fail (with pins) | Toast 3 of 5 fail | |
| 2 | `d684757f` | 12 of 29 fail | L4 pin 1 of 2 fails | 10 of 20 fail |
| 1 | `df2adda` | 11 of 16 fail | | 11 of 15 fail |

The API "Confirm on a needs-review pair" test is a control: it also passes on `df2adda`. L2 (row locks) has no test.

## Residuals

- **An archive restore brings back a questioned answer.** A review created because the amount changed (say a $300 match on a bill raised to $3,000), once archived, is restored to `matched`. The past month then counts the $300 row as that bill's payment. The curve cannot change, but it is the user's old answer, not a fresh one.
- **A paused bill with a review shows 0.00 actual** on Bills: that summary reads stored `matched` only, and the review is stored as a review. Count and curve read it as answered.
- **Orphaned answers on deleted bills.** Matched and partial rows on a deleted bill stay (older behaviour); only pending reviews are cleared.
- **M2a/M2b are handled by clearing** (reported in the toast), not by making the question answerable. Card rows cannot be matched in Forecast Review, as today.
- **Register window vs page horizon.** The register window uses the saved forecast horizon (`daysAhead`); a page on another horizon may differ.
- **L2: an insert can still race.** The row locks cannot stop a concurrent `POST /forecast/resolutions` insert mid-edit (no unique key, no DDL).
- **Transactions page.** "Not a planned payment" on a row in a pending review writes `ignored_unforecasted`, which clears the pair without saying so.
- **Scope of the re-check.** It covers one-time bills' date, amount and kind. A recurring bill's amount edit does not question its matches, and a change of frequency *into* one-time does not move answers.
- **No repair of old data.** Answers orphaned by edits made before this PR are not repaired. No data script; production not touched.

## Owner questions

1. **A Bills date edit replaces an earlier Forecast "Move" of the same one-time bill.** No double count, nothing lost. *Reviewer recommends accepting; pending the owner.*
2. **A needs-review bill moved back near its row stays "needs review"** rather than becoming paid again. *Reviewer agrees; pending the owner.*
3. Should a one-off script re-key production one-time bills already orphaned by past date edits?
4. **A date-only move keeps a match the user accepted at a different amount**; the in-full band applies only when the amount changes. *Reviewer recommends accepting; pending the owner.* Round 4 applies the same principle to dates (fix 1).
