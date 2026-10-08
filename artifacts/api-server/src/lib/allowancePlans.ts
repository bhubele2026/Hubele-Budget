// (PR-B1) Reading the household's allowance plans, and the suggested weekly
// cap with its working. READ-ONLY: the one writer is `allowancePlanWriter.ts`.

import { asc, eq } from "drizzle-orm";
import {
  allowancePlansTable,
  avalancheSettingsTable,
  db,
  debtsTable,
  recurringItemsTable,
  type AllowancePlan,
} from "@workspace/db";
import { goalsMonthly as loadGoalsMonthly } from "./goals";
import {
  deriveWeeklyLimit,
  type AllowancePlanRow,
  type WeeklyLimitSuggestion,
} from "@workspace/avalanche-core";

/** An `allowance_plans` row as the API serves it. */
export interface AllowancePlanView {
  id: string;
  memberUserId: string | null;
  period: string;
  amount: string;
  effectiveFrom: string;
  source: string;
  derivation: unknown;
  createdAt: string;
}

export function toAllowancePlanView(r: AllowancePlan): AllowancePlanView {
  return {
    id: r.id,
    memberUserId: r.memberUserId,
    period: r.period,
    amount: r.amount,
    effectiveFrom: r.effectiveFrom,
    source: r.source,
    derivation: r.derivation ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Every plan row of the household, oldest start first. */
export async function loadAllowancePlans(householdId: string): Promise<AllowancePlan[]> {
  return db
    .select()
    .from(allowancePlansTable)
    .where(eq(allowancePlansTable.householdId, householdId))
    .orderBy(
      asc(allowancePlansTable.period),
      asc(allowancePlansTable.effectiveFrom),
      asc(allowancePlansTable.createdAt),
    );
}

/** The rows as `everydayPlanFromRows` reads them. */
export function planRowsOf(rows: readonly AllowancePlan[]): AllowancePlanRow[] {
  return rows.map((r) => ({
    memberUserId: r.memberUserId,
    period: r.period,
    amount: r.amount,
    effectiveFrom: r.effectiveFrom,
  }));
}

/**
 * The suggested weekly cap (`deriveWeeklyLimit`) from the household's own plans:
 * its recurring items, its debts' minimums, the owner's Avalanche extra and
 * (PR-C) the active goals' monthly contributions.
 */
export async function suggestWeeklyCap(
  householdId: string,
  ownerUserId: string,
): Promise<WeeklyLimitSuggestion> {
  const [recurring, debts, [ava], goals] = await Promise.all([
    db
      .select({
        name: recurringItemsTable.name,
        kind: recurringItemsTable.kind,
        amount: recurringItemsTable.amount,
        frequency: recurringItemsTable.frequency,
        active: recurringItemsTable.active,
        debtId: recurringItemsTable.debtId,
      })
      .from(recurringItemsTable)
      .where(eq(recurringItemsTable.householdId, householdId)),
    db
      .select({ minPayment: debtsTable.minPayment, status: debtsTable.status })
      .from(debtsTable)
      .where(eq(debtsTable.householdId, householdId)),
    db
      .select({ manualExtra: avalancheSettingsTable.manualExtra })
      .from(avalancheSettingsTable)
      .where(eq(avalancheSettingsTable.userId, ownerUserId)),
    loadGoalsMonthly(householdId),
  ]);
  return deriveWeeklyLimit({
    incomeItems: recurring.filter((r) => r.kind === "income"),
    billItems: recurring.filter((r) => r.kind !== "income"),
    debts,
    avalancheExtra: ava?.manualExtra ?? 0,
    goalsMonthly: goals,
  });
}
