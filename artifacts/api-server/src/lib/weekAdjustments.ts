// ⭐ (V5) A WAY BACK WHEN THE WEEK IS OVER — the server side.
//
//   buildWaysBack       `GET /money/ways-back`: the money position (the SAME
//                       `loadPositionInputs` → `computePosition` read as
//                       `GET /money/position`), the rows of this week and the
//                       8 before it classified by `classifyMovement`, and the
//                       category names — then avalanche-core's
//                       `computeWaysBack` does every sum. Read-only.
//   upsertCarryOver     THE ONE WRITER of `plan_adjustments` (with
//   deleteCarryOver     `deleteCarryOver`). Called only from the owner-only
//                       routes in `routes/money.ts`. An amount that is not a
//                       whole negative number of cents is refused here AND by
//                       the table's CHECK: an adjustment can only lower a week.
//
// ⚠️ Nothing under `src/ai` may import this module, and no job may call it
// (weekAdjustmentsLaws.test.ts): the household chooses a carry-over; no model
// and no schedule ever does. `moneyPosition.ts` reads the table on its own and
// must not import this file (the agent reads the position).

import { and, eq, inArray, sql } from "drizzle-orm";
import { budgetCategoriesTable, db, planAdjustmentsTable, type PlanAdjustment } from "@workspace/db";
import {
  WAYS_BACK_TRIM_COVERAGES,
  WAYS_BACK_USUAL_WEEKS,
  addDaysISO,
  classifyMovement,
  computePosition,
  computeWaysBack,
  spendAmount,
  type WaysBack,
  type WaysBackRow,
} from "@workspace/avalanche-core";
import { loadPositionInputs, tier2PairedTxnIdsOf } from "./moneyPosition";
import { loadMoneyContext, loadMovementRows } from "./moneyContext";
import { TRACKING_START } from "./spendingFacts";

/** The only kind of adjustment today. */
export const CARRY_OVER = "carry_over" as const;

/** The most a single carry-over may lower a week by, in cents ($100,000 — the afford ceiling). */
export const MAX_ADJUSTMENT_CENTS = 10_000_000;

export class WeekAdjustmentError extends Error {
  constructor(readonly code: "amount_not_negative") {
    super(code);
  }
}

/** A `plan_adjustments` row as the API returns it. */
export interface WeekAdjustmentView {
  weekStart: string;
  kind: typeof CARRY_OVER;
  /** Whole cents, negative. */
  amountCents: number;
  reason: string | null;
  createdAt: string;
}

export function toWeekAdjustmentView(row: PlanAdjustment): WeekAdjustmentView {
  return {
    weekStart: row.weekStart,
    kind: CARRY_OVER,
    amountCents: row.amountCents,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Upsert the household's carry-over for one week (unique on household, week,
 * kind): a second choice for the same week replaces the first.
 */
export async function upsertCarryOver(
  householdId: string,
  input: { weekStart: string; amountCents: number; reason: string | null; createdBy: string | null },
): Promise<WeekAdjustmentView> {
  if (!Number.isInteger(input.amountCents) || input.amountCents >= 0 || input.amountCents < -MAX_ADJUSTMENT_CENTS) {
    throw new WeekAdjustmentError("amount_not_negative");
  }
  const [row] = await db
    .insert(planAdjustmentsTable)
    .values({
      householdId,
      weekStart: input.weekStart,
      kind: CARRY_OVER,
      amountCents: input.amountCents,
      reason: input.reason,
      createdBy: input.createdBy,
    })
    .onConflictDoUpdate({
      target: [planAdjustmentsTable.householdId, planAdjustmentsTable.weekStart, planAdjustmentsTable.kind],
      set: {
        amountCents: input.amountCents,
        reason: input.reason,
        createdBy: input.createdBy,
        createdAt: sql`now()`,
      },
    })
    .returning();
  return toWeekAdjustmentView(row!);
}

/** Remove the household's carry-over for one week. True when a row was removed. */
export async function deleteCarryOver(householdId: string, weekStart: string): Promise<boolean> {
  const gone = await db
    .delete(planAdjustmentsTable)
    .where(
      and(
        eq(planAdjustmentsTable.householdId, householdId),
        eq(planAdjustmentsTable.weekStart, weekStart),
        eq(planAdjustmentsTable.kind, CARRY_OVER),
      ),
    )
    .returning({ id: planAdjustmentsTable.id });
  return gone.length > 0;
}

/**
 * `GET /money/ways-back`. One position read (the same as `GET /money/position`),
 * the 9 weeks of rows, the category names; `computeWaysBack` does the sums.
 */
export async function buildWaysBack(householdId: string, ownerUserId: string): Promise<WaysBack> {
  const read = await loadPositionInputs(householdId, ownerUserId);
  const position = computePosition(read.inputs);

  // The 8 weeks before this one and this week, clamped to the tracking start
  // exactly as the position's own week is.
  const start = addDaysISO(position.weekStart, -7 * WAYS_BACK_USUAL_WEEKS);
  const from = start < TRACKING_START ? TRACKING_START : start;
  const money = await loadMoneyContext(
    householdId,
    { start: from, end: position.weekEnd },
    { tier2PairedTxnIds: tier2PairedTxnIdsOf(read.cash.ledger) },
  );
  const movement = await loadMovementRows(householdId, from, position.weekEnd, money);
  const rows: WaysBackRow[] = movement.map((r) => ({
    date: r.occurredOn,
    categoryId: r.categoryId ?? null,
    coverage: classifyMovement(r, money).coverage,
    spendCents: Math.round(spendAmount(r) * 100),
  }));

  const ids = [
    ...new Set(
      rows
        .filter((r) => r.categoryId && WAYS_BACK_TRIM_COVERAGES.includes(r.coverage))
        .map((r) => r.categoryId!),
    ),
  ];
  const cats =
    ids.length === 0
      ? []
      : await db
          .select({ id: budgetCategoriesTable.id, name: budgetCategoriesTable.name })
          .from(budgetCategoriesTable)
          .where(and(eq(budgetCategoriesTable.householdId, householdId), inArray(budgetCategoriesTable.id, ids)));

  return computeWaysBack({
    position,
    // A category of another household (never expected) has no name here and is not offered.
    rows: rows.filter((r) => r.categoryId == null || cats.some((c) => c.id === r.categoryId)),
    categoryNames: new Map(cats.map((c) => [c.id, c.name])),
    trackingStart: TRACKING_START,
    nextWeek: { capCents: read.nextWeek.capCents, adjustment: read.nextWeek.adjustment },
  });
}
