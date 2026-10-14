// (PR-B1) Reading the household's allowance plans, and the suggested weekly
// cap with its working. READ-ONLY: the one writer is `allowancePlanWriter.ts`.

import { and, asc, eq, inArray } from "drizzle-orm";
import {
  allowancePlansTable,
  avalancheSettingsTable,
  db,
  debtsTable,
  recurringItemsTable,
  settingsTable,
  type AllowancePlan,
} from "@workspace/db";
import { goalsMonthly as loadGoalsMonthly } from "./goals";
import {
  allowancePlanInEffect,
  deriveWeeklyLimit,
  everydayPlanFromRows,
  monthBounds,
  monthlyCapCents,
  readEverydayHooks,
  weekBounds,
  weeklyCapCents,
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

/**
 * ⭐ (S2) THE PLAN ROW IN EFFECT NOW — this week's weekly plan and this month's
 * monthly plan, by the rule every reader uses: `everydayPlanFromRows` +
 * `weeklyCapCents` / `monthlyCapCents` (the money position, the period breakdown
 * and the everyday hooks). A $0 row is no plan (null), never a $0 cap. A week's
 * override (`preferences.weeklyAllowanceOverrides`) is not a plan row, so it is
 * not reported here — the position and the breakdown say `source: override`.
 */
export function plansInEffect(
  plans: readonly AllowancePlan[],
  todayISO: string,
): { weekly: AllowancePlan | null; monthly: AllowancePlan | null } {
  const rows = planRowsOf(plans);
  const weekStart = weekBounds(todayISO).start;
  const monthStart = monthBounds(todayISO).start;
  return {
    weekly: weeklyCapCents(everydayPlanFromRows(weekStart, rows)) == null ? null : allowancePlanInEffect(weekStart, plans, "weekly"),
    monthly: monthlyCapCents(everydayPlanFromRows(monthStart, rows)) == null ? null : allowancePlanInEffect(monthStart, plans, "monthly"),
  };
}

/** (S2) An amount the owner may start a plan from. An option only: nothing writes it. */
export interface AllowancePlanPrefill {
  period: "weekly" | "monthly";
  /** Dollars, two decimals, more than 0. */
  amount: string;
  /**
   * `hook_stored`: the everyday hook's own stored amount — what the forecast
   * reserves each week (or month) while no plan is set. `suggested`: the
   * suggested weekly cap (`suggestWeeklyCap`). `settings`: the allowance saved on
   * the classic Allowances page.
   */
  source: "hook_stored" | "suggested" | "settings";
  label: string;
}

const dollars = (v: string | number | null | undefined): string | null => {
  const n = Math.abs(Number(v ?? 0));
  return Number.isFinite(n) && Math.round(n * 100) > 0 ? n.toFixed(2) : null;
};

/**
 * ⭐ (S2) THE AMOUNTS A PLAN MAY START FROM — options only, in this order: each
 * everyday hook's stored amount ("Weekly Spend reserve", the item the forecast
 * keeps on the curve while no plan is set; only an active, non-income item, the
 * ledger's own rule), the suggested weekly cap, and the owner's saved allowance
 * amounts. Only amounts above $0. READ-ONLY.
 */
export async function planPrefills(
  householdId: string,
  ownerUserId: string,
  suggestedWeekly: string,
): Promise<AllowancePlanPrefill[]> {
  const [s] = await db
    .select({
      weekly: settingsTable.weeklyAllowanceAmount,
      monthly: settingsTable.monthlyAllowanceAmount,
      preferences: settingsTable.preferences,
    })
    .from(settingsTable)
    .where(eq(settingsTable.userId, ownerUserId));
  const hooks = readEverydayHooks(s?.preferences ?? null);
  const hookIds = [hooks.weekly?.recurringItemId, hooks.monthly?.recurringItemId].filter((id): id is string => !!id);
  const items = hookIds.length
    ? await db
        .select({
          id: recurringItemsTable.id,
          name: recurringItemsTable.name,
          amount: recurringItemsTable.amount,
          kind: recurringItemsTable.kind,
          active: recurringItemsTable.active,
        })
        .from(recurringItemsTable)
        .where(and(eq(recurringItemsTable.householdId, householdId), inArray(recurringItemsTable.id, hookIds)))
    : [];
  const out: AllowancePlanPrefill[] = [];
  for (const [period, hook] of [
    ["weekly", hooks.weekly],
    ["monthly", hooks.monthly],
  ] as const) {
    const item = hook ? items.find((i) => i.id === hook.recurringItemId) : undefined;
    if (!item || item.active !== "true" || item.kind === "income") continue;
    const amount = dollars(item.amount);
    if (amount) out.push({ period, amount, source: "hook_stored", label: `${item.name} reserve` });
  }
  const suggested = dollars(suggestedWeekly);
  if (suggested) out.push({ period: "weekly", amount: suggested, source: "suggested", label: "Suggested" });
  const weekly = dollars(s?.weekly);
  if (weekly) out.push({ period: "weekly", amount: weekly, source: "settings", label: "Saved allowance" });
  const monthly = dollars(s?.monthly);
  if (monthly) out.push({ period: "monthly", amount: monthly, source: "settings", label: "Saved allowance" });
  return out;
}
