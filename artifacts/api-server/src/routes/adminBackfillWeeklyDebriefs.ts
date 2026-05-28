// (#770) ONE-SHOT DIAGNOSTIC ROUTE — Phase D1 Weekly Debrief backfill,
// scoped to the signed-in owner's household. Mirrors the logic of
// `scripts/backfill-weekly-debriefs.ts` but:
//   - scoped to req.householdId (no all-households walk)
//   - idempotent via ON CONFLICT DO NOTHING on (household_id, week_start)
//     so a duplicate trigger is a no-op (it will NOT overwrite an
//     existing row, locked or not)
//   - auth-gated to the household owner via requireAuth + requireOwner
//
// Trigger:
//   POST /api/admin/backfill-weekly-debriefs
//
// To be REMOVED after the one-shot apply completes — this route is
// not part of the long-term surface area. See task #770.

import { Router, type IRouter, type Request, type Response } from "express";
import { and, asc, eq } from "drizzle-orm";
import {
  db,
  transactionsTable,
  weeklyDebriefsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { requireOwner } from "../middlewares/requireOwner";
import {
  computeWeekVariance,
  summarizeActions,
  weekEndFor,
  weekStartFor,
} from "../lib/weeklyDebrief";
import { addDays, fmtISO, parseISO } from "../lib/cashSignal";

const router: IRouter = Router();

async function earliestTxnDate(householdId: string): Promise<string | null> {
  const rows = await db
    .select({ d: transactionsTable.occurredOn })
    .from(transactionsTable)
    .where(eq(transactionsTable.householdId, householdId))
    .orderBy(asc(transactionsTable.occurredOn))
    .limit(1);
  return rows[0]?.d ?? null;
}

router.post(
  "/admin/backfill-weekly-debriefs",
  requireAuth,
  requireOwner,
  async (req: Request, res: Response): Promise<void> => {
    const householdId = req.householdId!;
    const now = new Date();
    const lastSat = fmtISO(addDays(parseISO(weekStartFor(now)), -1));

    const first = await earliestTxnDate(householdId);
    if (!first) {
      res.json({
        householdId,
        earliestTxn: null,
        weeksConsidered: 0,
        rowsInserted: 0,
        rowsSkipped: 0,
        weekStarts: [],
        message: "No transactions for household; nothing to backfill.",
      });
      return;
    }

    const startSun = weekStartFor(first);
    const lastSun = weekStartFor(lastSat);
    if (startSun > lastSun) {
      res.json({
        householdId,
        earliestTxn: first,
        weeksConsidered: 0,
        rowsInserted: 0,
        rowsSkipped: 0,
        weekStarts: [],
        message: "No past weeks to backfill.",
      });
      return;
    }

    const weeks: string[] = [];
    let cur = parseISO(startSun);
    const end = parseISO(lastSun);
    while (cur <= end) {
      weeks.push(fmtISO(cur));
      cur = addDays(cur, 7);
    }

    let inserted = 0;
    let skipped = 0;
    const insertedWeeks: string[] = [];

    for (const ws of weeks) {
      const snap = await computeWeekVariance(householdId, ws, { now });
      const actions = summarizeActions(snap);
      const nowTs = new Date();
      const result = await db
        .insert(weeklyDebriefsTable)
        .values({
          householdId,
          weekStart: ws,
          weekEnd: weekEndFor(ws),
          status: "awaiting_review",
          varianceSnapshot: snap,
          actionsSummary: actions,
          updatedAt: nowTs,
        })
        .onConflictDoNothing({
          target: [weeklyDebriefsTable.householdId, weeklyDebriefsTable.weekStart],
        })
        .returning({ id: weeklyDebriefsTable.id });
      if (result.length > 0) {
        inserted += 1;
        insertedWeeks.push(ws);
      } else {
        skipped += 1;
      }
    }

    res.json({
      householdId,
      earliestTxn: first,
      weeksConsidered: weeks.length,
      rowsInserted: inserted,
      rowsSkipped: skipped,
      weekStarts: insertedWeeks,
    });
  },
);

export default router;
