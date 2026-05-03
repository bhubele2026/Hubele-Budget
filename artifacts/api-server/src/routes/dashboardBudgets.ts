import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, dashboardBudgetsTable, settingsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

const ALL_BUCKETS = ["weekly", "monthly", "unplanned"] as const;
type Bucket = (typeof ALL_BUCKETS)[number];

function settingsAmountFor(
  bucket: string,
  s: { weeklyAllowanceAmount: string; monthlyAllowanceAmount: string; unplannedAllowanceAmount: string } | undefined,
): string {
  if (!s) return "0";
  if (bucket === "weekly") return s.weeklyAllowanceAmount ?? "0";
  if (bucket === "monthly") return s.monthlyAllowanceAmount ?? "0";
  if (bucket === "unplanned") return s.unplannedAllowanceAmount ?? "0";
  return "0";
}

router.get("/dashboard-budgets", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const conds = [eq(dashboardBudgetsTable.userId, userId)];
  const bucketFilter = typeof req.query.bucket === "string" ? req.query.bucket : undefined;
  const periodKeyFilter = typeof req.query.periodKey === "string" ? req.query.periodKey : undefined;
  if (bucketFilter) conds.push(eq(dashboardBudgetsTable.bucket, bucketFilter));
  if (periodKeyFilter) conds.push(eq(dashboardBudgetsTable.periodKey, periodKeyFilter));
  const rows = await db.select().from(dashboardBudgetsTable).where(and(...conds));

  // When the caller scopes to a specific (bucket, periodKey), guarantee that
  // a row is returned by falling back to the user's Settings allowance.
  if (bucketFilter && periodKeyFilter && rows.length === 0) {
    const [s] = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.userId, userId));
    const amount = settingsAmountFor(bucketFilter, s);
    res.json([
      {
        id: `default:${bucketFilter}:${periodKeyFilter}`,
        bucket: bucketFilter,
        periodKey: periodKeyFilter,
        amount,
      },
    ]);
    return;
  }

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

export { ALL_BUCKETS };
export type { Bucket };
export default router;
