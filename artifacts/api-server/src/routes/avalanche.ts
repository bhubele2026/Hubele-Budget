import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  avalancheSettingsTable,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
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

// System-managed budget category that mirrors the slider amount on the
// Avalanche page. Editing the planned amount on the budget reflects back
// into avalancheSettings.manualExtra.
export const AVALANCHE_PAYMENT_NAME = "Avalanche payment";
const AVALANCHE_PAYMENT_GROUP = "Avalanche — Extra to Highest APR";
const AVALANCHE_PAYMENT_LEGACY_NAME = "Avalanche extra";

// Ensures a single "Avalanche payment" expense category exists for the
// household in the Avalanche group, renames any legacy "Avalanche extra"
// row to it, and upserts that month's budget_lines row with planned =
// manualExtra. Idempotent and safe to call from any GET/PUT path.
//
// (#623) avalancheSettings is a singleton-per-household keyed on the
// owner's userId; budget_categories / budget_lines / budget_months are
// multi-row, scoped by household_id. Pass both so we can read the
// singleton AND filter the multi-row tables correctly. The actor user
// id is preserved on inserts for audit (`userId: ownerUserId`).
export async function syncAvalanchePaymentCategory(
  householdId: string,
  ownerUserId: string,
  monthStart: string,
): Promise<{ categoryId: string }> {
  const settings = await ensureSettings(householdId, ownerUserId);
  const manualExtra = settings.manualExtra ?? "0";

  // 1. Rename legacy "Avalanche extra" → "Avalanche payment" if present and
  //    the new name doesn't already exist (otherwise we'll merge below).
  const [legacy] = await db
    .select()
    .from(budgetCategoriesTable)
    .where(
      and(
        eq(budgetCategoriesTable.householdId, householdId),
        eq(budgetCategoriesTable.name, AVALANCHE_PAYMENT_LEGACY_NAME),
      ),
    );
  const [existing] = await db
    .select()
    .from(budgetCategoriesTable)
    .where(
      and(
        eq(budgetCategoriesTable.householdId, householdId),
        eq(budgetCategoriesTable.name, AVALANCHE_PAYMENT_NAME),
      ),
    );

  let catId: string;
  if (legacy && !existing) {
    const [renamed] = await db
      .update(budgetCategoriesTable)
      .set({
        name: AVALANCHE_PAYMENT_NAME,
        groupName: AVALANCHE_PAYMENT_GROUP,
        kind: "expense",
        sourceKind: "manual",
      })
      .where(eq(budgetCategoriesTable.id, legacy.id))
      .returning();
    catId = renamed!.id;
  } else if (existing) {
    catId = existing.id;
    if (legacy) {
      // Both rows exist (rare). Move budget_lines from legacy to the canonical
      // row, then drop the legacy row.
      const legacyLines = await db
        .select()
        .from(budgetLinesTable)
        .where(
          and(
            eq(budgetLinesTable.householdId, householdId),
            eq(budgetLinesTable.categoryId, legacy.id),
          ),
        );
      for (const ll of legacyLines) {
        await db
          .insert(budgetLinesTable)
          .values({
            userId: ownerUserId,
            householdId,
            monthStart: ll.monthStart,
            categoryId: catId,
            plannedAmount: ll.plannedAmount,
            note: ll.note,
          })
          .onConflictDoNothing({
            target: [
              budgetLinesTable.userId,
              budgetLinesTable.monthStart,
              budgetLinesTable.categoryId,
            ],
          });
      }
      await db
        .delete(budgetCategoriesTable)
        .where(eq(budgetCategoriesTable.id, legacy.id));
    }
    if (
      existing.groupName !== AVALANCHE_PAYMENT_GROUP ||
      existing.kind !== "expense" ||
      existing.sourceKind !== "manual"
    ) {
      await db
        .update(budgetCategoriesTable)
        .set({
          groupName: AVALANCHE_PAYMENT_GROUP,
          kind: "expense",
          sourceKind: "manual",
        })
        .where(eq(budgetCategoriesTable.id, catId));
    }
  } else {
    const [created] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: ownerUserId,
        householdId,
        name: AVALANCHE_PAYMENT_NAME,
        kind: "expense",
        groupName: AVALANCHE_PAYMENT_GROUP,
        sourceKind: "manual",
        sortOrder: 800,
      })
      .onConflictDoUpdate({
        target: [budgetCategoriesTable.userId, budgetCategoriesTable.name],
        set: {
          groupName: AVALANCHE_PAYMENT_GROUP,
          kind: "expense",
          sourceKind: "manual",
        },
      })
      .returning();
    catId = created!.id;
  }

  // 2. Ensure the budget month exists, then upsert the line for this month.
  await db
    .insert(budgetMonthsTable)
    .values({ userId: ownerUserId, householdId, monthStart })
    .onConflictDoNothing();
  await db
    .insert(budgetLinesTable)
    .values({
      userId: ownerUserId,
      householdId,
      monthStart,
      categoryId: catId,
      plannedAmount: manualExtra,
      note: "Managed by Avalanche planner",
    })
    .onConflictDoUpdate({
      target: [
        budgetLinesTable.userId,
        budgetLinesTable.monthStart,
        budgetLinesTable.categoryId,
      ],
      set: { plannedAmount: manualExtra, note: "Managed by Avalanche planner" },
    });

  return { categoryId: catId };
}

// Returns whether the given budget category is the system-managed
// "Avalanche payment" line for this household.
export async function isAvalanchePaymentCategory(
  householdId: string,
  categoryId: string,
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(budgetCategoriesTable)
    .where(
      and(
        eq(budgetCategoriesTable.id, categoryId),
        eq(budgetCategoriesTable.householdId, householdId),
        eq(budgetCategoriesTable.name, AVALANCHE_PAYMENT_NAME),
      ),
    );
  return !!row;
}

// (#623) Singleton-per-household: filter by the owner's userId (the PK)
// so every member of the household reads the same row. On insert we
// also stamp household_id so future household-keyed lookups work.
async function ensureSettings(householdId: string, ownerUserId: string) {
  const [row] = await db
    .select()
    .from(avalancheSettingsTable)
    .where(eq(avalancheSettingsTable.userId, ownerUserId));
  if (row) return row;
  // Upsert (not bare insert) — multiple in-flight requests for the same
  // fresh user can race past the SELECT and both attempt the INSERT,
  // colliding on the user_id PK. ON CONFLICT keeps the existing row and
  // returns it so both callers succeed.
  const [created] = await db
    .insert(avalancheSettingsTable)
    .values({ userId: ownerUserId, householdId, ...DEFAULTS })
    .onConflictDoUpdate({
      target: avalancheSettingsTable.userId,
      set: { updatedAt: new Date() },
    })
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

export async function resolveExtraForUser(
  householdId: string,
  ownerUserId: string,
) {
  const settings = await ensureSettings(householdId, ownerUserId);
  const monthStart = currentMonthStart();
  const monthEnd = monthEndStr(monthStart);
  const source = settings.extraSource ?? "manual";
  const mode = settings.budgetMode ?? "budgeted";

  // Headroom is computed for every source so the UI can always show the
  // "Room left in budget / Over budget by" indicator next to the slider.
  const headroom = await computeBudgetHeadroom(householdId, monthStart);

  if (source === "manual") {
    return {
      source: "manual" as const,
      amount: settings.manualExtra ?? "0",
      monthStart,
      availableMoney: headroom.availableMoney,
      plannedAvalanchePayment: headroom.plannedAvalanchePayment,
      plannedIncome: headroom.plannedIncome,
      plannedExpenses: headroom.plannedExpenses,
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
          eq(budgetCategoriesTable.householdId, householdId),
        ),
      );
    const [line] = await db
      .select()
      .from(budgetLinesTable)
      .where(
        and(
          eq(budgetLinesTable.householdId, householdId),
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
          eq(transactionsTable.householdId, householdId),
          eq(transactionsTable.categoryId, catId),
          sql`${transactionsTable.occurredOn} >= ${monthStart}`,
          sql`${transactionsTable.occurredOn} < ${monthEnd}`,
          // (#632 follow-up) External card payments — payments to a card
          // that is NOT in the household's avalanche (e.g. a spouse's
          // external card) — are excluded from avalanche actuals so
          // they never inflate the "extra" available for debt payoff.
          eq(transactionsTable.isExternalCardPayment, false),
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
        eq(budgetLinesTable.householdId, householdId),
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
          eq(budgetCategoriesTable.householdId, householdId),
        ),
      )
      .where(
        and(
          eq(transactionsTable.householdId, householdId),
          sql`${transactionsTable.occurredOn} >= ${monthStart}`,
          sql`${transactionsTable.occurredOn} < ${monthEnd}`,
          // (#632 follow-up) See per-category actual query above.
          eq(transactionsTable.isExternalCardPayment, false),
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
    availableMoney: headroom.availableMoney,
    plannedAvalanchePayment: headroom.plannedAvalanchePayment,
    plannedIncome: headroom.plannedIncome,
    plannedExpenses: headroom.plannedExpenses,
    breakdown: {
      income: income.toFixed(2),
      expenses: expenses.toFixed(2),
      plannedIncome: plannedIncome.toFixed(2),
      plannedExpenses: plannedExpenses.toFixed(2),
    },
  };
}

// "Headroom" available for the avalanche payment line for the given month.
// availableMoney = plannedIncome − (plannedExpenses − plannedAvalanchePayment).
// We exclude the avalanche payment itself from the expense side so the slider
// represents "everything else is already accounted for, here's how much room
// you have to throw at debt" rather than fighting itself.
async function computeBudgetHeadroom(householdId: string, monthStart: string) {
  const rows = await db
    .select({
      kind: budgetCategoriesTable.kind,
      name: budgetCategoriesTable.name,
      planned: sql<string>`coalesce(sum(${budgetLinesTable.plannedAmount})::text, '0')`,
    })
    .from(budgetLinesTable)
    .innerJoin(
      budgetCategoriesTable,
      eq(budgetLinesTable.categoryId, budgetCategoriesTable.id),
    )
    .where(
      and(
        eq(budgetLinesTable.householdId, householdId),
        eq(budgetLinesTable.monthStart, monthStart),
      ),
    )
    .groupBy(budgetCategoriesTable.kind, budgetCategoriesTable.name);

  let plannedIncome = 0;
  let plannedExpenses = 0;
  let plannedAvalanchePayment = 0;
  for (const r of rows) {
    const v = Number(r.planned) || 0;
    if (r.kind === "income") plannedIncome += v;
    else plannedExpenses += v;
    if (r.name === AVALANCHE_PAYMENT_NAME) plannedAvalanchePayment = v;
  }
  const availableMoney = Math.max(
    0,
    plannedIncome - (plannedExpenses - plannedAvalanchePayment),
  );
  return {
    availableMoney: availableMoney.toFixed(2),
    plannedIncome: plannedIncome.toFixed(2),
    plannedExpenses: plannedExpenses.toFixed(2),
    plannedAvalanchePayment: plannedAvalanchePayment.toFixed(2),
  };
}

router.get("/avalanche/extra", requireAuth, async (req, res): Promise<void> => {
  // Make sure the managed "Avalanche payment" budget line for this month
  // is in sync with manualExtra before we read budget headroom.
  const monthStart = currentMonthStart();
  await syncAvalanchePaymentCategory(
    req.householdId!,
    req.householdOwnerId!,
    monthStart,
  );
  const result = await resolveExtraForUser(
    req.householdId!,
    req.householdOwnerId!,
  );
  res.json(result);
});

router.get("/avalanche/settings", requireAuth, async (req, res): Promise<void> => {
  const row = await ensureSettings(req.householdId!, req.householdOwnerId!);
  res.json(present(row));
});

router.put("/avalanche/settings", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpdateAvalancheSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await ensureSettings(req.householdId!, req.householdOwnerId!);
  const [row] = await db
    .update(avalancheSettingsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(avalancheSettingsTable.userId, req.householdOwnerId!))
    .returning();
  // Mirror the new manualExtra into the managed budget line for this month.
  if (parsed.data.manualExtra !== undefined) {
    await syncAvalanchePaymentCategory(
      req.householdId!,
      req.householdOwnerId!,
      currentMonthStart(),
    );
  }
  res.json(present(row));
});

export default router;
