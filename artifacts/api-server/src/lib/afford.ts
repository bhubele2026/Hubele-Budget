// ⭐ (PR-F1) "CAN WE AFFORD THIS?" — the server's read. Nothing is computed
// here: `evaluateAfford` (avalanche-core, affordScenario.ts) does every sum.
//
//   the position   `loadPositionInputs` — the SAME read `GET /money/position`
//                  makes (moneyPosition.ts), so the baseline is the position
//                  the household sees, byte for byte;
//   the curve      that read's own ledger: its items, its window, and the
//                  starting balance `rollForwardBalance` gives the walk;
//   the debt plan  `loadPlanDebts` / `loadPlanSettings` /
//                  `measuredNewChargesPerMonth` — the reads `computeDebtPlan`
//                  makes for `GET /debt-plan`;
//   categories     this month's plan and spend for each manual expense
//                  category, read the way the Budget month reads them
//                  (`GET /budget/months/:monthStart`): the stored line, and the
//                  month's rows through `aggregateBudgetMonth` (a pending row a
//                  posted row replaced counts once; split rows by their parts).
//                  A category planned by its bills or its debt (auto, or a bill
//                  linked to it), and the system "Uncategorized", are left out:
//                  the evaluator says there is no plan to measure against
//                  rather than guess one.
//
// ⚠️ READ-ONLY. Stateless: nothing is written.

import { and, eq, sql } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  budgetLinesTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import {
  addDaysISO,
  evaluateAfford,
  monthBounds,
  rollForwardBalance,
  type AffordBaseline,
  type AffordCategoryPlan,
  type AffordPurchase,
  type AffordResult,
} from "@workspace/avalanche-core";
import { loadPositionInputs } from "./moneyPosition";
import { loadPlanDebts, loadPlanSettings, measuredNewChargesPerMonth } from "./debtPlan";
import { isPastOneTime } from "./cashSignal";
import { findSupersededPendingForRange } from "./supersededPending";
import { uncategorizedCategoryIds } from "./pendingFiling";
import { aggregateBudgetMonth } from "./budgetActuals";
import { expandSplits, loadSplitsByTxn } from "./categorizer/splits";

/**
 * This month's plan and spend so far for each manual expense category with a
 * stored line or spend this month. Planned is the month's stored budget line
 * (the Budget month's figure for a manual category); spent is its posted plus
 * pending spend, from `aggregateBudgetMonth` on one read-only snapshot.
 */
export async function loadCategoryPlans(householdId: string, todayISO: string): Promise<AffordCategoryPlan[]> {
  const { start: monthStart, endExclusive } = monthBounds(todayISO);
  const [allCats, lines, recurring] = await Promise.all([
    db
      .select({
        id: budgetCategoriesTable.id,
        name: budgetCategoriesTable.name,
        kind: budgetCategoriesTable.kind,
        sourceKind: budgetCategoriesTable.sourceKind,
        excludeFromBudget: budgetCategoriesTable.excludeFromBudget,
      })
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.householdId, householdId)),
    db
      .select({ categoryId: budgetLinesTable.categoryId, plannedAmount: budgetLinesTable.plannedAmount })
      .from(budgetLinesTable)
      .where(and(eq(budgetLinesTable.householdId, householdId), eq(budgetLinesTable.monthStart, monthStart))),
    db
      .select({
        categoryId: recurringItemsTable.categoryId,
        active: recurringItemsTable.active,
        frequency: recurringItemsTable.frequency,
        anchorDate: recurringItemsTable.anchorDate,
      })
      .from(recurringItemsTable)
      .where(eq(recurringItemsTable.householdId, householdId)),
  ]);
  // The Budget month's "auto" test: an auto category, or a manual one a live bill is linked to.
  const billBacked = new Set<string>();
  for (const r of recurring) {
    if (r.active === "false" || isPastOneTime(r, todayISO) || !r.categoryId) continue;
    billBacked.add(r.categoryId);
  }
  const uncategorized = uncategorizedCategoryIds(allCats);
  const manual = allCats.filter(
    (c) =>
      !c.excludeFromBudget &&
      c.kind !== "income" &&
      c.sourceKind === "manual" &&
      !billBacked.has(c.id) &&
      !uncategorized.has(c.id),
  );
  if (manual.length === 0) return [];

  const snapshot = await db.transaction(
    async (tx) => {
      const supersede = await findSupersededPendingForRange(householdId, monthStart, addDaysISO(endExclusive, -1), tx);
      const monthRows = await tx
        .select({
          id: transactionsTable.id,
          description: transactionsTable.description,
          source: transactionsTable.source,
          amount: transactionsTable.amount,
          pending: transactionsTable.pending,
          isTransfer: transactionsTable.isTransfer,
          isExternalCardPayment: transactionsTable.isExternalCardPayment,
          categoryId: transactionsTable.categoryId,
          weeklyAllowance: transactionsTable.weeklyAllowance,
          monthlyAllowance: transactionsTable.monthlyAllowance,
          unplannedAllowance: transactionsTable.unplannedAllowance,
          weeklyBucket: transactionsTable.weeklyBucket,
          reimbursable: transactionsTable.reimbursable,
          debtId: transactionsTable.debtId,
          isTransferUserOverridden: transactionsTable.isTransferUserOverridden,
        })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.householdId, householdId),
            sql`${transactionsTable.occurredOn} >= ${monthStart}`,
            sql`${transactionsTable.occurredOn} < ${endExclusive}`,
          ),
        );
      return { supersede, monthRows };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  const splitParts = expandSplits(
    snapshot.monthRows,
    await loadSplitsByTxn(householdId, { from: monthStart, to: addDaysISO(endExclusive, -1) }),
  );
  const spend = aggregateBudgetMonth(
    snapshot.monthRows,
    snapshot.supersede,
    { uncategorizedIds: uncategorized },
    splitParts,
  );
  const plannedBy = new Map(lines.map((l) => [l.categoryId, l.plannedAmount] as const));
  const out: AffordCategoryPlan[] = [];
  for (const c of manual) {
    const planned = plannedBy.get(c.id);
    const s = spend.byCategory.get(c.id)?.spend;
    if (planned === undefined && !s) continue;
    out.push({
      categoryId: c.id,
      planned: planned ?? "0",
      spentMtd: (((s?.posted ?? 0) + (s?.pending ?? 0)) / 100).toFixed(2),
    });
  }
  return out;
}

/** ⭐ The baseline "Can we afford this?" evaluates against: one read of the household. */
export async function buildAffordBaseline(householdId: string, ownerUserId: string): Promise<AffordBaseline> {
  const [{ inputs, cash }, debts, plan] = await Promise.all([
    loadPositionInputs(householdId, ownerUserId),
    loadPlanDebts(householdId),
    loadPlanSettings(ownerUserId),
  ]);
  const { ledger } = cash;
  const [newChargesPerMonth, categoryPlans] = await Promise.all([
    measuredNewChargesPerMonth(
      householdId,
      debts.sim.map((d) => d.id),
      ledger.todayISO,
    ),
    loadCategoryPlans(householdId, ledger.todayISO),
  ]);
  return {
    positionInputs: inputs,
    events: ledger.items,
    // The walk's own starting balance: `computeCashSignalDetailed` rolls the same items the same way.
    startingBalance: rollForwardBalance(ledger.items, ledger.startBalanceAtAnchor, ledger.fromISO),
    fromISO: ledger.fromISO,
    toISO: ledger.toISO,
    categoryPlans,
    debts: debts.sim,
    avalanche: { strategy: plan.strategy, extraMonthly: plan.extraMonthly, newChargesPerMonth },
  };
}

/** Evaluate one purchase for a household. Throws `AffordInputError` for a purchase it cannot read. */
export async function evaluateAffordForHousehold(
  householdId: string,
  ownerUserId: string,
  purchase: AffordPurchase,
): Promise<AffordResult> {
  return evaluateAfford(await buildAffordBaseline(householdId, ownerUserId), purchase);
}
