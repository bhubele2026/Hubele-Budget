# PR-C — Editing a one-time bill keeps its identity (owner decision 9)

Branch `fix/one-time-bill-move`, base `df2adda`. Round 1 was `d684757f`. Round 2 answers that commit's review (REQUEST CHANGES: new silent-paid paths).

## Owner decision

> Moving the same obligation should preserve its notes, review history, and resolution state. Never rewrite the date of an actual bank payment. Revalidate a match if the edited date makes it questionable. If the user intends a new obligation, create a new occurrence with a new answer. Distinguish "Move this bill" from "Create another bill." Rescheduling must not resurrect a paid bill or silently mark a new bill paid.

## The bug

Resolutions are keyed on `<itemId>|<occurrenceDate>`. A one-time bill's only occurrence is its `anchor_date`. `PATCH /recurring-items/:id` overwrote that date and left every answer on the old date. `resolutionRemap` never maps one-time bills, so a paid bill came back unpaid (and, once past, overdue), and a skipped bill came back on the curve.

## What changed

### Server: `lib/oneTimeBillMove.ts`

The PATCH runs in one transaction, with the item row and all of its resolution rows locked `FOR UPDATE` (L2).

**When it runs.** A one-time bill that stays one-time and whose date, amount or kind changed (H1). The comparison is between the item row before the update and after it.

**Answers follow the bill.** Every answer on the old date moves to the new date:
- matched, partial, skipped, missed, dismissed;
- "Not this" (`not_match`);
- a pending review.

An answer written on the date a Forecast "Move" sent the bill to (pre-PR6) moves too.

**Forecast Moves are replaced.** A Forecast "Move" (`rescheduled`) on the old date is deleted, and so is one left on the new date: the edit now carries the date.

**Pairs are re-checked against the matcher's candidate bounds (L4).** The date window is 10 days before to 14 days after the plan (`rowInMatchWindow`). The amount tolerance is max($25, 25%) (`rowWithinMatchAmount`, with `MATCH_LOOSE_MIN_CENTS` / `MATCH_LOOSE_SHARE`). These are the bounds `matchPlansToRows` pairs a named row in, not a confidence tier. `planMatch.test.ts` pins both helpers to `matchPlansToRows` at the edges. The check uses the new due date and the new signed amount (income positive, as `expandItem` does):
- A **match** still pays when its row is inside the window, the same sign, and within the tolerance. Otherwise it becomes `needs_review`.
- A **partial** still pays part when its row is inside the window, the same sign, and leaves more than $1 unpaid (the ledger's remainder rule). Otherwise it becomes `needs_review_partial` (M3).
  - ⚠️ This deliberately differs from the review's wording. Applying the loose tolerance to a partial would put every real partial ($200 of $300) in question on any edit. The silent-paid path the rule must close is an edit that makes the row cover the bill, and that is caught.
- A pair is only put in question where **Forecast Review can show it**. The new date must be inside the register (first of last month through today + the forecast horizon), and the row must be a checking row in the forecast (the bundle's own filter).
  - Otherwise the match is **cleared** and the bill is unresolved on its new date (M2a, M2b). No answer is left that nobody can give.
- A pair whose **bank row no longer exists** is cleared (L1).
- A pending review never turns paid on its own.

**One decision per key (M1).** An answer already stranded on the new date is re-checked the same way. Priority:
1. a live answer that still holds;
2. a stranded pair that still pays;
3. the live pending review;
4. a stranded pending review that Review can show.

The rest are deleted. A stranded skip or miss is never adopted.

**Leaving one-time (M2c).** A bill that stops being one-time drops its pending reviews, so no row stays claimed by a question nothing will answer. The row goes back to Review.

Bank transaction rows are only read.

### Server: readers of the two review statuses

`needs_review` and `needs_review_partial` are text statuses; no DDL.
- **Forecast ledger:** unresolved. The plan is on the curve (or overdue by the usual rules), and the pair still holds its row.
- **`reviewCount`:** the row counts as unreviewed.
- **Bills:** `actual` counts only `matched`.
- **`archiveExpiredOneTime` (M2d):** a review on the bill's current date keeps it active while Review can still show it (due on or after the first of last month). A review on another date holds nothing, and neither does one Review can no longer show; after that the 60-day rule applies as to any unresolved bill.
- **`POST /forecast/resolutions`:**
  - "Not this" clears either review status on the identical pair.
  - Matched and partial writes clear them as plan neighbours.
  - A Forecast Move keeps them.

Recurring (non-one-time) edits are unchanged; `resolutionRemap` still maps them at read time.

### Web

- **Register:** `buildLineRegister` treats both statuses as unresolved on both sides. The plan carries `probablyPaid.needsReview` ("match" / "partial"), never off the curve, with the whole bill still planned. The row stays pending, with the plan as its pair.
- **Strip and plan row:**
  - A match reads "Match needs review", with Confirm and Not this.
  - A partial reads "Partial payment needs review". Its primary answer is **Partial**; **Confirm full** is secondary; Not this stays (M3).
  - Neither shows a confidence.
- **Row state and cache:** `rowDecisionsByTxn` and `applyResolutionWrite` mirror the server.
- **Bills editor, one-time items:**
  - Once the date changes, the default save reads "Move this bill".
  - **Create another bill** appears only once the date, name or amount differs, and creates an **active** bill even if the original is paused (L3).
  - The Help chip says a far move or a new amount asks for review (NIT).

**OpenAPI:** no resolution status enum exists (`status: { type: string }`), so there is no spec or codegen change.

## Figures that move

Test fixture: today is Sat 2026-09-19, the snapshot is $2,000, and a $300 one-time "Roof repair" due 9/20 is matched to a −$300 checking row dated 9/19.

### Round 1: `df2adda` → `d684757f`

| Scenario | `df2adda` | Now |
|---|---|---|
| Moved to 9/25 | Back on the curve: 9/25 balance 1,700.00 | Still matched: 2,000.00; not overdue; Review count 0; Bills September actual 300.00 |
| Moved to 10/20 | Row hidden from Review; Bills counted it paid (300.00) | Needs review: 10/20 balance 1,700.00; Review count 1; Bills 0.00; bank row still 9/19 |
| Skipped bill moved | −300 back on the curve | Still skipped |
| Partial ($200) moved to 9/22 | −300 on 9/22 | −100 remainder on 9/22 |

### Round 2: `d684757f` → this commit

| Finding | `d684757f` | Now |
|---|---|---|
| H1: 9/28 and $3,000 in one save | Matched, off the curve; 9/28 balance 2,000.00; review 0 | Needs review; 9/28 balance −1,000.00; review 1 |
| H1: $3,000, same date | Matched | Needs review; −3,000 on 9/20 |
| H1: expense → income on 9/25 | A debit "paid" the income plan | Needs review; 9/25 balance 2,300.00 |
| M1: stranded match on 10/01 plus a live match, moved to 10/01 | Two decisions on one key; bill off the curve | One needs-review answer; −300 on 10/01 |
| M2a: moved to 7/01 | An unanswerable review; bill active for good | Match cleared; unresolved; archived by the 60-day rule |
| M2b: paid by a card row, moved to 10/20 | An invisible review holding the row | Match cleared; −300 on 10/20 (the curve figure does not change) |
| M2c: review, then a monthly bill | Stranded review claiming the row | Cleared; the row is back in Review (count 1) |
| M2d: review on another date | Blocked archiving | Archived by the 60-day rule |
| M3: partial moved to 10/20, then answered | Confirm wrote a full match: 10/20 balance 2,000.00 | Partial: 1,900.00 |
| L1: matched row deleted, moved to 9/25 | Match carried; bill off the curve | Dropped; −300 on 9/25 |

## Must not change

- Recurring-bill edits: stored answers keep their dates, and the read-time remap is unchanged (tested).
- Bank transaction rows: date, amount and description are asserted unchanged.
- Ledger behaviour for every existing status. The golden, overdue-evidence and probably-paid suites are green.
- `matchPlansToRows` is not edited; the new helpers are pinned to it by test.
- Spine parity: the spine calls the same `computeReviewCount`.
- No DDL, no API spec change, no new dependency.
- Open path stays at 574.4 KB (cap 580).

## Verification

- `pnpm run typecheck`: green.
- Web, full suite:
  - `TZ=UTC`: 138 files, 1132 passed / 3 skipped.
  - `TZ=America/Chicago`: 138 files, 1133 passed / 2 skipped. A run shared with the API suite and the build timed out one unrelated Chase inbox test at 5.8s; it passed on a clean rerun.
- API, full suite against a private test DB: 139 files, 1333 passed / 7 todo.
- `pnpm run build` plus `check-entry-graph`: OK, 574.4 KB.

**New tests (round 2):**
- `oneTimeBillMove.integration.test.ts`: 29 tests.
- `planMatch.test.ts`: +2.
- `forecastNeedsReview.test.ts`: 10.
- `needsReviewStrip.test.tsx`: 4.
- `billsOneTimeMove.test.tsx`: 6.

**Fails before `d684757f`** (its source with this commit's tests):

| Suite | Result on `d684757f` | What passes, and why |
|---|---|---|
| API integration | 12 of 29 fail | Every H1, M1, M2a–d, M3 and L1 case fails. The rest are round-1 behaviour or controls: the $320 amount control, M3's in-window partial and its "Not this" replace, the 9/01 review, the archive control, **"Confirm on a needs-review pair"** (it also passes on `df2adda`), no-change, recurring edit, Create another. |
| L4 | 1 of 2 fails | `rowWithinMatchAmount` is missing. The window test is a guard. |
| Web | 10 of 20 fail | The rest are round-1 checks (matched contrast, reconcile, server suggestion, no bucket row, recurring editor, Move this bill). |
| L2 | No test | A row lock is not deterministically testable here: on `d684757f` the PATCH's UPDATE of the same rows would block on a held lock too. |

**Fails before `df2adda`** (round 1): API 11 of 16, web 11 of 15.

## Residuals

- **M2a/M2b are handled by clearing, not by making the question answerable.**
  - A one-time bill paid from a card row and moved outside the window loses its match and shows unpaid. Card rows cannot be matched in Forecast Review, same as today.
  - A bill moved before the first of last month is unresolved, falls off the curve by the existing overdue rule, and is archived after 60 days.
- **Register window vs page horizon.** The server's register window uses the saved forecast horizon (`daysAhead`). A page open on a different horizon may not show a far review until its horizon reaches it (or may have shown a pair the server cleared).
- **A pending review can age out.** Once its date passes the first of last month it is no longer shown, and the 60-day rule archives the bill. Its row claim lasts until then; by that point the row is also old.
- **L2: an insert can still race.** The row locks cannot stop a concurrent `POST /forecast/resolutions` from inserting a new row mid-edit (no unique key on resolutions, and no DDL here). The item lock serializes edits only.
- **Transactions page.** "Not a planned payment" (single or bulk) on a row in a pending review writes `ignored_unforecasted`, which clears the pair without saying so.
- **Scope of the re-check.** It covers one-time bills' date, amount and kind. A recurring bill's amount edit does not question its matches, as before. A change of frequency *into* one-time does not move answers.
- **No repair of old data.** Answers orphaned by one-time edits made before this PR are not repaired. There is no data script and production was not touched.

## Owner questions

1. **A Bills date edit replaces an earlier Forecast "Move" of the same one-time bill.** The reviewer reproduced it: no double count, nothing lost. *Reviewer recommends accepting; pending the owner.*
2. **A needs-review bill moved back near its row stays "needs review"** rather than becoming paid again. *Reviewer agrees; pending the owner.*
3. Should a one-off script re-key production one-time bills already orphaned by past date edits?
