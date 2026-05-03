import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  avalancheSettingsTable,
  budgetCategoriesTable,
  budgetLinesTable,
  transactionsTable,
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

function monthEndStr(monthStart: string): string {
  const d = new Date(monthStart);
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

export async function resolveExtraForUser(userId: string) {
  const settings = await ensureSettings(userId);
  const monthStart = currentMonthStart();
  const monthEnd = monthEndStr(monthStart);
  const source = settings.extraSource ?? "manual";
  const mode = settings.budgetMode ?? "budgeted";

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
      return {
        source,
        amount: "0",
        monthStart,
        mode,
        breakdown: { categoryId: null, categoryName: null, planned: "0", actual: "0" },
      };
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

    const isIncome = cat?.kind === "income";
    // For income categories, "actual" = sum of positive amounts (incoming money).
    // For expense categories, "actual" = sum of |amount| where amount < 0 (spend).
    const [actualRow] = await db
      .select({
        total: isIncome
          ? sql<string>`coalesce(sum(case when ${transactionsTable.amount} > 0 then ${transactionsTable.amount} else 0 end)::text, '0')`
          : sql<string>`coalesce(sum(case when ${transactionsTable.amount} < 0 then -${transactionsTable.amount} else 0 end)::text, '0')`,
      })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, userId),
          eq(transactionsTable.categoryId, catId),
          sql`${transactionsTable.occurredOn} >= ${monthStart}`,
          sql`${transactionsTable.occurredOn} < ${monthEnd}`,
        ),
      );

    const planned = line?.plannedAmount ?? "0";
    const actual = actualRow?.total ?? "0";
    const amount = mode === "actual" ? actual : planned;

    return {
      source,
      amount,
      monthStart,
      mode,
      breakdown: {
        categoryId: catId,
        categoryName: cat?.name ?? null,
        planned,
        actual,
      },
    };
  }

  // budget_net
  let income = 0;
  let expenses = 0;
  let plannedIncome = 0;
  let plannedExpenses = 0;

  // Always compute planned for breakdown clarity.
  const plannedRows = await db
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
  for (const r of plannedRows) {
    const v = Number(r.total);
    if (r.kind === "income") plannedIncome += v;
    else plannedExpenses += v;
  }

  if (mode === "actual") {
    // Group categorized transactions by their budget category kind so that
    // "actual" mirrors the planned-mode categorization basis. Uncategorized
    // transactions are intentionally excluded (they do not belong to any
    // budget category and so should not move the avalanche extra).
    const actualRows = await db
      .select({
        kind: budgetCategoriesTable.kind,
        income: sql<string>`coalesce(sum(case when ${transactionsTable.amount} > 0 then ${transactionsTable.amount} else 0 end)::text, '0')`,
        expenses: sql<string>`coalesce(sum(case when ${transactionsTable.amount} < 0 then -${transactionsTable.amount} else 0 end)::text, '0')`,
      })
      .from(transactionsTable)
      .innerJoin(
        budgetCategoriesTable,
        and(
          eq(transactionsTable.categoryId, budgetCategoriesTable.id),
          eq(budgetCategoriesTable.userId, userId),
        ),
      )
      .where(
        and(
          eq(transactionsTable.userId, userId),
          sql`${transactionsTable.occurredOn} >= ${monthStart}`,
          sql`${transactionsTable.occurredOn} < ${monthEnd}`,
        ),
      )
      .groupBy(budgetCategoriesTable.kind);
    for (const r of actualRows) {
      // Income categories contribute incoming money (positive amounts).
      // Expense categories contribute outgoing money (|negative amounts|).
      if (r.kind === "income") income += Number(r.income);
      else expenses += Number(r.expenses);
    }
  } else {
    income = plannedIncome;
    expenses = plannedExpenses;
  }

  const net = Math.max(0, income - expenses);
  return {
    source: "budget_net" as const,
    amount: net.toFixed(2),
    monthStart,
    mode,
    breakdown: {
      income: income.toFixed(2),
      expenses: expenses.toFixed(2),
      plannedIncome: plannedIncome.toFixed(2),
      plannedExpenses: plannedExpenses.toFixed(2),
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
