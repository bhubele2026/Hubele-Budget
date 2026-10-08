import { and, asc, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  debtsTable,
  transactionsTable,
} from "@workspace/db";
import { SEED_GROUP_ORDER } from "./budgetSeed";
import { householdTodayISO } from "./householdClock";
import { logger } from "./logger";

// (PR-E) Moved out of routes/budget.ts so a WRITE can run it. It used to run on
// every `GET /budget/months/:monthStart`, which made a read change rows.
// Callers now: the debt write paths (POST/PATCH/DELETE /debts, sync-minimums,
// link, payments), the Plaid liabilities refresh, the budget write routes, and
// the nightly `metrics.snapshot` job.

export const DEBT_GROUP = "Debt — Minimum Payments";
const DEBT_GROUP_BASE_SORT =
  (SEED_GROUP_ORDER.indexOf(DEBT_GROUP) >= 0
    ? SEED_GROUP_ORDER.indexOf(DEBT_GROUP)
    : 99) * 100;

// Keep budget_categories with sourceKind='auto_debts' in sync with the user's
// active rows in the Debts tracker, and keep the budget line for each one
// updated to the debt's current minimum payment for the requested month.
// Also backfills `category_id` on existing "Payment — <debt name>" transactions
// so the budget's Actual column reflects payments made to each debt.
export async function syncAutoDebtCategories(
  householdId: string,
  userId: string,
  monthStart: string,
): Promise<void> {
  const debts = await db
    .select()
    .from(debtsTable)
    .where(
      and(eq(debtsTable.householdId, householdId), eq(debtsTable.status, "active")),
    )
    .orderBy(desc(debtsTable.apr), asc(debtsTable.name));

  const activeIds = debts.map((d) => d.id);

  // 1. Drop stale auto_debts categories: legacy placeholder/seed rows with no
  //    debt link, plus any whose linked debt is no longer active/exists.
  await db
    .delete(budgetCategoriesTable)
    .where(
      and(
        eq(budgetCategoriesTable.householdId, householdId),
        eq(budgetCategoriesTable.sourceKind, "auto_debts"),
        isNull(budgetCategoriesTable.debtId),
      ),
    );
  if (activeIds.length > 0) {
    await db
      .delete(budgetCategoriesTable)
      .where(
        and(
          eq(budgetCategoriesTable.householdId, householdId),
          eq(budgetCategoriesTable.sourceKind, "auto_debts"),
          notInArray(budgetCategoriesTable.debtId, activeIds),
        ),
      );
  } else {
    await db
      .delete(budgetCategoriesTable)
      .where(
        and(
          eq(budgetCategoriesTable.householdId, householdId),
          eq(budgetCategoriesTable.sourceKind, "auto_debts"),
        ),
      );
  }

  if (debts.length === 0) return;

  // 2. Ensure the budget month row exists so we can attach lines to it.
  await db
    .insert(budgetMonthsTable)
    .values({ userId, householdId, monthStart })
    .onConflictDoNothing();

  // 3. Upsert one auto_debts category per active debt and the matching line
  //    for the requested month with planned = debt.minPayment.
  const existingCats = await db
    .select()
    .from(budgetCategoriesTable)
    .where(
      and(
        eq(budgetCategoriesTable.householdId, householdId),
        eq(budgetCategoriesTable.sourceKind, "auto_debts"),
      ),
    );
  const catByDebtId = new Map(existingCats.map((c) => [c.debtId!, c]));

  for (let i = 0; i < debts.length; i++) {
    const d = debts[i]!;
    const sortOrder = DEBT_GROUP_BASE_SORT + i;
    let catId: string;
    const cur = catByDebtId.get(d.id);
    if (!cur) {
      const [row] = await db
        .insert(budgetCategoriesTable)
        .values({
          userId,
          householdId,
          name: d.name,
          kind: "expense",
          groupName: DEBT_GROUP,
          sourceKind: "auto_debts",
          sortOrder,
          debtId: d.id,
        })
        .onConflictDoNothing({
          target: [budgetCategoriesTable.householdId, budgetCategoriesTable.debtId],
        })
        .returning();
      if (!row) {
        // Re-read in case of a concurrent insert.
        const [existing] = await db
          .select()
          .from(budgetCategoriesTable)
          .where(
            and(
              eq(budgetCategoriesTable.householdId, householdId),
              eq(budgetCategoriesTable.debtId, d.id),
            ),
          );
        if (!existing) continue;
        catId = existing.id;
      } else {
        catId = row.id;
      }
    } else {
      catId = cur.id;
      if (
        cur.name !== d.name ||
        cur.sortOrder !== sortOrder ||
        cur.groupName !== DEBT_GROUP ||
        cur.kind !== "expense"
      ) {
        await db
          .update(budgetCategoriesTable)
          .set({
            name: d.name,
            sortOrder,
            groupName: DEBT_GROUP,
            kind: "expense",
          })
          .where(eq(budgetCategoriesTable.id, cur.id));
      }
    }

    await db
      .insert(budgetLinesTable)
      .values({
        userId,
        householdId,
        monthStart,
        categoryId: catId,
        plannedAmount: d.minPayment,
        note: "Auto-pulled from Debt Tracker",
      })
      .onConflictDoUpdate({
        target: [
          budgetLinesTable.householdId,
          budgetLinesTable.monthStart,
          budgetLinesTable.categoryId,
        ],
        set: { plannedAmount: d.minPayment },
      });

    // Backfill categoryId on payment transactions created by /debts/:id/payments
    // so the budget's Actual column shows what's been paid this month.
    await db
      .update(transactionsTable)
      .set({ categoryId: catId })
      .where(
        and(
          eq(transactionsTable.householdId, householdId),
          isNull(transactionsTable.categoryId),
          sql`${transactionsTable.description} LIKE ${`Payment — ${d.name}%`}`,
        ),
      );
  }
}

/** The household's current month, first day (the month a debt change lands in). */
export function currentMonthStart(): string {
  return `${householdTodayISO().slice(0, 7)}-01`;
}

/**
 * Best-effort sync after a debt change: the auto_debts categories and this
 * month's lines follow the Debts tracker. Never throws (a failed sync must not
 * fail the debt write); the nightly job retries it.
 */
export async function syncDebtBudgetAfterWrite(householdId: string, userId: string): Promise<void> {
  try {
    await syncAutoDebtCategories(householdId, userId, currentMonthStart());
  } catch (err) {
    logger.warn({ err, householdId }, "auto_debts budget sync after a debt write failed");
  }
}
