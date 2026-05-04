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
import { findMatchedRuleId, loadUserRules } from "../lib/autoCategorize";

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
      activeCnt: sql<number>`coalesce(sum(case when ${debtsTable.status} = 'active' then 1 else 0 end), 0)::int`,
      activeBalance: sql<string>`coalesce(sum(case when ${debtsTable.status} = 'active' then ${debtsTable.balance} else 0 end)::text, '0')`,
    })
    .from(debtsTable)
    .where(eq(debtsTable.userId, userId));

  // A transaction counts toward debt-paid totals via two paths:
  //   (a) Canonical: `transactions.debt_id` is non-null. This is set by
  //       POST /debts/:id/payments, by /transactions POST/PATCH, and by
  //       Plaid sync for true payments on linked liability accounts. It is
  //       sign-agnostic and counts as `abs(amount)`.
  //   (b) Legacy fallback: outflow rows (amount < 0) categorized as
  //       'auto_debts' OR with description starting "Payment — ". These are
  //       funding-side rows that pre-date the debt_id link or come from
  //       accounts whose liability isn't Plaid-linked.
  //
  // De-dup rule (avoids double-counting when both sides of a payment are
  // imported via Plaid): a legacy row is suppressed if a debt_id-tagged
  // counterpart with the opposite sign and the same |amount| (within $0.01)
  // exists for the same user within ±3 days. This keeps the totals at "one
  // payment counted once" even when Plaid imports both the funding-account
  // outflow and the liability-account inflow.
  const legacyMatch = sql`(
    ${transactionsTable.debtId} is null
    and ${transactionsTable.amount} < 0
    and (
      ${budgetCategoriesTable.sourceKind} = 'auto_debts'
      or ${transactionsTable.description} like 'Payment — %'
    )
    and not exists (
      select 1 from ${transactionsTable} t2
      where t2.user_id = ${transactionsTable.userId}
        and t2.debt_id is not null
        and t2.amount > 0
        and abs(t2.amount + ${transactionsTable.amount}) < 0.01
        and abs(t2.occurred_on - ${transactionsTable.occurredOn}) <= 3
    )
  )`;
  const [paidAgg] = await db
    .select({
      paidThisMonth: sql<string>`coalesce(sum(
        case
          when ${transactionsTable.occurredOn} >= ${monthStart}
           and ${transactionsTable.occurredOn} < ${monthEnd}
          then
            case
              when ${transactionsTable.debtId} is not null then abs(${transactionsTable.amount})
              when ${legacyMatch} then -${transactionsTable.amount}
              else 0
            end
          else 0
        end
      )::text, '0')`,
      paidLifetime: sql<string>`coalesce(sum(
        case
          when ${transactionsTable.debtId} is not null then abs(${transactionsTable.amount})
          when ${legacyMatch} then -${transactionsTable.amount}
          else 0
        end
      )::text, '0')`,
    })
    .from(transactionsTable)
    .leftJoin(
      budgetCategoriesTable,
      eq(transactionsTable.categoryId, budgetCategoriesTable.id),
    )
    .where(
      and(
        eq(transactionsTable.userId, userId),
        sql`(
          ${transactionsTable.debtId} is not null
          or ${budgetCategoriesTable.sourceKind} = 'auto_debts'
          or ${transactionsTable.description} like 'Payment — %'
        )`,
      ),
    );

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

  // Annotate each row with the mapping rule that auto-categorize would
  // currently attribute, mirroring GET /transactions, so the Dashboard's
  // recent-activity widget can render the same MatchedRuleChip
  // ("rule: <pattern> · jump to it" / "manually categorized") as the
  // Transactions and Amex pages. Computed lazily per response rather
  // than persisted on the row so editing a rule's pattern reflects on
  // every existing transaction without a backfill.
  const userRules = await loadUserRules(userId);
  const recentAnnotated = recent.map((r) => ({
    ...r,
    matchedRuleId: findMatchedRuleId(r.description, r.categoryId, userRules),
  }));

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
    totalDebt: debtAgg?.activeBalance ?? "0",
    monthlyIncome: income,
    monthlySpend: spend,
    netCashflow: net,
    debtCount: debtAgg?.cnt ?? 0,
    activeDebtCount: debtAgg?.activeCnt ?? 0,
    paidThisMonth: paidAgg?.paidThisMonth ?? "0",
    paidLifetime: paidAgg?.paidLifetime ?? "0",
    transactionCount: txAgg?.cnt ?? 0,
    recentTransactions: recentAnnotated,
    topCategories: topRows.map((r) => ({
      categoryName: r.categoryName ?? "Uncategorized",
      total: r.total,
    })),
    upcomingBills: upcoming,
  });
});

export default router;
