import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, avalancheSettingsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { UpdateAvalancheSettingsBody } from "@workspace/api-zod";

const router: IRouter = Router();

const DEFAULTS = {
  strategy: "avalanche" as const,
  extraSource: "manual" as const,
  extraBudgetCategoryId: null as string | null,
  manualExtra: "0",
  budgetMode: "budgeted" as const,
};

async function ensureSettings(userId: string) {
  const [row] = await db
    .select()
    .from(avalancheSettingsTable)
    .where(eq(avalancheSettingsTable.userId, userId));
  if (row) return row;
  const [created] = await db
    .insert(avalancheSettingsTable)
    .values({ userId, ...DEFAULTS })
    .returning();
  return created;
}

function present(row: typeof avalancheSettingsTable.$inferSelect) {
  return {
    strategy: row.strategy,
    extraSource: row.extraSource,
    extraBudgetCategoryId: row.extraBudgetCategoryId,
    manualExtra: row.manualExtra,
    budgetMode: row.budgetMode,
  };
}

router.get("/avalanche/settings", requireAuth, async (req, res): Promise<void> => {
  const row = await ensureSettings(req.userId!);
  res.json(present(row));
});

router.put("/avalanche/settings", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpdateAvalancheSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await ensureSettings(req.userId!);
  const [row] = await db
    .update(avalancheSettingsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(avalancheSettingsTable.userId, req.userId!))
    .returning();
  res.json(present(row));
});

export default router;
