import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, dashboardBudgetsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

router.get("/dashboard-budgets", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const conds = [eq(dashboardBudgetsTable.userId, userId)];
  if (typeof req.query.bucket === "string")
    conds.push(eq(dashboardBudgetsTable.bucket, req.query.bucket));
  if (typeof req.query.periodKey === "string")
    conds.push(eq(dashboardBudgetsTable.periodKey, req.query.periodKey));
  const rows = await db.select().from(dashboardBudgetsTable).where(and(...conds));
  res.json(rows);
});

router.put("/dashboard-budgets", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const { bucket, periodKey, amount } = req.body ?? {};
  if (!bucket || !periodKey || typeof amount !== "string") {
    res.status(400).json({ error: "bucket, periodKey, amount required" });
    return;
  }
  const [row] = await db
    .insert(dashboardBudgetsTable)
    .values({ userId, bucket, periodKey, amount })
    .onConflictDoUpdate({
      target: [
        dashboardBudgetsTable.userId,
        dashboardBudgetsTable.bucket,
        dashboardBudgetsTable.periodKey,
      ],
      set: { amount, updatedAt: new Date() },
    })
    .returning();
  res.json(row);
});

export default router;
