import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  debtsTable,
  transactionsTable,
  recurringItemsTable,
  budgetCategoriesTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

router.get("/dashboard", requireAuth, async (req, res): Promise<void> => {
  const userId = req.userId!;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .slice(0, 10);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    .toISOString()
    .slice(0, 10);

  const [debtAgg] = await db
    .select({
      total: sql<string>`coalesce(sum(${debtsTable.balance})::text, '0')`,
      cnt: sql<number>`count(*)::int`,
    })
    .from(debtsTable)
    .where(eq(debtsTable.userId, userId));

  const [txAgg] = await db
    .select({
      income: sql<string>`coalesce(sum(case when ${transactionsTable.amount} > 0 then ${transactionsTable.amount} else 0 end)::text, '0')`,
      spend: sql<string>`coalesce(sum(case when ${transactionsTable.amount} < 0 then -${transactionsTable.amount} else 0 end)::text, '0')`,
      cnt: sql<number>`count(*)::int`,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        sql`${transactionsTable.occurredOn} >= ${monthStart}`,
        sql`${transactionsTable.occurredOn} < ${monthEnd}`,
      ),
    );

  const recent = await db
    .select()
    .from(transactionsTable)
    .where(eq(transactionsTable.userId, userId))
    .orderBy(desc(transactionsTable.occurredOn), desc(transactionsTable.createdAt))
    .limit(8);

  const topRows = await db
    .select({
      categoryId: transactionsTable.categoryId,
      categoryName: budgetCategoriesTable.name,
      total: sql<string>`coalesce(sum(case when ${transactionsTable.amount} < 0 then -${transactionsTable.amount} else 0 end)::text, '0')`,
    })
    .from(transactionsTable)
    .leftJoin(
      budgetCategoriesTable,
      eq(transactionsTable.categoryId, budgetCategoriesTable.id),
    )
    .where(
      and(
        eq(transactionsTable.userId, userId),
        sql`${transactionsTable.occurredOn} >= ${monthStart}`,
        sql`${transactionsTable.occurredOn} < ${monthEnd}`,
        sql`${transactionsTable.amount} < 0`,
      ),
    )
    .groupBy(transactionsTable.categoryId, budgetCategoriesTable.name)
    .orderBy(
      desc(
        sql`sum(case when ${transactionsTable.amount} < 0 then -${transactionsTable.amount} else 0 end)`,
      ),
    )
    .limit(5);

  const upcoming = await db
    .select()
    .from(recurringItemsTable)
    .where(
      and(
        eq(recurringItemsTable.userId, userId),
        eq(recurringItemsTable.active, "true"),
      ),
    )
    .orderBy(recurringItemsTable.dayOfMonth)
    .limit(8);

  const income = txAgg?.income ?? "0";
  const spend = txAgg?.spend ?? "0";
  const net = (Number(income) - Number(spend)).toFixed(2);

  res.json({
    totalDebt: debtAgg?.total ?? "0",
    monthlyIncome: income,
    monthlySpend: spend,
    netCashflow: net,
    debtCount: debtAgg?.cnt ?? 0,
    transactionCount: txAgg?.cnt ?? 0,
    recentTransactions: recent,
    topCategories: topRows.map((r) => ({
      categoryName: r.categoryName ?? "Uncategorized",
      total: r.total,
    })),
    upcomingBills: upcoming,
  });
});

export default router;
