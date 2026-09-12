# PR-C — Editing a one-time bill's date keeps its identity (owner decision 9)

Branch `fix/one-time-bill-move`, base `df2adda`.

## Owner decision

> Moving the same obligation should preserve its notes, review history, and resolution state. Never rewrite the date of an actual bank payment. Revalidate a match if the edited date makes it questionable. If the user intends a new obligation, create a new occurrence with a new answer. Distinguish "Move this bill" from "Create another bill." Rescheduling must not resurrect a paid bill or silently mark a new bill paid.

## The bug

Resolutions are keyed on `<itemId>|<occurrenceDate>`. A one-time bill's only occurrence is its `anchor_date`. `PATCH /recurring-items/:id` overwrote that date and left every answer on the old date. `resolutionRemap` never maps one-time bills, so a paid bill came back unpaid (and, once past, overdue), and a skipped bill came back on the curve.

## What changed

**Server**
- `lib/oneTimeBillMove.ts` (new) is called by the PATCH inside the same DB transaction as the item update (the item row is locked `FOR UPDATE`). It applies only when the item is `frequency = "onetime"` before and after the PATCH and gets a new, non-empty `anchorDate`:
  - Every answer on the old date moves to the new date with its status unchanged: matched, partial, skipped, missed, dismissed, `not_match`, `needs_review`. An answer written on the date a Forecast "Move" sent the bill to (pre-PR6) moves too.
  - A Forecast "Move" (`rescheduled`) on the old date is deleted, because the edit now carries the date. Keeping it would leave the bill on the date it was moved to and ignore the edit (owner question 1).
  - A `matched` or `partial` answer whose bank row is outside the matcher's window around the new date becomes `needs_review`. The window is 10 days before to 14 days after the plan (`rowInMatchWindow`, avalanche-core, same constants as `matchPlansToRows`). `matched_txn_id` is kept.
  - A `needs_review` answer moved back inside the window stays `needs_review` (owner question 2).
  - Bank transaction rows are only read.
- The new status is `needs_review`, plain text with no DDL. Its readers:
  - Forecast ledger: it is in no closing or key set, so the plan is unresolved and on the curve (or overdue) by the usual rules. It still claims its row, so the row is not suggested for another plan while the answer is pending.
  - `reviewCount`: the row counts as unreviewed.
  - `archiveExpiredOneTime`: a bill with a `needs_review` answer is never archived, including after the 60-day keep.
  - `billsSummary` actual: it already counted only `matched`, so it is unchanged and now tested.
  - `POST /forecast/resolutions`: a `not_match` write also clears `needs_review` on the identical pair. A `matched` or `partial` write clears it as a plan neighbour, as before. A `rescheduled` write keeps it, the same way it keeps a `partial`.
- Recurring (non-one-time) edits are unchanged; `resolutionRemap` still maps them at read time, and a test pins that.

**Web**
- `buildLineRegister` does not treat a `needs_review` pair as a decision on either side. The plan stays pending or upcoming. It carries `probablyPaid.needsReview`, never off the curve, in place of any server suggestion. The row stays `pending_bank` with the plan as `suggestedPlan`.
- The Review strip and the plan-row badge read "Match needs review" and hide the confidence. They use the existing Confirm (writes `matched`) and Not this (writes `not_match`) handlers.
- `rowDecisionsByTxn` ignores `needs_review`, so the Transactions page chip reads "In Review".
- `applyResolutionWrite` mirrors the route changes.
- Bills editor, for a one-time item:
  - Once the date changes, the default save reads "Move this bill".
  - A separate "Create another bill" button (`btnSecondary`) calls the existing create mutation with the edited fields and does not touch the original.
  - A `Help` chip explains the difference.
  - Recurring items are unchanged.

**OpenAPI:** no resolution status enum exists (`status: { type: string }`), so there is no spec or codegen change.

## Figures that move

Test fixture: today is Sat 2026-09-19, the snapshot is $2,000, and a $300 one-time "Roof repair" due 9/20 is matched to a −$300 row dated 9/19.

| Scenario | Before (`df2adda`) | After |
|---|---|---|
| Moved to 9/25 | Plan back on the curve: balance on 9/25 is 1,700.00; the match is orphaned on 9/20 | Still matched: 9/25 balance 2,000.00; off the curve, not overdue, Review count 0, Bills September actual 300.00 |
| Moved to 10/20 | Curve 1,700.00 on 10/20, but the row stayed hidden from Review (count 0) and Bills counted the bill as paid 300.00 in September | `needs_review`: 10/20 balance 1,700.00, Review count 1 ("Match needs review"), Bills actual 0.00 in September and October, bank row still dated 9/19 |
| Skipped bill moved to 10/20 | −300 back on the curve | Still skipped, off the curve |
| Partial ($200 of $300) moved to 9/22 | −300 on 9/22 | −100 remainder on 9/22 |
| Paid bill moved to 7/01 | Archived with its match orphaned | Active, `needs_review`, until answered |

## Must not change

- Recurring-bill edits: stored answers keep their dates, and the read-time remap is unchanged (tested).
- Bank transaction rows: date, amount and description are asserted unchanged.
- Ledger behaviour for every existing status. The golden, overdue-evidence and probably-paid suites are green.
- Spine parity: the spine calls the same `computeReviewCount`.
- No DDL, no API spec change, no new dependency.
- Open path stays at 574.4 KB (cap 580).

## Verification

- `pnpm run typecheck`: green.
- Web: `TZ=UTC` 138 files, 1127 passed / 3 skipped. `TZ=America/Chicago` 138 files, 1128 passed / 2 skipped.
- API, full suite against a private test DB: 139 files, 1318 passed / 7 todo.
- `pnpm run build` plus `check-entry-graph`: OK, 574.4 KB.
- New tests:
  - `oneTimeBillMove.integration.test.ts`: 16 tests.
  - `forecastNeedsReview.test.ts`: 9.
  - `needsReviewStrip.test.tsx`: 3.
  - `billsOneTimeMove.test.tsx`: 3.
- Fails before: with `df2adda` source and the new tests, API fails 11 of 16 and web fails 11 of 15. The ones that pass are controls: matched-vs-review contrast, reconcile readers, recurring edit, no-date-change, create-another, archive control.

## Residuals

- Only the date is revalidated. An amount edit on a matched bill does not question the match (unchanged from before).
- Transactions page: "Not a planned payment" (single or bulk) on a row in a `needs_review` pair writes `ignored_unforecasted`, which clears the pair. That is a user answer, but it does not say so.
- A `needs_review` that came from a `partial` offers Confirm, which writes a full match. Partial is still offered when the row paid less than the bill.
- Answers orphaned by one-time date edits made before this PR are not repaired. There is no data script and production was not touched.
- A PATCH that changes frequency to or from one-time in the same save does not move answers.
- A `needs_review` bill is exempt from the 60-day archive until it is answered.

## Owner questions

1. Should a Bills date edit delete an earlier Forecast "Move" of the same one-time bill (current behaviour), or keep it?
2. A needs-review bill moved back near its row stays "needs review" rather than becoming paid again. OK?
3. Should a one-off script re-key production one-time bills already orphaned by past date edits?
