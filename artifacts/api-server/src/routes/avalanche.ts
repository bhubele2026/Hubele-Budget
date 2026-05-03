import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  avalancheSettingsTable,
  budgetCategoriesTable,
  budgetLinesTable,
} from "@workspace/db";
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

function currentMonthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export async function resolveExtraForUser(userId: string) {
  const settings = await ensureSettings(userId);
  const monthStart = currentMonthStart();
  const source = settings.extraSource ?? "manual";

  if (source === "manual") {
    return {
      source: "manual" as const,
      amount: settings.manualExtra ?? "0",
      monthStart,
    };
  }

  if (source === "budget_line") {
    const catId = settings.extraBudgetCategoryId;
    if (!catId) {
      return { source, amount: "0", monthStart, breakdown: { categoryId: null, categoryName: null } };
    }
    const [cat] = await db
      .select()
      .from(budgetCategoriesTable)
      .where(
        and(
          eq(budgetCategoriesTable.id, catId),
          eq(budgetCategoriesTable.userId, userId),
        ),
      );
    const [line] = await db
      .select()
      .from(budgetLinesTable)
      .where(
        and(
          eq(budgetLinesTable.userId, userId),
          eq(budgetLinesTable.monthStart, monthStart),
          eq(budgetLinesTable.categoryId, catId),
        ),
      );
    return {
      source,
      amount: line?.plannedAmount ?? "0",
      monthStart,
      breakdown: {
        categoryId: catId,
        categoryName: cat?.name ?? null,
      },
    };
  }

  // budget_net = sum(planned where kind=income) - sum(planned where kind=expense)
  const rows = await db
    .select({
      kind: budgetCategoriesTable.kind,
      total: sql<string>`coalesce(sum(${budgetLinesTable.plannedAmount})::text, '0')`,
    })
    .from(budgetLinesTable)
    .innerJoin(
      budgetCategoriesTable,
      eq(budgetLinesTable.categoryId, budgetCategoriesTable.id),
    )
    .where(
      and(
        eq(budgetLinesTable.userId, userId),
        eq(budgetLinesTable.monthStart, monthStart),
      ),
    )
    .groupBy(budgetCategoriesTable.kind);

  let income = 0;
  let expenses = 0;
  for (const r of rows) {
    const v = Number(r.total);
    if (r.kind === "income") income += v;
    else expenses += v;
  }
  const net = Math.max(0, income - expenses);
  return {
    source: "budget_net" as const,
    amount: net.toFixed(2),
    monthStart,
    breakdown: {
      income: income.toFixed(2),
      expenses: expenses.toFixed(2),
    },
  };
}

router.get("/avalanche/extra", requireAuth, async (req, res): Promise<void> => {
  const result = await resolveExtraForUser(req.userId!);
  res.json(result);
});

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
