import { Router, type IRouter } from "express";
import { and, eq, sql, asc, desc, lt, inArray } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  debtsTable,
  mappingRulesTable,
  recurringItemsTable,
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
import {
  SEED_MAPPING_RULES,
  SEED_MAPPING_PRIORITY,
} from "../lib/mappingSeed";

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

      // Seed mapping rules. Idempotent on (userId, pattern) — we skip seeding
      // any pattern the user already has a rule for. Existing user-created
      // rules (including different categoryId mappings for the same pattern)
      // are left untouched so manual customizations survive re-seeds.
      const existingRules = await tx
        .select()
        .from(mappingRulesTable)
        .where(eq(mappingRulesTable.userId, userId));
      const existingPatterns = new Set(
        existingRules.map((r) => r.pattern.toLowerCase()),
      );
      let mappingRulesInserted = 0;
      for (const seed of SEED_MAPPING_RULES) {
        if (existingPatterns.has(seed.pattern.toLowerCase())) continue;
        const cat = byName.get(seed.categoryName);
        if (!cat) continue;
        await tx.insert(mappingRulesTable).values({
          userId,
          pattern: seed.pattern,
          matchType: "contains",
          categoryId: cat.id,
          priority: SEED_MAPPING_PRIORITY,
        });
        mappingRulesInserted++;
      }

      return {
        categoriesInserted,
        linesInserted,
        mappingRulesInserted,
        alreadySeeded:
          categoriesInserted === 0 &&
          linesInserted === 0 &&
          mappingRulesInserted === 0,
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

    let lines = await db
      .select()
      .from(budgetLinesTable)
      .where(
        and(
          eq(budgetLinesTable.userId, req.userId!),
          eq(budgetLinesTable.monthStart, monthStart),
        ),
      );

    // Carry-forward: if no lines exist yet for this month, copy the most recent
    // prior month's planned amounts and notes for manual categories. Auto-pulled
    // categories are skipped since their amounts derive from Bills/Debts.
    if (lines.length === 0) {
      const [prior] = await db
        .select({ monthStart: budgetLinesTable.monthStart })
        .from(budgetLinesTable)
        .where(
          and(
            eq(budgetLinesTable.userId, req.userId!),
            lt(budgetLinesTable.monthStart, monthStart),
          ),
        )
        .orderBy(desc(budgetLinesTable.monthStart))
        .limit(1);

      if (prior) {
        const manualCategoryIds = cats
          .filter((c) => c.sourceKind === "manual")
          .map((c) => c.id);

        if (manualCategoryIds.length > 0) {
          const priorLines = await db
            .select()
            .from(budgetLinesTable)
            .where(
              and(
                eq(budgetLinesTable.userId, req.userId!),
                eq(budgetLinesTable.monthStart, prior.monthStart),
                inArray(budgetLinesTable.categoryId, manualCategoryIds),
              ),
            );

          if (priorLines.length > 0) {
            await db
              .insert(budgetMonthsTable)
              .values({ userId: req.userId!, monthStart })
              .onConflictDoNothing();

            await db
              .insert(budgetLinesTable)
              .values(
                priorLines.map((l) => ({
                  userId: req.userId!,
                  monthStart,
                  categoryId: l.categoryId,
                  plannedAmount: l.plannedAmount,
                  note: l.note,
                })),
              )
              .onConflictDoNothing({
                target: [
                  budgetLinesTable.userId,
                  budgetLinesTable.monthStart,
                  budgetLinesTable.categoryId,
                ],
              });

            lines = await db
              .select()
              .from(budgetLinesTable)
              .where(
                and(
                  eq(budgetLinesTable.userId, req.userId!),
                  eq(budgetLinesTable.monthStart, monthStart),
                ),
              );
          }
        }
      }
    }

    // Source-derived planned amounts for auto categories. We compute these
    // on the fly from Bills (recurring_items) and Debts so they always reflect
    // the current source values, regardless of what (if anything) was carried
    // forward into this month's budget_lines.
    const FREQ_TO_MONTHLY: Record<string, number> = {
      monthly: 1,
      biweekly: 26 / 12,
      "bi-weekly": 26 / 12,
      weekly: 52 / 12,
      semimonthly: 2,
      "semi-monthly": 2,
      quarterly: 1 / 3,
      annually: 1 / 12,
      yearly: 1 / 12,
    };

    const autoBillsCatIds = cats
      .filter((c) => c.sourceKind === "auto_bills")
      .map((c) => c.id);
    const autoDebtCats = cats.filter((c) => c.sourceKind === "auto_debts");

    const autoPlannedByCat = new Map<string, string>();

    if (autoBillsCatIds.length > 0) {
      const recurring = await db
        .select()
        .from(recurringItemsTable)
        .where(
          and(
            eq(recurringItemsTable.userId, req.userId!),
            inArray(recurringItemsTable.categoryId, autoBillsCatIds),
          ),
        );
      const sums = new Map<string, number>();
      for (const r of recurring) {
        if (!r.categoryId) continue;
        if (r.active === "false") continue;
        const factor = FREQ_TO_MONTHLY[r.frequency.toLowerCase()] ?? 1;
        const monthly = (parseFloat(r.amount) || 0) * factor;
        sums.set(r.categoryId, (sums.get(r.categoryId) ?? 0) + monthly);
      }
      for (const [catId, total] of sums) {
        autoPlannedByCat.set(catId, total.toFixed(2));
      }
    }

    if (autoDebtCats.length > 0) {
      const debts = await db
        .select()
        .from(debtsTable)
        .where(eq(debtsTable.userId, req.userId!));
      const activeDebts = debts
        .filter((d) => d.status === "active")
        .sort((a, b) => b.name.length - a.name.length);
      for (const cat of autoDebtCats) {
        const match = activeDebts.find((d) => cat.name.includes(d.name));
        if (match) {
          autoPlannedByCat.set(cat.id, parseFloat(match.minPayment).toFixed(2));
        }
      }
    }

    const monthEnd = new Date(monthStart);
    monthEnd.setMonth(monthEnd.getMonth() + 1);
    const monthEndStr = monthEnd.toISOString().slice(0, 10);

    // Spend = sum of |amount| where amount < 0 for expense categories; income = sum positive.
    // Transfers (between user's own accounts) are excluded from both totals.
    // We also break down by source so the budget row can show "Bank" / "Amex"
    // counts derived from where each transaction came from.
    const actuals = await db
      .select({
        categoryId: transactionsTable.categoryId,
        source: transactionsTable.source,
        spend: sql<string>`coalesce(sum(case when ${transactionsTable.amount} < 0 then -${transactionsTable.amount} else 0 end)::text, '0')`,
        inflow: sql<string>`coalesce(sum(case when ${transactionsTable.amount} > 0 then ${transactionsTable.amount} else 0 end)::text, '0')`,
        cnt: sql<string>`count(*)::text`,
      })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, req.userId!),
          sql`${transactionsTable.occurredOn} >= ${monthStart}`,
          sql`${transactionsTable.occurredOn} < ${monthEndStr}`,
          eq(transactionsTable.isTransfer, false),
        ),
      )
      .groupBy(transactionsTable.categoryId, transactionsTable.source);

    type SourceBucket = { source: string; count: number; amount: number };
    const spendByCat = new Map<string, number>();
    const inflowByCat = new Map<string, number>();
    const breakdownByCat = new Map<string, SourceBucket[]>();
    for (const a of actuals) {
      if (!a.categoryId) continue;
      const spend = parseFloat(a.spend) || 0;
      const inflow = parseFloat(a.inflow) || 0;
      spendByCat.set(a.categoryId, (spendByCat.get(a.categoryId) ?? 0) + spend);
      inflowByCat.set(
        a.categoryId,
        (inflowByCat.get(a.categoryId) ?? 0) + inflow,
      );
      const arr = breakdownByCat.get(a.categoryId) ?? [];
      arr.push({
        source: a.source,
        count: parseInt(a.cnt, 10) || 0,
        amount: spend > 0 ? spend : inflow,
      });
      breakdownByCat.set(a.categoryId, arr);
    }
    const linesByCat = new Map(lines.map((l) => [l.categoryId, l]));

    const responseLines = cats.map((c) => {
      const line = linesByCat.get(c.id);
      const actualNum =
        c.kind === "income"
          ? inflowByCat.get(c.id) ?? 0
          : spendByCat.get(c.id) ?? 0;
      const derived = autoPlannedByCat.get(c.id);
      const plannedAmount =
        c.sourceKind !== "manual" && derived !== undefined
          ? derived
          : line?.plannedAmount ?? "0";
      const buckets = breakdownByCat.get(c.id) ?? [];
      // Collapse "plaid:bank", "plaid:capitalone", etc. into a single "Bank"
      // bucket; Amex stays as Amex; everything else (manual, import) groups
      // under "Other" so the badge row stays compact.
      type Label = "Bank" | "Amex" | "Other";
      const labelFor = (s: string): Label => {
        if (s === "amex") return "Amex";
        if (s.startsWith("plaid:amex")) return "Amex";
        if (s.startsWith("plaid:")) return "Bank";
        return "Other";
      };
      const grouped = new Map<Label, { count: number; amount: number }>();
      for (const b of buckets) {
        const k = labelFor(b.source);
        const cur = grouped.get(k) ?? { count: 0, amount: 0 };
        cur.count += b.count;
        cur.amount += b.amount;
        grouped.set(k, cur);
      }
      const sourceBreakdown = Array.from(grouped.entries()).map(
        ([label, v]) => ({
          source: label,
          count: v.count,
          amount: v.amount.toFixed(2),
        }),
      );
      return {
        id: line?.id ?? null,
        categoryId: c.id,
        categoryName: c.name,
        plannedAmount,
        actualAmount: actualNum.toFixed(2),
        note: line?.note ?? null,
        groupName: c.groupName,
        sourceKind: c.sourceKind,
        sortOrder: c.sortOrder,
        kind: c.kind,
        sourceBreakdown,
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
