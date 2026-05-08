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

// Ensures a single "Avalanche payment" expense category exists for the user
// in the Avalanche group, renames any legacy "Avalanche extra" row to it,
// and upserts that month's budget_lines row with planned = manualExtra.
// Idempotent and safe to call from any GET/PUT path.
export async function syncAvalanchePaymentCategory(
  userId: string,
  monthStart: string,
): Promise<{ categoryId: string | null }> {
  const settings = await ensureSettings(userId);
  const manualExtra = settings.manualExtra ?? "0";

  // (#duplication-cleanup) When the avalanche extra is sourced from an
  // existing budget category (the user picked a real category like
  // Misc/Buffer that already contains the money via its linked recurring
  // bills), there should be NO standalone "Avalanche payment" line — the
  // linked category IS the avalanche payment. Drop any orphan row from a
  // previous "manual" run so the same dollars stop being counted twice.
  if ((settings.extraSource ?? "manual") !== "manual") {
    const orphans = await db
      .select()
      .from(budgetCategoriesTable)
      .where(
        and(
          eq(budgetCategoriesTable.userId, userId),
          eq(budgetCategoriesTable.name, AVALANCHE_PAYMENT_NAME),
        ),
      );
    for (const o of orphans) {
      await db
        .delete(budgetLinesTable)
        .where(
          and(
            eq(budgetLinesTable.userId, userId),
            eq(budgetLinesTable.categoryId, o.id),
          ),
        );
      await db
        .delete(budgetCategoriesTable)
        .where(eq(budgetCategoriesTable.id, o.id));
    }
    return { categoryId: null };
  }

  // 1. Rename legacy "Avalanche extra" → "Avalanche payment" if present and
  //    the new name doesn't already exist (otherwise we'll merge below).
  const [legacy] = await db
    .select()
    .from(budgetCategoriesTable)
    .where(
      and(
        eq(budgetCategoriesTable.userId, userId),
        eq(budgetCategoriesTable.name, AVALANCHE_PAYMENT_LEGACY_NAME),
      ),
    );
  const [existing] = await db
    .select()
    .from(budgetCategoriesTable)
    .where(
      and(
        eq(budgetCategoriesTable.userId, userId),
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
            eq(budgetLinesTable.userId, userId),
            eq(budgetLinesTable.categoryId, legacy.id),
          ),
        );
      for (const ll of legacyLines) {
        await db
          .insert(budgetLinesTable)
          .values({
            userId,
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
        userId,
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
    .values({ userId, monthStart })
    .onConflictDoNothing();
  await db
    .insert(budgetLinesTable)
    .values({
      userId,
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

// (#duplication-cleanup) One-time per-user migration. If the user is
// still in extra_source="manual" mode AND there's an active recurring
// item rolled up into a manual budget category whose monthly contribution
// matches manualExtra (within $1), assume the user is *already* paying
// the avalanche extra via that bill and switch them to budget_line mode
// pointing at that category. The standalone "Avalanche payment" row will
// be cleaned up by the next syncAvalanchePaymentCategory() call (now a
// no-op for non-manual sources). Idempotent: re-running on a user already
// in budget_line mode is a no-op.
//
// Imports are inlined to avoid a circular dependency with budget.ts (which
// imports this module). expandItem comes from forecast.ts which is already
// imported elsewhere in the budget GET path; we re-import lazily.
export async function healAvalancheDuplication(
  userId: string,
  monthStart: string,
): Promise<{ migrated: boolean; toCategoryId?: string; toCategoryName?: string }> {
  const settings = await ensureSettings(userId);
  if ((settings.extraSource ?? "manual") !== "manual") {
    return { migrated: false };
  }
  const manualExtra = parseFloat(settings.manualExtra ?? "0");
  if (manualExtra <= 0) return { migrated: false };

  // Compute monthly contribution of every active recurring item linked to
  // a manual category for this month, then look for one that matches.
  const { recurringItemsTable, budgetCategoriesTable: bc } = await import(
    "@workspace/db"
  );
  const { expandItem } = await import("../lib/cashSignal");
  const monthEnd = new Date(monthStart);
  monthEnd.setMonth(monthEnd.getMonth() + 1);
  const monthFrom = new Date(monthStart);

  const items = await db
    .select()
    .from(recurringItemsTable)
    .where(eq(recurringItemsTable.userId, userId));
  const cats = await db
    .select()
    .from(bc)
    .where(eq(bc.userId, userId));
  const manualCatById = new Map(
    cats.filter((c) => c.sourceKind === "manual").map((c) => [c.id, c]),
  );
  let best: { catId: string; catName: string; total: number } | null = null;
  for (const it of items) {
    if (it.active === "false") continue;
    if (!it.categoryId || !manualCatById.has(it.categoryId)) continue;
    const events = expandItem(it, monthFrom, monthEnd);
    let total = 0;
    for (const ev of events) total += Math.abs(ev.amount);
    if (Math.abs(total - manualExtra) <= 1) {
      const cat = manualCatById.get(it.categoryId)!;
      best = { catId: it.categoryId, catName: cat.name, total };
      break;
    }
  }
  if (!best) return { migrated: false };

  await db
    .update(avalancheSettingsTable)
    .set({
      extraSource: "budget_line",
      extraBudgetCategoryId: best.catId,
      updatedAt: new Date(),
    })
    .where(eq(avalancheSettingsTable.userId, userId));
  // syncAvalanchePaymentCategory will now drop any orphan "Avalanche
  // payment" category for this user on its next call (the GET handler
  // calls it right after this heal).
  return {
    migrated: true,
    toCategoryId: best.catId,
    toCategoryName: best.catName,
  };
}

// Returns whether the given budget category is the system-managed
// "Avalanche payment" line.
export async function isAvalanchePaymentCategory(
  userId: string,
  categoryId: string,
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(budgetCategoriesTable)
    .where(
      and(
        eq(budgetCategoriesTable.id, categoryId),
        eq(budgetCategoriesTable.userId, userId),
        eq(budgetCategoriesTable.name, AVALANCHE_PAYMENT_NAME),
      ),
    );
  return !!row;
}

async function ensureSettings(userId: string) {
  const [row] = await db
    .select()
    .from(avalancheSettingsTable)
    .where(eq(avalancheSettingsTable.userId, userId));
  if (row) return row;
  // Upsert (not bare insert) — multiple in-flight requests for the same
  // fresh user can race past the SELECT and both attempt the INSERT,
  // colliding on the user_id PK. ON CONFLICT keeps the existing row and
  // returns it so both callers succeed.
  const [created] = await db
    .insert(avalancheSettingsTable)
    .values({ userId, ...DEFAULTS })
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

export async function resolveExtraForUser(userId: string) {
  const settings = await ensureSettings(userId);
  const monthStart = currentMonthStart();
  const monthEnd = monthEndStr(monthStart);
  const source = settings.extraSource ?? "manual";
  const mode = settings.budgetMode ?? "budgeted";

  // Headroom is computed for every source so the UI can always show the
  // "Room left in budget / Over budget by" indicator next to the slider.
  const headroom = await computeBudgetHeadroom(userId, monthStart);

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
async function computeBudgetHeadroom(userId: string, monthStart: string) {
  const settings = await ensureSettings(userId);
  const linkedExtraCatId =
    (settings.extraSource ?? "manual") === "budget_line"
      ? settings.extraBudgetCategoryId
      : null;

  const rows = await db
    .select({
      kind: budgetCategoriesTable.kind,
      name: budgetCategoriesTable.name,
      categoryId: budgetCategoriesTable.id,
      planned: sql<string>`coalesce(sum(${budgetLinesTable.plannedAmount})::text, '0')`,
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
    .groupBy(
      budgetCategoriesTable.kind,
      budgetCategoriesTable.name,
      budgetCategoriesTable.id,
    );

  let plannedIncome = 0;
  let plannedExpenses = 0;
  let plannedAvalanchePayment = 0;
  for (const r of rows) {
    const v = Number(r.planned) || 0;
    if (r.kind === "income") plannedIncome += v;
    // (#duplication-cleanup) When the avalanche extra IS the user's linked
    // budget category (budget_line mode), treat that category's planned
    // amount as the avalanche payment so headroom math doesn't double-
    // count it against itself. Same effect as the standalone Avalanche
    // payment row in manual mode.
    else if (r.categoryId === linkedExtraCatId) {
      plannedExpenses += v;
      plannedAvalanchePayment = v;
      continue;
    }
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
  await syncAvalanchePaymentCategory(req.userId!, monthStart);
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
  // Mirror the new manualExtra into the managed budget line for this month.
  if (parsed.data.manualExtra !== undefined) {
    await syncAvalanchePaymentCategory(req.userId!, currentMonthStart());
  }
  res.json(present(row));
});

export default router;
