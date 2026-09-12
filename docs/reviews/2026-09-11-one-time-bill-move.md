# PR-C — Editing a one-time bill keeps its identity (owner decision 9)

Branch `fix/one-time-bill-move`, base `df2adda`, with `origin/main` merged at `1a0c1f71` (PR-A; clean).

| Round | Commit | Reviewer |
|---|---|---|
| 1 | `d684757f` | |
| 2 | `ef8ebe44` | REQUEST CHANGES (silent-paid paths) |
| 3 | this commit | Answers the second look at `ef8ebe44` |

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

**Pairs are re-checked** against the new due date and the new signed amount (income positive, as `expandItem` does). A pair must first sit inside the matcher's candidate date window (`rowInMatchWindow`: 10 days before to 14 after) and have the plan's sign. Then:

- **Match.**
  - When the amount changed, it stays paid only if its row **pays the new amount in full** (`rowPaysPlanInFull`, round 3): short by at most max($1, 1%), over by at most max($25, 10%). That is the band a full-name pair leaves the curve in (`offCurve`).
  - ⚠️ This replaces the round-2 max($25, 25%) tolerance, which let a $300 row keep a $376 bill paid. Per decision 13, only tier-1/2 proof pays.
  - A date-only move keeps a match the user accepted (for example a $250 row confirmed for a $300 bill). *Reviewer to confirm.*
- **Partial.**
  - It still pays part when its row leaves more than $1 of the new amount unpaid (the ledger's remainder rule).
  - When the amount changed, the new amount must also be within max($25, 25%) of the OLD amount (round 3, item 5). A $200 partial on a bill re-amounted to $10,000 needs review; the same partial on a bill raised to $320 stays partial with $120 left.
  - Comparing bill to bill keeps ordinary partials from being flagged.
- **A pair that no longer pays** becomes `needs_review` (a match) or `needs_review_partial` (a partial), keeping `matched_txn_id`. That only happens where Forecast Review can show it: the new date inside the register (first of last month through today + the forecast horizon), and the row a checking row in the forecast. Otherwise the match is cleared and the bill is unresolved on its new date.
- **A pair whose bank row no longer exists** is cleared.
- **A pending review** never turns paid on its own.

**One decision per key.** An answer already stranded on the new date is re-checked the same way. Priority:
1. a live answer that still holds;
2. a stranded pair that still pays;
3. the live pending review;
4. a stranded pending review that Review can show.

The rest are deleted. A stranded skip or miss is never adopted.

**The PATCH reports what happened (round 3, item 4).** The response carries `moveResult: { carried, needsReview, cleared }` whenever answers were re-checked or dropped. It is omitted otherwise.
- `carried`: answers kept on the bill as they were.
- `needsReview`: pairs now waiting in Review.
- `cleared`: the bill's own matches removed, plus pending reviews dropped by a pause.

The OpenAPI change is additive: `RecurringItemMoveResult`, plus `UpdateRecurringItemResponse` (`RecurringItem` + optional `moveResult`) as the PATCH response. Codegen is committed.

**Pending reviews are dropped when nothing can show them any more** (`clearPendingReviews`):
- the bill stopped being one-time;
- it was paused (PATCH `active` not "true"; round 3, item 3);
- it was archived by `archiveExpiredOneTime` (round 3);
- it was deleted (`DELETE /recurring-items/:id`, same transaction; round 3, item 3).

The row goes back to Review unclaimed, free to pay another bill.

Bank transaction rows are only read.

### Server: readers of the two review statuses

`needs_review` and `needs_review_partial` are text statuses; no DDL.
- **Forecast ledger:** unresolved. The plan is on the curve (or overdue by the usual rules), and the pair holds its row.
- **`reviewCount`:** the row counts as unreviewed.
- **Bills:** `actual` counts only `matched`.
- **`archiveExpiredOneTime`:** a review on the bill's current date keeps it active while Review can show it.
- **`POST /forecast/resolutions`:**
  - "Not this" clears either review status on the identical pair.
  - Matched and partial writes clear them as plan neighbours.
  - A Forecast Move keeps **both** (round 3, item 1: `needs_review_partial` was missing, so a move deleted it while the web cache kept it).

Recurring (non-one-time) edits are not re-checked; `resolutionRemap` still maps them at read time.

### Web

- **Register:** `buildLineRegister` treats both statuses as unresolved on both sides. The plan carries `probablyPaid.needsReview` ("match" / "partial"), never off the curve, with the whole bill planned. The row stays pending, with the plan as its pair.
- **Strip and plan row:**
  - A match reads "Match needs review", with Confirm and Not this.
  - A partial reads "Partial payment needs review". Its primary answer is Partial; Confirm full is secondary; Not this stays.
  - Neither shows a confidence.
- **Row state and cache:** `rowDecisionsByTxn` and `applyResolutionWrite` mirror the server.
- **Bills editor, one-time items:**
  - Once the date changes, the default save reads "Move this bill".
  - Create another bill appears only once the date, name or amount differs, and always creates an active bill.
  - The Help chip says a far move asks for review, and so does a new amount.
- **The save's toast now says what happened** (round 3, item 4), from `moveResult`:
  - "Moved this bill" alone when every answer was carried;
  - "1 match needs review." / "2 matches need review.";
  - "Its match was cleared, so the bill shows unpaid.";
  - "Saved" as the title when only the amount changed.

### ⚠️ Merge coupling with PR-B (`feat/match-evidence-tiers`, still changing)

A trial merge with PR-B `cfe7b955` gave four typecheck errors. Whichever PR lands second fixes them in these two places:
1. **`planMatch.test.ts`:** every `matchPlansToRows` call the pin tests make goes through one helper, `pairOne`. PR-B makes `items` required, so that is a one-line edit.
2. **Review `ProbablyPaid` objects:** they are built in exactly one place in `forecastMatch.ts` (commented at the build site), plus one fixture helper in `needsReviewStrip.test.tsx`. PR-B's required `tier` is added in those two spots.
3. **The pins themselves:** `rowInMatchWindow`, `rowWithinMatchAmount` and `rowPaysPlanInFull` are pinned to `matchPlansToRows`'s candidate window, loose tolerance and off-curve band. If PR-B moves those bounds, the pins fail until the helpers follow.

## Figures that move

Test fixture: today is Sat 2026-09-19, the snapshot is $2,000, and a $300 one-time "Roof repair" due 9/20 is matched to a −$300 checking row dated 9/19.

### Round 1: `df2adda` → `d684757f`

| Scenario | `df2adda` | Now |
|---|---|---|
| Moved to 9/25 | Back on the curve: 9/25 balance 1,700.00 | Still matched: 2,000.00; Review count 0; Bills September actual 300.00 |
| Moved to 10/20 | Row hidden from Review; Bills counted it paid (300.00) | Needs review: 10/20 balance 1,700.00; Review count 1; Bills 0.00; bank row still 9/19 |
| Skipped bill moved | −300 back on the curve | Still skipped |
| Partial ($200) moved to 9/22 | −300 | −100 remainder |

### Round 2: `d684757f` → `ef8ebe44`

| Finding | `d684757f` | `ef8ebe44` |
|---|---|---|
| H1: 9/28 and $3,000 in one save | Matched; 9/28 balance 2,000.00; review 0 | Needs review; −1,000.00; review 1 |
| H1: expense → income on 9/25 | A debit "paid" the income plan | Needs review; 9/25 balance 2,300.00 |
| M1: stranded match plus live match on one key | Two decisions; off the curve | One needs-review answer; −300 on 10/01 |
| M2a: moved to 7/01 | Unanswerable review; active for good | Match cleared; archived by the 60-day rule |
| M2b: card row, moved to 10/20 | Invisible review holding the row | Match cleared; −300 on 10/20 |
| M3: partial moved to 10/20, then answered | Confirm wrote a full match: 2,000.00 | Partial: 10/20 balance 1,900.00 |
| L1: matched row deleted | Match carried | Dropped; −300 on 9/25 |

### Round 3: `ef8ebe44` → this commit

| Item | `ef8ebe44` | Now |
|---|---|---|
| 2: bill raised to $376, same date | Matched, off the curve: $76 silently paid | Needs review; −376 on 9/20; review 1 |
| 2: bill lowered to $270 | Matched (row overpays $30) | Needs review |
| 2: $303 on 9/25 (control) | Matched | Matched |
| 1: $200 partial moved to 10/20, then a Forecast Move to 10/22 | Only `rescheduled` stored; the partial lost | `needs_review_partial` kept beside the move; −300 on 10/22; review 1 |
| 5: $200 partial, bill re-amounted to $10,000 | Partial: −9,800 on 9/20 | `needs_review_partial`; −10,000 on 9/20 |
| 3: review on a paused bill | Kept, unanswerable, review 1 | Cleared; row unclaimed |
| 3: review on a deleted bill; another $300 Roof repair due 9/18 | Orphan claims the row; the 9/18 bill is dragged to 9/21 (1,700.00) | Cleared; the 9/18 bill is paid by the freed row; 9/21 balance 2,000.00 |
| 3: review on an archived bill | Kept, claiming its row | Cleared |
| 4: a match cleared by a move | No trace | `moveResult.cleared = 1`; toast "Its match was cleared, so the bill shows unpaid." |

## Must not change

- Recurring-bill edits: stored answers keep their dates, and the read-time remap is unchanged (tested).
- Bank transaction rows: date, amount and description are asserted unchanged.
- Ledger behaviour for every existing status. The golden, overdue-evidence and probably-paid suites are green.
- `matchPlansToRows` is not edited; the helpers are pinned to it.
- Spine parity: the spine calls the same `computeReviewCount`.
- No DDL, no new dependency.
- The OpenAPI change is additive only; the PATCH response keeps every `RecurringItem` field.
- Open path stays at 574.4 KB (cap 580).

## Verification (round 3)

- `pnpm run typecheck`: green.
- Web, full suite:
  - `TZ=UTC`: 138 files, 1137 passed / 3 skipped.
  - `TZ=America/Chicago`: 138 files, 1138 passed / 2 skipped.
- API, full suite against a private test DB: 140 files, 1353 passed / 7 todo.
- Codegen: rerunning it over the committed output changes nothing.
- `pnpm run build` plus `check-entry-graph`: OK, 574.4 KB.

**New tests (round 3):**
- `oneTimeBillMove.integration.test.ts`: now 39 tests. Added: 4 amount-band, 1 Forecast Move of a partial review, 2 item 5, 3 pause/delete/archive, 1 `moveResult`. The round-2 "$320 stays matched" control is replaced by the band.
- `planMatch.test.ts`: +1 (`rowPaysPlanInFull`).
- `billsOneTimeMove.test.tsx`: +5 toast tests.

**Fails before `ef8ebe44`** (with `origin/main` merged; that source run with this commit's tests):

| Suite | Result | What passes, and why |
|---|---|---|
| API and pin tests | 9 of 9 new round-3 tests fail | Controls: $303 on 9/25, the $250 date-only move, the $200 partial on $320 |
| Bills page toast | 3 of 5 fail | Controls: a carried match and no summary read "Moved this bill" as before |

**Earlier rounds:**

| Round | Against | API | Web |
|---|---|---|---|
| 2 | `d684757f` | 12 of 29 fail | 10 of 20 fail |
| 2, L4 pin | `d684757f` | 1 of 2 fails | |
| 1 | `df2adda` | 11 of 16 fail | 11 of 15 fail |

The API "Confirm on a needs-review pair" test is a control: it also passes on `df2adda`. L2 (row locks) has no test.

## Residuals

- **Orphaned answers on deleted bills.** Matched and partial rows on a deleted bill stay (older behaviour). Only pending reviews are cleared.
- **M2a/M2b are handled by clearing, not by making the question answerable.**
  - A one-time bill paid from a card row and moved outside the window loses its match and shows unpaid. Card rows cannot be matched in Forecast Review, as today.
  - A bill moved before the first of last month is unresolved, falls off the curve by the existing overdue rule, and is archived after 60 days.
  - Both are now reported in the toast.
- **Register window vs page horizon.** The register window uses the saved forecast horizon (`daysAhead`). A page open on another horizon may show a far review later, or may have shown a pair the server cleared.
- **L2: an insert can still race.** The row locks cannot stop a concurrent `POST /forecast/resolutions` from inserting a new row mid-edit (no unique key, no DDL).
- **Transactions page.** "Not a planned payment" on a row in a pending review writes `ignored_unforecasted`, which clears the pair without saying so.
- **Scope of the re-check.** It covers one-time bills' date, amount and kind. A recurring bill's amount edit does not question its matches, and a change of frequency *into* one-time does not move answers.
- **No repair of old data.** Answers orphaned by edits made before this PR are not repaired. There is no data script; production was not touched.

## Owner questions

1. **A Bills date edit replaces an earlier Forecast "Move" of the same one-time bill.** The reviewer reproduced it: no double count, nothing lost. *Reviewer recommends accepting; pending the owner.*
2. **A needs-review bill moved back near its row stays "needs review"** rather than becoming paid again. *Reviewer agrees; pending the owner.*
3. Should a one-off script re-key production one-time bills already orphaned by past date edits?
4. (Round 3) A date-only move keeps a match the user accepted at a different amount. The in-full band applies only when the bill's amount changes. OK?
