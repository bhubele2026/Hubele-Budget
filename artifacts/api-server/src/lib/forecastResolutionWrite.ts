// ⭐ (Q2) THE FORECAST RESOLUTION WRITE — moved verbatim out of
// `POST /forecast/resolutions` (routes/forecast.ts), so a proposed fix can make
// the same write inside its own transaction, and so the neighbours it replaces
// are KNOWN: the write returns every row it deleted, and an undo puts them
// back exactly (`restoreForecastResolutions`, same ids, same fields).
//
// The route still validates its body (status, the pair-level and reschedule
// rules) and calls this with the pool: its behaviour is unchanged statement for
// statement — the same three neighbour deletes, in the same order, then the
// insert. `resolutionNeighbours` reads (never writes) the rows those deletes
// would remove, from the same conditions, for a dry run.
//
// ⚠️ This module writes `forecast_resolutions` only. It does not validate.

import { and, eq, inArray, ne, or, type SQL } from "drizzle-orm";
import { db, forecastResolutionsTable } from "@workspace/db";
import type { Exec } from "./categorizer/db";

export type ForecastResolutionRow = typeof forecastResolutionsTable.$inferSelect;

export interface ForecastResolutionInput {
  userId: string;
  householdId: string;
  recurringItemId?: string | null;
  occurrenceDate?: string | null;
  status: string;
  matchedTxnId?: string | null;
  rescheduledTo?: string | null;
}

/**
 * The neighbour deletes a write makes, in the route's order (PR5): each entry
 * is one DELETE's condition.
 *
 *   - `not_match` replaces the identical pair's earlier answers (a previous
 *     rejection, a match / partial confirmation taken back, a pending review);
 *   - any other status keeps one answer per plan occurrence and one per bank
 *     row (never touching "Not this", which survives other decisions on either
 *     side), and removes the exact pair's "Not this" it now confirms. A partial
 *     and a reschedule of the same plan coexist; a move is not an answer, so a
 *     pending review stays open beside it.
 */
function neighbourConditions(input: ForecastResolutionInput): SQL[] {
  const t = forecastResolutionsTable;
  const { householdId, recurringItemId, occurrenceDate, status, matchedTxnId } = input;
  const out: SQL[] = [];
  if (status === "not_match") {
    out.push(
      and(
        eq(t.householdId, householdId),
        inArray(t.status, ["not_match", "matched", "partial", "needs_review", "needs_review_partial"]),
        eq(t.recurringItemId, recurringItemId!),
        eq(t.occurrenceDate, occurrenceDate!),
        eq(t.matchedTxnId, matchedTxnId!),
      )!,
    );
    return out;
  }
  if (recurringItemId && occurrenceDate) {
    out.push(
      and(
        eq(t.householdId, householdId),
        eq(t.recurringItemId, recurringItemId),
        eq(t.occurrenceDate, occurrenceDate),
        ne(t.status, "not_match"),
        ...(status === "partial" ? [ne(t.status, "rescheduled")] : []),
        ...(status === "rescheduled"
          ? [ne(t.status, "partial"), ne(t.status, "needs_review"), ne(t.status, "needs_review_partial")]
          : []),
      )!,
    );
  }
  if (matchedTxnId) {
    out.push(and(eq(t.householdId, householdId), eq(t.matchedTxnId, matchedTxnId), ne(t.status, "not_match"))!);
  }
  if (recurringItemId && occurrenceDate && matchedTxnId) {
    out.push(
      and(
        eq(t.householdId, householdId),
        eq(t.status, "not_match"),
        eq(t.recurringItemId, recurringItemId),
        eq(t.occurrenceDate, occurrenceDate),
        eq(t.matchedTxnId, matchedTxnId),
      )!,
    );
  }
  return out;
}

/**
 * ⭐ Write one resolution: delete its neighbours (see `neighbourConditions`),
 * then insert it. Returns the new row and EVERY row deleted, in delete order —
 * what an undo needs to put the household's answers back as they were. Pass a
 * transaction to make the deletes and the insert one unit; the route passes the
 * pool, as it always did.
 */
export async function writeForecastResolution(
  exec: Exec,
  input: ForecastResolutionInput,
): Promise<{ row: ForecastResolutionRow; deleted: ForecastResolutionRow[] }> {
  const deleted: ForecastResolutionRow[] = [];
  for (const where of neighbourConditions(input)) {
    deleted.push(...(await exec.delete(forecastResolutionsTable).where(where).returning()));
  }
  const [row] = await exec
    .insert(forecastResolutionsTable)
    .values({
      userId: input.userId,
      householdId: input.householdId,
      recurringItemId: input.recurringItemId ?? null,
      occurrenceDate: input.occurrenceDate ?? null,
      status: input.status,
      matchedTxnId: input.matchedTxnId ?? null,
      rescheduledTo: input.rescheduledTo ?? null,
    })
    .returning();
  return { row: row!, deleted };
}

/**
 * The rows `writeForecastResolution(input)` would delete, read and not
 * written — the same conditions, so a dry run names exactly the answers the
 * write would replace. Ordered by id (a set: a row two conditions both match is
 * deleted once).
 */
export async function resolutionNeighbours(
  input: ForecastResolutionInput,
  exec: Exec = db,
): Promise<ForecastResolutionRow[]> {
  const conds = neighbourConditions(input);
  if (conds.length === 0) return [];
  const rows = await exec
    .select()
    .from(forecastResolutionsTable)
    .where(or(...conds));
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Put deleted resolutions back exactly — the same ids, statuses, dates, rows
 * and created_at. The caller (an undo) has already checked that nothing has
 * taken their place.
 */
export async function restoreForecastResolutions(exec: Exec, rows: readonly ForecastResolutionRow[]): Promise<void> {
  if (rows.length === 0) return;
  await exec.insert(forecastResolutionsTable).values(
    rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      householdId: r.householdId,
      recurringItemId: r.recurringItemId,
      occurrenceDate: r.occurrenceDate,
      status: r.status,
      matchedTxnId: r.matchedTxnId,
      rescheduledTo: r.rescheduledTo,
      createdAt: r.createdAt,
    })),
  );
}

/**
 * ⭐ (Task 6, A2) Would `writeForecastResolution(input)` delete `row`? The very
 * conditions `neighbourConditions` sends to the database, read on one row — so
 * an undo restores only answers that write could have replaced.
 */
export function isNeighbourOf(
  input: ForecastResolutionInput,
  row: Pick<ForecastResolutionRow, "householdId" | "recurringItemId" | "occurrenceDate" | "status" | "matchedTxnId">,
): boolean {
  if (row.householdId !== input.householdId) return false;
  const { recurringItemId, occurrenceDate, status, matchedTxnId } = input;
  const samePair =
    !!recurringItemId &&
    !!occurrenceDate &&
    !!matchedTxnId &&
    row.recurringItemId === recurringItemId &&
    row.occurrenceDate === occurrenceDate &&
    row.matchedTxnId === matchedTxnId;
  if (status === "not_match") {
    return samePair && ["not_match", "matched", "partial", "needs_review", "needs_review_partial"].includes(row.status);
  }
  if (recurringItemId && occurrenceDate && row.recurringItemId === recurringItemId && row.occurrenceDate === occurrenceDate && row.status !== "not_match") {
    if (status === "partial" && row.status === "rescheduled") return false;
    if (status === "rescheduled" && ["partial", "needs_review", "needs_review_partial"].includes(row.status)) return false;
    return true;
  }
  if (matchedTxnId && row.matchedTxnId === matchedTxnId && row.status !== "not_match") return true;
  return samePair && row.status === "not_match";
}

export type UndoResolutionRefusal = "not_found" | "invalid_restore" | "changed_since";

/**
 * ⭐ (Task 6, A2) UNDO ONE ANSWER EXACTLY: delete the answer a write inserted
 * and put back the answers it replaced (the `deleted` it returned), with their
 * own ids and fields — so a Match made on a SKIPPED occurrence un-does to the
 * skip, not to an open bill. Refused, nothing written, when the answer is gone
 * (`not_found`), a row to restore is not one that write could have deleted
 * (`invalid_restore`), or its id is back in the table (`changed_since`). Pass a
 * transaction: the delete and the restore are one unit.
 */
export async function undoForecastResolution(
  exec: Exec,
  householdId: string,
  resolutionId: string,
  restore: readonly ForecastResolutionRow[],
): Promise<{ ok: true; restored: number } | { ok: false; code: UndoResolutionRefusal }> {
  const t = forecastResolutionsTable;
  const [answer] = await exec.select().from(t).where(and(eq(t.id, resolutionId), eq(t.householdId, householdId)));
  if (!answer) return { ok: false, code: "not_found" };
  const input: ForecastResolutionInput = {
    userId: answer.userId,
    householdId,
    recurringItemId: answer.recurringItemId,
    occurrenceDate: answer.occurrenceDate,
    status: answer.status,
    matchedTxnId: answer.matchedTxnId,
    rescheduledTo: answer.rescheduledTo,
  };
  const ids = new Set(restore.map((r) => r.id));
  if (ids.size !== restore.length || ids.has(resolutionId) || !restore.every((r) => isNeighbourOf(input, r))) {
    return { ok: false, code: "invalid_restore" };
  }
  if (restore.length > 0) {
    const taken = await exec.select({ id: t.id }).from(t).where(inArray(t.id, [...ids]));
    if (taken.length > 0) return { ok: false, code: "changed_since" };
  }
  await exec.delete(t).where(and(eq(t.id, resolutionId), eq(t.householdId, householdId)));
  await restoreForecastResolutions(exec, restore);
  return { ok: true, restored: restore.length };
}
