// ⭐ (PR-C) GOALS AND RESERVES — the server side. Reads the household's goals
// and the balances of the accounts that back them; every figure is computed by
// avalanche-core (`goals.ts`). READ-ONLY: the one writer is `routes/goals.ts`.
//
//   reservesHeld   the money position's `reservesHeld` (`loadPositionInputs`):
//                  money the active goals hold back in checking. A goal backed
//                  by a savings account never enters it.
//   goalsMonthly   the weekly-limit derivation's "Goals" line
//                  (`suggestWeeklyCap`).
//   balances       a backing account's balance is the owner's per-account
//                  snapshot (`forecast_settings.account_snapshots`, keyed by
//                  `plaid_accounts.id`), only for an account of this household.
//                  None yet → the goal's current amount is null, never a false 0.
//   buffer goal    its target is shown beside `forecast_settings.cash_buffer`;
//                  it never changes the buffer (the forecast reads the buffer
//                  from forecast_settings alone).

import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { db, forecastSettingsTable, goalsTable, plaidAccountsTable, type Goal } from "@workspace/db";
import {
  goalCurrentCents,
  goalProgress,
  goalReserveCents,
  goalsMonthlyCents,
  reservesHeldCents,
  type GoalMathRow,
} from "@workspace/avalanche-core";
import { householdTodayISO } from "./householdClock";

const money = (c: number): string => (c / 100).toFixed(2);

/** A `goals` row as the maths reads it. */
export function goalMathRow(g: Goal): GoalMathRow {
  return {
    status: g.status,
    targetAmount: g.targetAmount,
    manualCurrentAmount: g.manualCurrentAmount,
    plaidAccountId: g.plaidAccountId,
    monthlyContribution: g.monthlyContribution,
    targetDate: g.targetDate,
    reservedInChecking: g.reservedInChecking,
  };
}

/** The household's goals, highest priority first; archived ones only when asked. */
export async function loadGoals(householdId: string, opts: { includeArchived?: boolean } = {}): Promise<Goal[]> {
  return db
    .select()
    .from(goalsTable)
    .where(
      opts.includeArchived
        ? eq(goalsTable.householdId, householdId)
        : and(eq(goalsTable.householdId, householdId), ne(goalsTable.status, "archived")),
    )
    .orderBy(desc(goalsTable.priority), asc(goalsTable.createdAt), asc(goalsTable.id));
}

/** ⭐ The money position's `reservesHeld`: dollars, two decimals. */
export async function reservesHeld(householdId: string): Promise<string> {
  const rows = await db
    .select()
    .from(goalsTable)
    .where(
      and(
        eq(goalsTable.householdId, householdId),
        eq(goalsTable.status, "active"),
        eq(goalsTable.reservedInChecking, true),
        isNull(goalsTable.plaidAccountId),
      ),
    );
  return money(reservesHeldCents(rows.map(goalMathRow)));
}

/** The weekly-limit derivation's goals line: Σ the active goals' monthly contributions, dollars. */
export async function goalsMonthly(householdId: string): Promise<string> {
  const rows = await db
    .select()
    .from(goalsTable)
    .where(and(eq(goalsTable.householdId, householdId), eq(goalsTable.status, "active")));
  return money(goalsMonthlyCents(rows.map(goalMathRow)));
}

/**
 * The balances of the household's accounts that back goals: `plaid_accounts.id`
 * → the owner's per-account snapshot balance. An account outside the household
 * is never read.
 */
export async function loadGoalAccountBalances(
  householdId: string,
  ownerUserId: string,
  accountIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (accountIds.length === 0) return out;
  const [accounts, [settings]] = await Promise.all([
    db
      .select({ id: plaidAccountsTable.id })
      .from(plaidAccountsTable)
      .where(and(eq(plaidAccountsTable.householdId, householdId), inArray(plaidAccountsTable.id, [...accountIds]))),
    db
      .select({ accountSnapshots: forecastSettingsTable.accountSnapshots })
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, ownerUserId)),
  ]);
  const snaps = settings?.accountSnapshots ?? {};
  for (const a of accounts) {
    const b = snaps[a.id]?.balance;
    if (b !== undefined && b !== null && Number.isFinite(Number(b))) out.set(a.id, String(b));
  }
  return out;
}

/** The forecast's cash buffer for the owner, as the ledger reads it (`forecastLedger.ts`). */
export async function loadCashBuffer(ownerUserId: string): Promise<string> {
  const [s] = await db
    .select({ cashBuffer: forecastSettingsTable.cashBuffer })
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, ownerUserId));
  return (Number(s?.cashBuffer ?? 500) || 0).toFixed(2);
}

/** A goal with its current amount in dollars (null = unknown): what the monitor and the metrics read. */
export interface GoalWithCurrent extends GoalMathRow {
  goalId: string;
  kind: string;
  current: string | null;
}

/** Every non-archived goal of the household with its current amount. */
export async function loadGoalsWithCurrent(householdId: string, ownerUserId: string): Promise<GoalWithCurrent[]> {
  const goals = await loadGoals(householdId);
  const balances = await loadGoalAccountBalances(
    householdId,
    ownerUserId,
    goals.map((g) => g.plaidAccountId).filter((v): v is string => !!v),
  );
  return goals.map((g) => {
    const row = goalMathRow(g);
    const c = goalCurrentCents(row, g.plaidAccountId ? (balances.get(g.plaidAccountId) ?? null) : null);
    return { ...row, goalId: g.id, kind: g.kind, current: c === null ? null : money(c) };
  });
}

export interface GoalView {
  id: string;
  name: string;
  kind: string;
  status: string;
  targetAmount: string | null;
  manualCurrentAmount: string;
  plaidAccountId: string | null;
  monthlyContribution: string;
  targetDate: string | null;
  reservedInChecking: boolean;
  priority: number;
  currentAmount: string | null;
  currentSource: "manual" | "account";
  percent: number | null;
  remaining: string | null;
  monthsToTargetLow: number | null;
  monthsToTargetHigh: number | null;
  requiredMonthly: string | null;
  onTrack: boolean | null;
  reserveHeld: string;
  cashBuffer: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toGoalView(
  g: Goal,
  ctx: { todayISO: string; balances: Map<string, string>; cashBuffer: string },
): GoalView {
  const row = goalMathRow(g);
  const current = goalCurrentCents(row, g.plaidAccountId ? (ctx.balances.get(g.plaidAccountId) ?? null) : null);
  const p = goalProgress(row, current, ctx.todayISO);
  return {
    id: g.id,
    name: g.name,
    kind: g.kind,
    status: g.status,
    targetAmount: g.targetAmount,
    manualCurrentAmount: g.manualCurrentAmount,
    plaidAccountId: g.plaidAccountId,
    monthlyContribution: g.monthlyContribution,
    targetDate: g.targetDate,
    reservedInChecking: g.reservedInChecking,
    priority: g.priority,
    currentAmount: current === null ? null : money(current),
    currentSource: g.plaidAccountId ? "account" : "manual",
    percent: p.percent,
    remaining: p.remainingCents === null ? null : money(p.remainingCents),
    monthsToTargetLow: p.monthsToTarget?.low ?? null,
    monthsToTargetHigh: p.monthsToTarget?.high ?? null,
    requiredMonthly: p.requiredMonthlyCents === null ? null : money(p.requiredMonthlyCents),
    onTrack: p.behind === null ? null : !p.behind,
    reserveHeld: money(goalReserveCents(row)),
    cashBuffer: g.kind === "buffer" ? ctx.cashBuffer : null,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  };
}

/** Views for a set of goals: one balance read, one buffer read. */
export async function goalViews(householdId: string, ownerUserId: string, goals: readonly Goal[]): Promise<GoalView[]> {
  const [balances, cashBuffer] = await Promise.all([
    loadGoalAccountBalances(
      householdId,
      ownerUserId,
      goals.map((g) => g.plaidAccountId).filter((v): v is string => !!v),
    ),
    loadCashBuffer(ownerUserId),
  ]);
  const todayISO = householdTodayISO();
  return goals.map((g) => toGoalView(g, { todayISO, balances, cashBuffer }));
}

/** `GET /goals`. */
export async function listGoals(householdId: string, ownerUserId: string, opts: { includeArchived?: boolean } = {}) {
  const goals = await loadGoals(householdId, opts);
  const [views, cashBuffer] = await Promise.all([goalViews(householdId, ownerUserId, goals), loadCashBuffer(ownerUserId)]);
  const rows = goals.map(goalMathRow);
  return {
    goals: views,
    reservesHeld: money(reservesHeldCents(rows)),
    goalsMonthly: money(goalsMonthlyCents(rows)),
    cashBuffer,
  };
}
