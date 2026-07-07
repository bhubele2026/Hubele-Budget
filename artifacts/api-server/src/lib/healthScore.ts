// Budget Health — the one code-computed "how are we doing" score.
//
// CLAUDE.md §1: the AI NEVER does arithmetic. Every figure here is computed by
// EXISTING builders (computeAvalanchePayoffFacts, computeCashSignal,
// buildBudgetFacts) plus small SQL aggregates — this module only reads them,
// scores each dimension, and weights them into one 0-100 number. Fable 5 later
// narrates these facts; it never computes them.
//
// Weighting is debt-payoff-first (the household's North Star):
//   Debt trajectory 45% · Cash runway/safety 25% · Spending vs plan 20% ·
//   Savings/freed cash 10%.
//
// Contract: computeBudgetHealth NEVER throws. Any failure yields a neutral
// fallback so the health card / snapshot job can never be broken by it
// (mirrors householdFacts.ts).

import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  db,
  debtsTable,
  debtBalanceHistoryTable,
  avalancheSettingsTable,
  transactionsTable,
} from "@workspace/db";
import { computeCashSignal, parseISO } from "./cashSignal";
import { computeAvalanchePayoffFacts, resolveAvalancheTargetDebt } from "./avalancheSim";
import { buildBudgetFacts } from "./budgetFacts";
import { logger } from "./logger";

export type HealthStatus = "green" | "yellow" | "red";
export type DimensionKey = "debt" | "cash" | "spending" | "savings";

export interface HealthDimension {
  key: DimensionKey;
  label: string;
  score: number; // 0-100 sub-score
  weight: number; // 0-1 (sums to 1 across dimensions)
  summary: string; // one plain-English fact line (for the card + the AI prompt)
}

/** Raw figures handed to the Fable 5 narrative — the model narrates, never computes. */
export interface HealthRawFacts {
  totalDebt: number;
  targetDebtName: string | null;
  targetDebtApr: number | null; // fraction, e.g. 0.24
  monthsToFreedom: number | null; // null = never converges within horizon
  underwater: boolean;
  interestSavedVsMin: number;
  debtTrend30d: number | null; // signed Δ total debt over ~30d (negative = falling = good)
  lowestProjected: number;
  runwayDays: number;
  maxSafeExtra: number;
  cashStatus: string; // ready | tight | not_yet | no_data
  cashBuffer: number;
  flexPaceStatus: string; // under | on_track | over
  flexProjectedVsPlan: number; // + = projected over plan, - = under
  monthlyIncome: number;
  monthlySpend: number;
  netCashflow: number;
  paidThisMonth: number;
}

export interface HealthFacts {
  score: number; // 0-100 overall
  status: HealthStatus;
  grade: string; // A | B | C | D | F
  dimensions: HealthDimension[];
  drivers: string[]; // top helping / hurting factors, plain strings
  facts: HealthRawFacts;
}

const WEIGHTS: Record<DimensionKey, number> = {
  debt: 0.45,
  cash: 0.25,
  spending: 0.2,
  savings: 0.1,
};

const NEUTRAL_FACTS: HealthRawFacts = {
  totalDebt: 0,
  targetDebtName: null,
  targetDebtApr: null,
  monthsToFreedom: null,
  underwater: false,
  interestSavedVsMin: 0,
  debtTrend30d: null,
  lowestProjected: 0,
  runwayDays: 0,
  maxSafeExtra: 0,
  cashStatus: "no_data",
  cashBuffer: 0,
  flexPaceStatus: "on_track",
  flexProjectedVsPlan: 0,
  monthlyIncome: 0,
  monthlySpend: 0,
  netCashflow: 0,
  paidThisMonth: 0,
};

function clamp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function daysBetween(fromISO: string | undefined, toISO: string | null): number {
  if (!fromISO || !toISO) return 0;
  try {
    const diff = (parseISO(toISO).getTime() - parseISO(fromISO).getTime()) / 86_400_000;
    return diff > 0 ? Math.round(diff) : 0;
  } catch {
    return 0;
  }
}

// --- Per-dimension scoring (all deterministic, all 0-100) -------------------

function scoreDebt(f: HealthRawFacts): number {
  if (f.totalDebt <= 0) return 100; // debt-free is peak health
  let base: number;
  const m = f.monthsToFreedom;
  if (m == null) base = 25; // never pays off within horizon
  else if (m <= 24) base = 92;
  else if (m <= 48) base = 78;
  else if (m <= 84) base = 60;
  else if (m <= 120) base = 45;
  else base = 32;
  // Is total debt actually falling? (the thing that matters day to day)
  if (f.debtTrend30d != null) {
    if (f.debtTrend30d < -0.5) base += 12; // falling
    else if (f.debtTrend30d > 0.5) base -= 18; // rising
  }
  if (f.interestSavedVsMin > 0) base += 6; // beating minimums
  if (f.underwater) base = Math.min(base, 22); // hard cap — interest outruns minimums
  return clamp(base);
}

function scoreCash(f: HealthRawFacts): number {
  let base: number;
  switch (f.cashStatus) {
    case "ready":
      base = 88;
      break;
    case "tight":
      base = 55;
      break;
    case "not_yet":
      base = 25;
      break;
    default:
      base = 50; // no_data — neutral
  }
  if (f.maxSafeExtra > 500) base += 8;
  if (f.runwayDays >= 45) base += 4;
  if (f.lowestProjected < 0) base = Math.min(base, 15); // projected to go negative
  return clamp(base);
}

function scoreSpending(f: HealthRawFacts): number {
  let base: number;
  switch (f.flexPaceStatus) {
    case "under":
      base = 90;
      break;
    case "on_track":
      base = 72;
      break;
    case "over":
      base = 40;
      break;
    default:
      base = 60;
  }
  // projectedVsPlan: + = projected over the flex plan (bad), - = under (good)
  if (f.flexProjectedVsPlan > 0) base -= Math.min(25, f.flexProjectedVsPlan / 20);
  else base += 5;
  return clamp(base);
}

function scoreSavings(f: HealthRawFacts): number {
  const net = f.netCashflow;
  let base: number;
  if (net > 500) base = 90;
  else if (net > 0) base = 70;
  else if (net > -300) base = 45;
  else base = 25;
  if (f.paidThisMonth > 0) base += 8; // actively throwing money at debt
  return clamp(base);
}

function bandStatus(score: number): HealthStatus {
  if (score >= 75) return "green";
  if (score >= 50) return "yellow";
  return "red";
}

function letterGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

function money(n: number): string {
  return `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
}

function dimensionSummary(key: DimensionKey, f: HealthRawFacts): string {
  switch (key) {
    case "debt":
      if (f.totalDebt <= 0) return "Debt-free — nothing left to pay off.";
      return (
        `${money(f.totalDebt)} total debt` +
        (f.underwater
          ? " — a debt is underwater (interest outruns its minimum)."
          : f.monthsToFreedom != null
            ? `, on track to debt-free in ${f.monthsToFreedom} months.`
            : ", but the plan doesn't fully pay off yet.") +
        (f.debtTrend30d != null
          ? f.debtTrend30d < -0.5
            ? ` Debt fell ${money(Math.abs(f.debtTrend30d))} over ~30 days.`
            : f.debtTrend30d > 0.5
              ? ` Debt rose ${money(f.debtTrend30d)} over ~30 days.`
              : " Debt is roughly flat over ~30 days."
          : "")
      );
    case "cash":
      return (
        `Cash runway is ${f.cashStatus}; lowest projected balance ${money(f.lowestProjected)}` +
        (f.runwayDays > 0 ? ` in ~${f.runwayDays} days` : "") +
        ` vs a ${money(f.cashBuffer)} buffer.`
      );
    case "spending":
      return `Flex spending is pacing ${f.flexPaceStatus}${
        f.flexProjectedVsPlan > 0
          ? `, projected ${money(f.flexProjectedVsPlan)} over plan.`
          : " or under plan."
      }`;
    case "savings":
      return `Net cashflow this month ${money(f.netCashflow)}${
        f.paidThisMonth > 0 ? `; ${money(f.paidThisMonth)} sent to debt.` : "."
      }`;
  }
}

/** Rank the dimensions into the plain-English helping / hurting driver lines. */
function buildDrivers(dims: HealthDimension[]): string[] {
  const sorted = [...dims].sort((a, b) => b.score - a.score);
  const drivers: string[] = [];
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  if (worst && worst.score < 60) drivers.push(`Hurting most: ${worst.summary}`);
  if (best && best.score >= 70 && best.key !== worst?.key)
    drivers.push(`Helping most: ${best.summary}`);
  // Any additional red-flag dimension worth calling out.
  for (const d of sorted) {
    if (d.key !== worst?.key && d.score < 45) drivers.push(`Also dragging: ${d.summary}`);
  }
  return drivers.slice(0, 3);
}

// --- Fact gathering ---------------------------------------------------------

function firstOfMonthISO(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
}
function firstOfNextMonthISO(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString().slice(0, 10);
}
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Total-debt change over ~30 days from the daily debt_balance_history series:
 * (current total active balance) − (sum of the earliest in-window balance per
 * debt from ~30-40 days ago). Negative = debt fell = good. Returns null when
 * there isn't enough history yet.
 */
async function debtTrend30d(
  householdId: string,
  currentTotal: number,
): Promise<number | null> {
  try {
    const windowStart = isoDaysAgo(45);
    const windowEnd = isoDaysAgo(25);
    const rows = await db
      .select({
        debtId: debtBalanceHistoryTable.debtId,
        recordedOn: debtBalanceHistoryTable.recordedOn,
        balance: debtBalanceHistoryTable.balance,
      })
      .from(debtBalanceHistoryTable)
      .where(
        and(
          eq(debtBalanceHistoryTable.householdId, householdId),
          gte(debtBalanceHistoryTable.recordedOn, windowStart),
          lte(debtBalanceHistoryTable.recordedOn, windowEnd),
        ),
      )
      .orderBy(debtBalanceHistoryTable.recordedOn);
    if (rows.length === 0) return null;
    // earliest in-window balance per debt
    const earliest = new Map<string, number>();
    for (const r of rows) {
      if (!earliest.has(r.debtId)) earliest.set(r.debtId, Number(r.balance) || 0);
    }
    let pastTotal = 0;
    for (const v of earliest.values()) pastTotal += v;
    return Math.round((currentTotal - pastTotal) * 100) / 100;
  } catch {
    return null;
  }
}

async function monthlyCashflow(householdId: string): Promise<{
  income: number;
  spend: number;
  net: number;
  paidThisMonth: number;
}> {
  const monthStart = firstOfMonthISO();
  const monthEnd = firstOfNextMonthISO();
  const [agg] = await db
    .select({
      income: sql<string>`coalesce(sum(case when ${transactionsTable.amount} > 0 then ${transactionsTable.amount} else 0 end)::text, '0')`,
      spend: sql<string>`coalesce(sum(case when ${transactionsTable.amount} < 0 then -${transactionsTable.amount} else 0 end)::text, '0')`,
      paid: sql<string>`coalesce(sum(case when ${transactionsTable.debtId} is not null then abs(${transactionsTable.amount}) else 0 end)::text, '0')`,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        gte(transactionsTable.occurredOn, monthStart),
        lte(transactionsTable.occurredOn, monthEnd),
        eq(transactionsTable.pending, false),
      ),
    );
  const income = Number(agg?.income ?? 0) || 0;
  const spend = Number(agg?.spend ?? 0) || 0;
  return {
    income,
    spend,
    net: Math.round((income - spend) * 100) / 100,
    paidThisMonth: Number(agg?.paid ?? 0) || 0,
  };
}

// --- Public entry point -----------------------------------------------------

/**
 * Compute the household's budget-health facts for right now. Never throws —
 * returns a neutral 50/yellow fallback on any error so callers (snapshot job,
 * endpoint) can't break.
 */
export async function computeBudgetHealth(
  householdId: string,
  ownerUserId: string,
): Promise<HealthFacts> {
  let f: HealthRawFacts = { ...NEUTRAL_FACTS };
  try {
    const debts = await db
      .select()
      .from(debtsTable)
      .where(eq(debtsTable.householdId, householdId));

    const [avaSettings] = await db
      .select()
      .from(avalancheSettingsTable)
      .where(eq(avalancheSettingsTable.userId, ownerUserId));
    const manualExtra = Number(avaSettings?.manualExtra ?? 0) || 0;

    const payoff = computeAvalanchePayoffFacts(debts, "avalanche", manualExtra);
    const target = resolveAvalancheTargetDebt(debts);
    f.totalDebt = payoff.totalDebt;
    f.monthsToFreedom = payoff.monthsToFreedom;
    f.underwater = payoff.underwater;
    f.interestSavedVsMin = payoff.interestSavedVsMin;
    f.targetDebtName = target?.name ?? null;
    f.targetDebtApr = target?.apr ?? null;
    f.debtTrend30d = await debtTrend30d(householdId, f.totalDebt);

    try {
      const cs = await computeCashSignal(householdId, ownerUserId, { horizonDays: 90 });
      f.cashStatus = cs.status;
      f.lowestProjected = Number(cs.lowestProjected) || 0;
      f.maxSafeExtra = Number(cs.maxSafeExtra) || 0;
      f.cashBuffer = Number(cs.cashBuffer) || 0;
      f.runwayDays = daysBetween(cs.fromDate, cs.lowestDate);
    } catch (err) {
      logger.warn({ err, householdId }, "healthScore: cashSignal failed");
    }

    try {
      const bf = await buildBudgetFacts(householdId, firstOfMonthISO());
      f.flexPaceStatus = bf.flex.paceStatus;
      f.flexProjectedVsPlan = bf.flex.projectedVsPlan;
    } catch (err) {
      logger.warn({ err, householdId }, "healthScore: budgetFacts failed");
    }

    const cf = await monthlyCashflow(householdId);
    f.monthlyIncome = cf.income;
    f.monthlySpend = cf.spend;
    f.netCashflow = cf.net;
    f.paidThisMonth = cf.paidThisMonth;
  } catch (err) {
    logger.warn({ err, householdId }, "healthScore: build failed, using neutral facts");
    f = { ...NEUTRAL_FACTS };
  }

  const dimensions: HealthDimension[] = [
    { key: "debt", label: "Debt trajectory", weight: WEIGHTS.debt, score: scoreDebt(f), summary: dimensionSummary("debt", f) },
    { key: "cash", label: "Cash runway", weight: WEIGHTS.cash, score: scoreCash(f), summary: dimensionSummary("cash", f) },
    { key: "spending", label: "Spending vs plan", weight: WEIGHTS.spending, score: scoreSpending(f), summary: dimensionSummary("spending", f) },
    { key: "savings", label: "Savings", weight: WEIGHTS.savings, score: scoreSavings(f), summary: dimensionSummary("savings", f) },
  ];

  const score = clamp(dimensions.reduce((s, d) => s + d.score * d.weight, 0));
  return {
    score,
    status: bandStatus(score),
    grade: letterGrade(score),
    dimensions,
    drivers: buildDrivers(dimensions),
    facts: f,
  };
}
