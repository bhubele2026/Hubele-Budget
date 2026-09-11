import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, weeklySettlementsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { householdTodayISO, weekBounds } from "../lib/householdClock";

const router: IRouter = Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * (PR2) A settlement is keyed by the Sunday that starts its household week
 * (Sun–Sat). A Wednesday key names no week, so every verb refuses one instead
 * of storing or looking up a row no screen can reach.
 *
 * `weekBounds` is pure calendar arithmetic on the string, so the answer is the
 * same on any server timezone. It also refuses a date that does not exist:
 * 2026-02-29 rolls over to March 1st and no longer equals itself.
 */
function isSundayISO(iso: string): boolean {
  return weekBounds(iso).start === iso;
}

const NOT_A_SUNDAY = "weekStart must be a Sunday";

router.get("/weekly-settlements", requireAuth, async (req, res): Promise<void> => {
  const householdId = req.householdId!;
  const conds = [eq(weeklySettlementsTable.householdId, householdId)];
  const weekStart = typeof req.query.weekStart === "string" ? req.query.weekStart : undefined;
  if (weekStart) {
    if (!ISO_DATE.test(weekStart)) {
      res.status(400).json({ error: "weekStart must be YYYY-MM-DD" });
      return;
    }
    if (!isSundayISO(weekStart)) {
      res.status(400).json({ error: NOT_A_SUNDAY });
      return;
    }
    conds.push(eq(weeklySettlementsTable.weekStart, weekStart));
  }
  const rows = await db.select().from(weeklySettlementsTable).where(and(...conds));
  res.json(
    rows.map((r) => ({
      id: r.id,
      weekStart: r.weekStart,
      closedAt: r.closedAt.toISOString(),
      closedBy: r.closedBy,
    })),
  );
});

router.put("/weekly-settlements", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const householdId = req.householdId!;
  const { weekStart } = req.body ?? {};
  if (typeof weekStart !== "string" || !ISO_DATE.test(weekStart)) {
    res.status(400).json({ error: "weekStart must be YYYY-MM-DD" });
    return;
  }
  if (!isSundayISO(weekStart)) {
    res.status(400).json({ error: NOT_A_SUNDAY });
    return;
  }
  // (#629) Reject future weeks — there's nothing to settle yet, and a
  // direct API call shouldn't be able to seed rows the UI hides.
  const todayIso = householdTodayISO();
  if (weekStart > todayIso) {
    res.status(400).json({ error: "Cannot close a future week" });
    return;
  }
  const [row] = await db
    .insert(weeklySettlementsTable)
    .values({ userId, householdId, weekStart, closedBy: userId })
    .onConflictDoUpdate({
      target: [weeklySettlementsTable.householdId, weeklySettlementsTable.weekStart],
      set: { closedAt: new Date(), closedBy: userId },
    })
    .returning();
  res.json({
    id: row.id,
    weekStart: row.weekStart,
    closedAt: row.closedAt.toISOString(),
    closedBy: row.closedBy,
  });
});

router.delete("/weekly-settlements", requireAuth, async (req, res): Promise<void> => {
  const householdId = req.householdId!;
  const weekStart = typeof req.query.weekStart === "string" ? req.query.weekStart : undefined;
  if (!weekStart || !ISO_DATE.test(weekStart)) {
    res.status(400).json({ error: "weekStart (YYYY-MM-DD) required" });
    return;
  }
  if (!isSundayISO(weekStart)) {
    res.status(400).json({ error: NOT_A_SUNDAY });
    return;
  }
  await db
    .delete(weeklySettlementsTable)
    .where(
      and(
        eq(weeklySettlementsTable.householdId, householdId),
        eq(weeklySettlementsTable.weekStart, weekStart),
      ),
    );
  res.status(204).end();
});

export default router;
