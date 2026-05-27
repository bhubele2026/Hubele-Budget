import { z } from "zod";
import { and, desc, eq, gte, ilike, inArray, lte, sql } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  debtsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import { registerTool } from "./advisorTools";
import { expandItem, parseISO } from "./cashSignal";

// ---------------------------------------------------------------------------
// Helpers shared across read tools
// ---------------------------------------------------------------------------

// Resolve "this month" / "last month" / "YTD" / explicit ISO ranges into
// a {start, end} ISO date pair. End is exclusive.
function resolvePeriod(period: string): { start: string; end: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  function iso(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  }

  const lower = period.toLowerCase().trim();
  if (lower === "this_month" || lower === "current_month") {
    return { start: iso(new Date(y, m, 1)), end: iso(new Date(y, m + 1, 1)) };
  }
  if (lower === "last_month" || lower === "previous_month") {
    return { start: iso(new Date(y, m - 1, 1)), end: iso(new Date(y, m, 1)) };
  }
  if (lower === "ytd" || lower === "year_to_date") {
    return { start: iso(new Date(y, 0, 1)), end: iso(new Date(y, m + 1, 1)) };
  }
  if (lower === "last_30_days" || lower === "last_30d") {
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    return { start: iso(start), end: iso(new Date(y, m, now.getDate() + 1)) };
  }
  if (lower === "last_90_days" || lower === "last_90d") {
    const start = new Date(now);
    start.setDate(start.getDate() - 90);
    return { start: iso(start), end: iso(new Date(y, m, now.getDate() + 1)) };
  }
  // Try parsing an explicit "YYYY-MM-DD..YYYY-MM-DD" range.
  const rangeMatch = lower.match(/^(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})$/);
  if (rangeMatch) {
    return { start: rangeMatch[1], end: rangeMatch[2] };
  }
  // Try parsing "YYYY-MM" as a single month.
  const monthMatch = lower.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) {
    const year = Number(monthMatch[1]);
    const month = Number(monthMatch[2]) - 1;
    return { start: iso(new Date(year, month, 1)), end: iso(new Date(year, month + 1, 1)) };
  }
  // Fallback to this month.
  return { start: iso(new Date(y, m, 1)), end: iso(new Date(y, m + 1, 1)) };
}

// ---------------------------------------------------------------------------
// Tool: query_transactions
// ---------------------------------------------------------------------------

const queryTransactionsInput = z.object({
  period: z
    .string()
    .optional()
    .describe(
      "Period to query. Accepts: 'this_month', 'last_month', 'ytd', 'last_30_days', 'last_90_days', 'YYYY-MM' (single month), or 'YYYY-MM-DD..YYYY-MM-DD' (explicit range). Defaults to 'this_month'.",
    ),
  categoryName: z
    .string()
    .optional()
    .describe("Filter to one category by name (case-insensitive substring match)."),
  descriptionContains: z
    .string()
    .optional()
    .describe("Filter to transactions whose description contains this text (case-insensitive)."),
  minAmount: z
    .number()
    .optional()
    .describe("Only return transactions whose absolute amount is >= this value."),
  expensesOnly: z
    .boolean()
    .optional()
    .describe("If true, only return outflows (negative amounts)."),
  limit: z.number().int().min(1).max(100).optional().describe("Max rows to return (default 25)."),
});

registerTool({
  name: "query_transactions",
  description:
    "Query transactions with flexible filters. Returns at most 100 rows. Use when the user asks about specific transactions, spending in a category, or wants to see a list. For an aggregate total over a period+category use get_category_spend instead — it's cheaper.",
  riskTier: "read",
  inputSchema: queryTransactionsInput,
  jsonSchema: {
    type: "object",
    properties: {
      period: {
        type: "string",
        description:
          "Period to query. Accepts: 'this_month', 'last_month', 'ytd', 'last_30_days', 'last_90_days', 'YYYY-MM', or 'YYYY-MM-DD..YYYY-MM-DD'. Defaults to 'this_month'.",
      },
      categoryName: { type: "string" },
      descriptionContains: { type: "string" },
      minAmount: { type: "number" },
      expensesOnly: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const { start, end } = resolvePeriod(input.period ?? "this_month");
    const limit = input.limit ?? 25;
    const conds = [
      eq(transactionsTable.householdId, ctx.householdId),
      gte(transactionsTable.occurredOn, start),
      lte(transactionsTable.occurredOn, end),
    ];
    if (input.expensesOnly) conds.push(sql`${transactionsTable.amount} < 0`);
    if (input.minAmount != null) {
      conds.push(sql`abs(${transactionsTable.amount}) >= ${input.minAmount}`);
    }
    if (input.descriptionContains) {
      conds.push(ilike(transactionsTable.description, `%${input.descriptionContains}%`));
    }

    let rows = await db
      .select({
        date: transactionsTable.occurredOn,
        description: transactionsTable.description,
        amount: transactionsTable.amount,
        categoryName: budgetCategoriesTable.name,
      })
      .from(transactionsTable)
      .leftJoin(
        budgetCategoriesTable,
        eq(transactionsTable.categoryId, budgetCategoriesTable.id),
      )
      .where(and(...conds))
      .orderBy(desc(transactionsTable.occurredOn))
      .limit(limit + 1);

    // Filter by category name in-memory (case-insensitive substring) so the
    // model can pass partial matches without us having to handle the join
    // condition in SQL with ilike on the join target.
    if (input.categoryName) {
      const needle = input.categoryName.toLowerCase();
      rows = rows.filter((r) => r.categoryName?.toLowerCase().includes(needle));
    }

    const truncated = rows.length > limit;
    const out = rows.slice(0, limit).map((r) => ({
      date: r.date,
      description: r.description,
      amount: Number(r.amount),
      category: r.categoryName,
    }));

    return {
      result: {
        period: { start, end },
        count: out.length,
        truncated,
        transactions: out,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Tool: get_category_spend
// ---------------------------------------------------------------------------

const getCategorySpendInput = z.object({
  period: z
    .string()
    .optional()
    .describe("Same period syntax as query_transactions. Defaults to 'this_month'."),
  categoryName: z
    .string()
    .optional()
    .describe(
      "Single category to focus on (case-insensitive substring). If omitted, returns totals for ALL categories sorted by spend.",
    ),
  topN: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("When categoryName is omitted, how many top categories to return (default 15)."),
});

registerTool({
  name: "get_category_spend",
  description:
    "Aggregate spending by category over a period. Returns total spent and count of transactions per category. Cheaper than query_transactions when the user wants totals, not a listing.",
  riskTier: "read",
  inputSchema: getCategorySpendInput,
  jsonSchema: {
    type: "object",
    properties: {
      period: { type: "string" },
      categoryName: { type: "string" },
      topN: { type: "integer", minimum: 1, maximum: 50 },
    },
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const { start, end } = resolvePeriod(input.period ?? "this_month");
    const rows = await db
      .select({
        categoryName: budgetCategoriesTable.name,
        total: sql<string>`coalesce(sum(case when ${transactionsTable.amount} < 0 then -${transactionsTable.amount} else 0 end)::text, '0')`,
        income: sql<string>`coalesce(sum(case when ${transactionsTable.amount} > 0 then ${transactionsTable.amount} else 0 end)::text, '0')`,
        cnt: sql<number>`count(*)::int`,
      })
      .from(transactionsTable)
      .leftJoin(
        budgetCategoriesTable,
        eq(transactionsTable.categoryId, budgetCategoriesTable.id),
      )
      .where(
        and(
          eq(transactionsTable.householdId, ctx.householdId),
          gte(transactionsTable.occurredOn, start),
          lte(transactionsTable.occurredOn, end),
        ),
      )
      .groupBy(budgetCategoriesTable.name)
      .orderBy(
        desc(
          sql`sum(case when ${transactionsTable.amount} < 0 then -${transactionsTable.amount} else 0 end)`,
        ),
      );

    let filtered = rows;
    if (input.categoryName) {
      const needle = input.categoryName.toLowerCase();
      filtered = rows.filter((r) =>
        (r.categoryName ?? "Uncategorized").toLowerCase().includes(needle),
      );
    } else {
      filtered = rows.slice(0, input.topN ?? 15);
    }

    return {
      result: {
        period: { start, end },
        categories: filtered.map((r) => ({
          category: r.categoryName ?? "Uncategorized",
          spent: Number(r.total),
          income: Number(r.income),
          transactionCount: r.cnt,
        })),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Tool: compare_months
// ---------------------------------------------------------------------------

const compareMonthsInput = z.object({
  monthA: z.string().describe("First month, format 'YYYY-MM' (e.g. '2026-04')."),
  monthB: z.string().describe("Second month, format 'YYYY-MM' (e.g. '2026-05')."),
  categoryName: z
    .string()
    .optional()
    .describe("If set, only compare this one category. Otherwise compares all."),
});

registerTool({
  name: "compare_months",
  description:
    "Side-by-side category comparison between two months. Returns spend in month A, spend in month B, and the delta for each category. Use for 'how does X compare to last month' questions.",
  riskTier: "read",
  inputSchema: compareMonthsInput,
  jsonSchema: {
    type: "object",
    properties: {
      monthA: { type: "string", pattern: "^\\d{4}-\\d{2}$" },
      monthB: { type: "string", pattern: "^\\d{4}-\\d{2}$" },
      categoryName: { type: "string" },
    },
    required: ["monthA", "monthB"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    async function totalsForMonth(month: string) {
      const { start, end } = resolvePeriod(month);
      const rows = await db
        .select({
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
            eq(transactionsTable.householdId, ctx.householdId),
            gte(transactionsTable.occurredOn, start),
            lte(transactionsTable.occurredOn, end),
          ),
        )
        .groupBy(budgetCategoriesTable.name);
      const map = new Map<string, number>();
      for (const r of rows) {
        map.set(r.categoryName ?? "Uncategorized", Number(r.total));
      }
      return map;
    }

    const [a, b] = await Promise.all([
      totalsForMonth(input.monthA),
      totalsForMonth(input.monthB),
    ]);
    const allCategories = new Set<string>([...a.keys(), ...b.keys()]);
    let comparisons = Array.from(allCategories).map((cat) => {
      const av = a.get(cat) ?? 0;
      const bv = b.get(cat) ?? 0;
      return {
        category: cat,
        monthA: av,
        monthB: bv,
        delta: Math.round((bv - av) * 100) / 100,
        pctChange: av > 0 ? Math.round(((bv - av) / av) * 100) : null,
      };
    });
    if (input.categoryName) {
      const needle = input.categoryName.toLowerCase();
      comparisons = comparisons.filter((c) => c.category.toLowerCase().includes(needle));
    }
    comparisons.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

    return {
      result: {
        monthA: input.monthA,
        monthB: input.monthB,
        comparisons,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Tool: get_debt_summary
// ---------------------------------------------------------------------------

const getDebtSummaryInput = z.object({
  debtName: z
    .string()
    .optional()
    .describe("If set, return only this debt (case-insensitive substring match). Otherwise all active debts."),
  includeArchived: z
    .boolean()
    .optional()
    .describe("Include archived/paid-off debts. Default false."),
});

registerTool({
  name: "get_debt_summary",
  description:
    "Detailed snapshot of debts: balance, APR, minimum payment, paid this month, paid lifetime, and a months-to-payoff estimate at the current minimum payment. Use for debt strategy questions.",
  riskTier: "read",
  inputSchema: getDebtSummaryInput,
  jsonSchema: {
    type: "object",
    properties: {
      debtName: { type: "string" },
      includeArchived: { type: "boolean" },
    },
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const conds = [eq(debtsTable.householdId, ctx.householdId)];
    if (!input.includeArchived) conds.push(eq(debtsTable.status, "active"));
    const debts = await db
      .select()
      .from(debtsTable)
      .where(and(...conds))
      .orderBy(desc(debtsTable.apr));
    const debtIds = debts.map((d) => d.id);

    // Paid lifetime + paid this month per debt
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const paidRows =
      debtIds.length > 0
        ? await db
            .select({
              debtId: transactionsTable.debtId,
              paidLifetime: sql<string>`coalesce(sum(abs(${transactionsTable.amount}))::text, '0')`,
              paidThisMonth: sql<string>`coalesce(sum(case when ${transactionsTable.occurredOn} >= ${monthStart} then abs(${transactionsTable.amount}) else 0 end)::text, '0')`,
            })
            .from(transactionsTable)
            .where(
              and(
                eq(transactionsTable.householdId, ctx.householdId),
                inArray(transactionsTable.debtId, debtIds),
              ),
            )
            .groupBy(transactionsTable.debtId)
        : [];
    const paidMap = new Map(
      paidRows.map((r) => [
        r.debtId,
        { paidLifetime: Number(r.paidLifetime), paidThisMonth: Number(r.paidThisMonth) },
      ]),
    );

    let out = debts.map((d) => {
      const balance = Number(d.balance);
      const apr = Number(d.apr);
      const minPayment = Number(d.minPayment ?? "0");
      const paid = paidMap.get(d.id) ?? { paidLifetime: 0, paidThisMonth: 0 };
      // Naive months-to-payoff at current min payment, assuming APR is annual.
      // monthsToPayoff = -log(1 - r*B/P) / log(1+r)  where r = apr/12, P = monthly payment
      let monthsToPayoff: number | null = null;
      if (minPayment > 0 && balance > 0) {
        const r = apr / 12;
        if (r === 0) {
          monthsToPayoff = Math.ceil(balance / minPayment);
        } else if (minPayment > r * balance) {
          monthsToPayoff = Math.ceil(
            -Math.log(1 - (r * balance) / minPayment) / Math.log(1 + r),
          );
        } else {
          monthsToPayoff = -1; // payment doesn't cover interest
        }
      }
      return {
        name: d.name,
        balance,
        apr,
        aprPct: Math.round(apr * 10000) / 100,
        minPayment,
        paidThisMonth: paid.paidThisMonth,
        paidLifetime: paid.paidLifetime,
        status: d.status,
        monthsToPayoffAtMin: monthsToPayoff,
        underwater: monthsToPayoff === -1,
      };
    });

    if (input.debtName) {
      const needle = input.debtName.toLowerCase();
      out = out.filter((d) => d.name.toLowerCase().includes(needle));
    }

    return {
      result: {
        count: out.length,
        totalBalance: Math.round(out.reduce((s, d) => s + d.balance, 0) * 100) / 100,
        totalMinPayments: Math.round(out.reduce((s, d) => s + d.minPayment, 0) * 100) / 100,
        debts: out,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Tool: find_transactions_matching
// ---------------------------------------------------------------------------

const findTransactionsMatchingInput = z.object({
  query: z
    .string()
    .min(2)
    .describe("Text to search for in transaction descriptions (case-insensitive)."),
  monthsBack: z
    .number()
    .int()
    .min(1)
    .max(24)
    .optional()
    .describe("How many months back to search. Default 12."),
  limit: z.number().int().min(1).max(100).optional().describe("Max rows. Default 50."),
});

registerTool({
  name: "find_transactions_matching",
  description:
    "Fuzzy search transaction descriptions across the last N months. Use when the user asks something like 'how much did we spend at Amazon' or 'find all the Costco trips'.",
  riskTier: "read",
  inputSchema: findTransactionsMatchingInput,
  jsonSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 2 },
      monthsBack: { type: "integer", minimum: 1, maximum: 24 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const monthsBack = input.monthsBack ?? 12;
    const limit = input.limit ?? 50;
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
    const startISO = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(
      2,
      "0",
    )}-01`;

    const rows = await db
      .select({
        date: transactionsTable.occurredOn,
        description: transactionsTable.description,
        amount: transactionsTable.amount,
        categoryName: budgetCategoriesTable.name,
      })
      .from(transactionsTable)
      .leftJoin(
        budgetCategoriesTable,
        eq(transactionsTable.categoryId, budgetCategoriesTable.id),
      )
      .where(
        and(
          eq(transactionsTable.householdId, ctx.householdId),
          gte(transactionsTable.occurredOn, startISO),
          ilike(transactionsTable.description, `%${input.query}%`),
        ),
      )
      .orderBy(desc(transactionsTable.occurredOn))
      .limit(limit + 1);

    const truncated = rows.length > limit;
    const matches = rows.slice(0, limit).map((r) => ({
      date: r.date,
      description: r.description,
      amount: Number(r.amount),
      category: r.categoryName,
    }));

    const totalSpend = matches
      .filter((m) => m.amount < 0)
      .reduce((s, m) => s + -m.amount, 0);
    const totalIncome = matches
      .filter((m) => m.amount > 0)
      .reduce((s, m) => s + m.amount, 0);

    return {
      result: {
        query: input.query,
        monthsBack,
        count: matches.length,
        truncated,
        totalSpend: Math.round(totalSpend * 100) / 100,
        totalIncome: Math.round(totalIncome * 100) / 100,
        matches,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Tool: get_recurring_schedule
// ---------------------------------------------------------------------------

const getRecurringScheduleInput = z.object({
  daysAhead: z
    .number()
    .int()
    .min(1)
    .max(180)
    .optional()
    .describe("How many days forward to project. Default 30."),
  kind: z
    .enum(["income", "expense", "all"])
    .optional()
    .describe("Filter to income, expense, or all. Default all."),
});

registerTool({
  name: "get_recurring_schedule",
  description:
    "List recurring items (bills, paychecks, subscriptions) scheduled to hit in the next N days, with their dates and amounts. Use for cashflow planning questions.",
  riskTier: "read",
  inputSchema: getRecurringScheduleInput,
  jsonSchema: {
    type: "object",
    properties: {
      daysAhead: { type: "integer", minimum: 1, maximum: 180 },
      kind: { type: "string", enum: ["income", "expense", "all"] },
    },
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const daysAhead = input.daysAhead ?? 30;
    const kindFilter = input.kind ?? "all";
    const items = await db
      .select()
      .from(recurringItemsTable)
      .where(
        and(
          eq(recurringItemsTable.householdId, ctx.householdId),
          eq(recurringItemsTable.active, "true"),
        ),
      );

    const today = new Date();
    const from = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const to = new Date(from);
    to.setDate(to.getDate() + daysAhead);

    const events: Array<{
      date: string;
      label: string;
      amount: number;
      kind: "income" | "expense";
      itemId: string;
    }> = [];
    for (const item of items) {
      if (kindFilter === "income" && item.kind !== "income") continue;
      if (kindFilter === "expense" && item.kind === "income") continue;
      const expanded = expandItem(item, from, to);
      for (const e of expanded) events.push(e);
    }
    events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const totalIncome = events
      .filter((e) => e.kind === "income")
      .reduce((s, e) => s + e.amount, 0);
    const totalExpense = events
      .filter((e) => e.kind === "expense")
      .reduce((s, e) => s + -e.amount, 0);

    return {
      result: {
        daysAhead,
        count: events.length,
        totalIncome: Math.round(totalIncome * 100) / 100,
        totalExpense: Math.round(totalExpense * 100) / 100,
        net: Math.round((totalIncome - totalExpense) * 100) / 100,
        events,
      },
    };
  },
});
