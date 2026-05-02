import { Router, type IRouter } from "express";
import { and, eq, sql, asc } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  transactionsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import {
  CreateCategoryBody,
  DeleteCategoryParams,
  GetBudgetMonthParams,
  UpsertBudgetLineBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/budget/categories", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, req.userId!))
    .orderBy(asc(budgetCategoriesTable.sortOrder), asc(budgetCategoriesTable.name));
  res.json(rows);
});

router.post(
  "/budget/categories",
  requireAuth,
  async (req, res): Promise<void> => {
    const parsed = CreateCategoryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const [row] = await db
      .insert(budgetCategoriesTable)
      .values({ ...parsed.data, userId: req.userId! })
      .onConflictDoUpdate({
        target: [budgetCategoriesTable.userId, budgetCategoriesTable.name],
        set: { kind: parsed.data.kind ?? "expense" },
      })
      .returning();
    res.status(201).json(row);
  },
);

router.delete(
  "/budget/categories/:id",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = DeleteCategoryParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await db
      .delete(budgetCategoriesTable)
      .where(
        and(
          eq(budgetCategoriesTable.id, params.data.id),
          eq(budgetCategoriesTable.userId, req.userId!),
        ),
      );
    res.sendStatus(204);
  },
);

router.get(
  "/budget/months/:monthStart",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = GetBudgetMonthParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const monthStart = params.data.monthStart;

    const [month] = await db
      .select()
      .from(budgetMonthsTable)
      .where(
        and(
          eq(budgetMonthsTable.userId, req.userId!),
          eq(budgetMonthsTable.monthStart, monthStart),
        ),
      );

    const cats = await db
      .select()
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.userId, req.userId!))
      .orderBy(asc(budgetCategoriesTable.sortOrder), asc(budgetCategoriesTable.name));

    const lines = await db
      .select()
      .from(budgetLinesTable)
      .where(
        and(
          eq(budgetLinesTable.userId, req.userId!),
          eq(budgetLinesTable.monthStart, monthStart),
        ),
      );

    const monthEnd = new Date(monthStart);
    monthEnd.setMonth(monthEnd.getMonth() + 1);
    const monthEndStr = monthEnd.toISOString().slice(0, 10);

    // Spend = sum of |amount| where amount < 0 (per system-wide sign convention).
    const actuals = await db
      .select({
        categoryId: transactionsTable.categoryId,
        total: sql<string>`coalesce(sum(case when ${transactionsTable.amount} < 0 then -${transactionsTable.amount} else 0 end)::text, '0')`,
      })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, req.userId!),
          sql`${transactionsTable.occurredOn} >= ${monthStart}`,
          sql`${transactionsTable.occurredOn} < ${monthEndStr}`,
        ),
      )
      .groupBy(transactionsTable.categoryId);

    const actualsByCat = new Map<string, string>(
      actuals
        .filter((a) => a.categoryId)
        .map((a) => [a.categoryId as string, a.total]),
    );
    const linesByCat = new Map(lines.map((l) => [l.categoryId, l]));

    const responseLines = cats.map((c) => {
      const line = linesByCat.get(c.id);
      return {
        id: line?.id ?? null,
        categoryId: c.id,
        categoryName: c.name,
        plannedAmount: line?.plannedAmount ?? "0",
        actualAmount: actualsByCat.get(c.id) ?? "0",
      };
    });

    res.json({
      monthStart,
      note: month?.note ?? null,
      lines: responseLines,
    });
  },
);

router.post("/budget/lines", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpsertBudgetLineBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await db
    .insert(budgetMonthsTable)
    .values({ userId: req.userId!, monthStart: parsed.data.monthStart })
    .onConflictDoNothing();

  const existing = await db
    .select()
    .from(budgetLinesTable)
    .where(
      and(
        eq(budgetLinesTable.userId, req.userId!),
        eq(budgetLinesTable.monthStart, parsed.data.monthStart),
        eq(budgetLinesTable.categoryId, parsed.data.categoryId),
      ),
    );

  let row;
  if (existing.length > 0) {
    [row] = await db
      .update(budgetLinesTable)
      .set({
        plannedAmount: parsed.data.plannedAmount,
        note: parsed.data.note ?? null,
      })
      .where(eq(budgetLinesTable.id, existing[0]!.id))
      .returning();
  } else {
    [row] = await db
      .insert(budgetLinesTable)
      .values({ ...parsed.data, userId: req.userId! })
      .returning();
  }
  res.json(row);
});

export default router;
