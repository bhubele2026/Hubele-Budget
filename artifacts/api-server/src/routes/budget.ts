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
import {
  SEED_CATEGORIES,
  SEED_GROUP_ORDER,
  SEED_MONTH,
} from "../lib/budgetSeed";

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
    const data = parsed.data;
    const [row] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: req.userId!,
        name: data.name,
        kind: data.kind ?? "expense",
        groupName: data.groupName ?? "Other",
        sourceKind: data.sourceKind ?? "manual",
        sortOrder: data.sortOrder ?? 0,
      })
      .onConflictDoUpdate({
        target: [budgetCategoriesTable.userId, budgetCategoriesTable.name],
        set: {
          kind: data.kind ?? "expense",
          ...(data.groupName ? { groupName: data.groupName } : {}),
          ...(data.sourceKind ? { sourceKind: data.sourceKind } : {}),
        },
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

router.post(
  "/budget/seed-defaults",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.userId!;
    const result = await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(budgetCategoriesTable)
        .where(eq(budgetCategoriesTable.userId, userId));
      const byName = new Map(existing.map((c) => [c.name, c]));

      let categoriesInserted = 0;
      const sortOrderByGroup = new Map<string, number>();
      SEED_GROUP_ORDER.forEach((g, i) => sortOrderByGroup.set(g, i * 100));

      for (let i = 0; i < SEED_CATEGORIES.length; i++) {
        const seed = SEED_CATEGORIES[i]!;
        const groupBase = sortOrderByGroup.get(seed.groupName) ?? 9999;
        const sortOrder = groupBase + i;
        const cur = byName.get(seed.name);
        if (!cur) {
          const [row] = await tx
            .insert(budgetCategoriesTable)
            .values({
              userId,
              name: seed.name,
              kind: seed.kind,
              groupName: seed.groupName,
              sourceKind: seed.sourceKind,
              sortOrder,
            })
            .returning();
          if (row) byName.set(row.name, row);
          categoriesInserted++;
        } else if (
          cur.groupName !== seed.groupName ||
          cur.sourceKind !== seed.sourceKind ||
          cur.kind !== seed.kind
        ) {
          // Backfill metadata for existing categories without overwriting their identity.
          await tx
            .update(budgetCategoriesTable)
            .set({
              groupName: seed.groupName,
              sourceKind: seed.sourceKind,
              kind: seed.kind,
              sortOrder,
            })
            .where(eq(budgetCategoriesTable.id, cur.id));
        }
      }

      // Ensure budget month row.
      await tx
        .insert(budgetMonthsTable)
        .values({ userId, monthStart: SEED_MONTH })
        .onConflictDoNothing();

      const existingLines = await tx
        .select()
        .from(budgetLinesTable)
        .where(
          and(
            eq(budgetLinesTable.userId, userId),
            eq(budgetLinesTable.monthStart, SEED_MONTH),
          ),
        );
      const lineByCat = new Map(existingLines.map((l) => [l.categoryId, l]));

      let linesInserted = 0;
      for (const seed of SEED_CATEGORIES) {
        const cat = byName.get(seed.name);
        if (!cat) continue;
        const cur = lineByCat.get(cat.id);
        if (!cur) {
          await tx
            .insert(budgetLinesTable)
            .values({
              userId,
              monthStart: SEED_MONTH,
              categoryId: cat.id,
              plannedAmount: seed.planned,
              note: seed.note,
            })
            .onConflictDoNothing({
              target: [
                budgetLinesTable.userId,
                budgetLinesTable.monthStart,
                budgetLinesTable.categoryId,
              ],
            });
          linesInserted++;
        } else if (cur.note == null && seed.note != null) {
          // Backfill missing notes only; do not overwrite planned amount.
          await tx
            .update(budgetLinesTable)
            .set({ note: seed.note })
            .where(eq(budgetLinesTable.id, cur.id));
        }
      }

      return {
        categoriesInserted,
        linesInserted,
        alreadySeeded: categoriesInserted === 0 && linesInserted === 0,
      };
    });
    res.json(result);
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

    // Spend = sum of |amount| where amount < 0 for expense categories; income = sum positive.
    const actuals = await db
      .select({
        categoryId: transactionsTable.categoryId,
        spend: sql<string>`coalesce(sum(case when ${transactionsTable.amount} < 0 then -${transactionsTable.amount} else 0 end)::text, '0')`,
        inflow: sql<string>`coalesce(sum(case when ${transactionsTable.amount} > 0 then ${transactionsTable.amount} else 0 end)::text, '0')`,
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

    const spendByCat = new Map<string, string>();
    const inflowByCat = new Map<string, string>();
    for (const a of actuals) {
      if (!a.categoryId) continue;
      spendByCat.set(a.categoryId, a.spend);
      inflowByCat.set(a.categoryId, a.inflow);
    }
    const linesByCat = new Map(lines.map((l) => [l.categoryId, l]));

    const responseLines = cats.map((c) => {
      const line = linesByCat.get(c.id);
      const actualAmount =
        c.kind === "income"
          ? inflowByCat.get(c.id) ?? "0"
          : spendByCat.get(c.id) ?? "0";
      return {
        id: line?.id ?? null,
        categoryId: c.id,
        categoryName: c.name,
        plannedAmount: line?.plannedAmount ?? "0",
        actualAmount,
        note: line?.note ?? null,
        groupName: c.groupName,
        sourceKind: c.sourceKind,
        sortOrder: c.sortOrder,
        kind: c.kind,
      };
    });

    // Group by groupName, ordering by SEED_GROUP_ORDER first then any extra groups alphabetically.
    const groupMap = new Map<string, typeof responseLines>();
    for (const l of responseLines) {
      const arr = groupMap.get(l.groupName) ?? [];
      arr.push(l);
      groupMap.set(l.groupName, arr);
    }
    const orderIdx = new Map(SEED_GROUP_ORDER.map((g, i) => [g, i]));
    const orderedGroups = Array.from(groupMap.keys()).sort((a, b) => {
      const ai = orderIdx.has(a) ? orderIdx.get(a)! : 1000;
      const bi = orderIdx.has(b) ? orderIdx.get(b)! : 1000;
      if (ai !== bi) return ai - bi;
      return a.localeCompare(b);
    });

    // Always include the canonical groups even if empty, so the UI shows them in order.
    for (const g of SEED_GROUP_ORDER) {
      if (!groupMap.has(g)) {
        groupMap.set(g, []);
        orderedGroups.push(g);
      }
    }
    // Re-dedupe orderedGroups while preserving order.
    const seen = new Set<string>();
    const finalGroupOrder = [];
    for (const g of [...SEED_GROUP_ORDER, ...orderedGroups]) {
      if (seen.has(g)) continue;
      seen.add(g);
      if (groupMap.has(g)) finalGroupOrder.push(g);
    }

    const groups = finalGroupOrder.map((groupName) => {
      const items = (groupMap.get(groupName) ?? []).slice().sort(
        (a, b) => a.sortOrder - b.sortOrder || a.categoryName.localeCompare(b.categoryName),
      );
      let plannedTotal = 0;
      let actualTotal = 0;
      for (const l of items) {
        plannedTotal += parseFloat(l.plannedAmount) || 0;
        actualTotal += parseFloat(l.actualAmount) || 0;
      }
      return {
        groupName,
        plannedTotal: plannedTotal.toFixed(2),
        actualTotal: actualTotal.toFixed(2),
        lines: items,
      };
    });

    let incomeBudget = 0;
    let incomeActual = 0;
    let expenseBudget = 0;
    let expenseActual = 0;
    for (const l of responseLines) {
      const planned = parseFloat(l.plannedAmount) || 0;
      const actual = parseFloat(l.actualAmount) || 0;
      if (l.kind === "income") {
        incomeBudget += planned;
        incomeActual += actual;
      } else {
        expenseBudget += planned;
        expenseActual += actual;
      }
    }
    const pct = (n: number, d: number) =>
      d > 0 ? ((n / d) * 100).toFixed(1) : "0.0";

    const summary = {
      income: { budget: incomeBudget.toFixed(2), actual: incomeActual.toFixed(2) },
      expenses: { budget: expenseBudget.toFixed(2), actual: expenseActual.toFixed(2) },
      net: {
        budget: (incomeBudget - expenseBudget).toFixed(2),
        actual: (incomeActual - expenseActual).toFixed(2),
      },
      percentSpent: {
        budget: pct(expenseBudget, incomeBudget),
        actual: pct(expenseActual, incomeActual),
      },
    };

    res.json({
      monthStart,
      note: month?.note ?? null,
      lines: responseLines,
      groups,
      summary,
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
