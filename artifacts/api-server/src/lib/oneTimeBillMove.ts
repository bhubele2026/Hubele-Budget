import { and, eq, inArray } from "drizzle-orm";
import { db, forecastResolutionsTable, transactionsTable } from "@workspace/db";
import { rowInMatchWindow } from "@workspace/avalanche-core";

/**
 * ⭐ MOVING A ONE-TIME BILL KEEPS ITS ANSWERS (owner decision 9).
 *
 * Resolutions are keyed on `<itemId>|<occurrenceDate>`, and a one-time bill has
 * exactly one occurrence: its `anchor_date`. `PATCH /recurring-items/:id` used to
 * overwrite that date and leave every answer behind on the old one — and
 * `resolutionRemap` never maps one-time bills — so a paid bill moved from the
 * 20th to the 25th came back unpaid (and, once past, overdue).
 *
 * When the PATCH moves a one-time bill (still one-time, a new non-empty date),
 * the route calls `moveOneTimeResolutions` in the SAME transaction as the item
 * update:
 *   - every answer on the old date — matched, partial, skipped, missed,
 *     dismissed, "Not this", an earlier `needs_review` — moves to the new date,
 *     status unchanged. So does an answer written on the date a Forecast "Move"
 *     sent the bill to (the pre-PR6 Past-due card keyed it there);
 *   - ⚠️ a Forecast "Move" (`rescheduled`) on the old date is DELETED: the edit
 *     now carries the date. Keeping it would leave the bill on the date it was
 *     moved to and silently ignore the edit;
 *   - a `matched` or `partial` whose bank row is dated outside the matcher's
 *     window around the NEW date (`rowInMatchWindow`: 10 days before to 14 days
 *     after) becomes `needs_review`, keeping `matched_txn_id`. Every reader treats
 *     it as unresolved: the plan is back on the curve (or overdue, by the usual
 *     rules), the row counts in Review, Bills does not count it paid, and the
 *     bill is never archived on it. Forecast Review shows the pair as "Match
 *     needs review" with Confirm (→ `matched`) and Not this (→ `not_match`);
 *   - a `needs_review` moved back inside the window stays `needs_review`: a move
 *     never marks a bill paid on its own.
 * Bank transaction rows are only read, never written. Recurring (non-one-time)
 * bills are untouched here: `resolutionRemap` maps their answers at read time.
 */

export const NEEDS_REVIEW_STATUS = "needs_review";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The old and new date when a PATCH moves a one-time bill; null otherwise. */
export function oneTimeDateMove(
  before: { frequency: string; anchorDate: string | null },
  body: { frequency?: string; anchorDate?: string | null },
): { from: string; to: string } | null {
  if (before.frequency !== "onetime") return null;
  if ((body.frequency ?? before.frequency) !== "onetime") return null;
  if (body.anchorDate === undefined) return null;
  const from = before.anchorDate;
  const to = body.anchorDate;
  if (!from || !to || from === to) return null;
  return { from, to };
}

export type OneTimeMoveResult = {
  /** Answers now keyed on the new date with their status unchanged. */
  moved: number;
  /** Matches or partials whose row is outside the window around the new date: now `needs_review`. */
  needsReview: number;
  /** Forecast "Move" rows on the old date that the edit replaced. */
  reschedulesReplaced: number;
};

export async function moveOneTimeResolutions(
  tx: Tx,
  householdId: string,
  itemId: string,
  from: string,
  to: string,
): Promise<OneTimeMoveResult> {
  const own = await tx
    .select({
      id: forecastResolutionsTable.id,
      status: forecastResolutionsTable.status,
      occurrenceDate: forecastResolutionsTable.occurrenceDate,
      matchedTxnId: forecastResolutionsTable.matchedTxnId,
      rescheduledTo: forecastResolutionsTable.rescheduledTo,
    })
    .from(forecastResolutionsTable)
    .where(
      and(
        eq(forecastResolutionsTable.householdId, householdId),
        eq(forecastResolutionsTable.recurringItemId, itemId),
      ),
    );
  const reschedules = own.filter((r) => r.status === "rescheduled" && r.occurrenceDate === from);
  const movedTo = new Set(reschedules.map((r) => r.rescheduledTo).filter((d): d is string => !!d));
  const answers = own.filter(
    (r) =>
      r.status !== "rescheduled" &&
      r.occurrenceDate != null &&
      (r.occurrenceDate === from || movedTo.has(r.occurrenceDate)),
  );

  const isPaidPair = (status: string) => status === "matched" || status === "partial";
  const pairTxnIds = [
    ...new Set(answers.filter((r) => isPaidPair(r.status) && r.matchedTxnId).map((r) => r.matchedTxnId!)),
  ];
  const rowDate = new Map<string, string>();
  if (pairTxnIds.length > 0) {
    const rows = await tx
      .select({ id: transactionsTable.id, occurredOn: transactionsTable.occurredOn })
      .from(transactionsTable)
      .where(and(eq(transactionsTable.householdId, householdId), inArray(transactionsTable.id, pairTxnIds)));
    for (const row of rows) rowDate.set(row.id, row.occurredOn);
  }

  const keep: string[] = [];
  const review: string[] = [];
  for (const r of answers) {
    const paidOn = r.matchedTxnId ? rowDate.get(r.matchedTxnId) : undefined;
    if (isPaidPair(r.status) && paidOn && !rowInMatchWindow(to, paidOn)) review.push(r.id);
    else keep.push(r.id);
  }

  const inHousehold = eq(forecastResolutionsTable.householdId, householdId);
  if (keep.length > 0) {
    await tx
      .update(forecastResolutionsTable)
      .set({ occurrenceDate: to })
      .where(and(inHousehold, inArray(forecastResolutionsTable.id, keep)));
  }
  if (review.length > 0) {
    await tx
      .update(forecastResolutionsTable)
      .set({ occurrenceDate: to, status: NEEDS_REVIEW_STATUS })
      .where(and(inHousehold, inArray(forecastResolutionsTable.id, review)));
  }
  if (reschedules.length > 0) {
    await tx
      .delete(forecastResolutionsTable)
      .where(and(inHousehold, inArray(forecastResolutionsTable.id, reschedules.map((r) => r.id))));
  }
  return { moved: keep.length, needsReview: review.length, reschedulesReplaced: reschedules.length };
}
