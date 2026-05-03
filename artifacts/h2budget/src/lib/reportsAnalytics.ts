// Pure derivation helpers for the Reports page. All functions are
// side-effect free so each chart can call them inside a useMemo.

import type {
  Transaction,
  Debt,
  BudgetMonthDetail,
} from "@workspace/api-client-react";
import { simulate, type SimResult, type Strategy, type SimDebt } from "./avalanche";

export const H2_PALETTE = {
  green: "hsl(160, 45%, 32%)",
  greenSoft: "hsl(160, 35%, 55%)",
  amber: "hsl(40, 75%, 50%)",
  amberSoft: "hsl(40, 70%, 70%)",
  red: "hsl(0, 65%, 52%)",
  rose: "hsl(340, 60%, 55%)",
  sky: "hsl(200, 55%, 48%)",
  violet: "hsl(280, 40%, 55%)",
  emerald: "hsl(150, 55%, 42%)",
  slate: "hsl(220, 15%, 55%)",
};

export const CHART_SERIES: string[] = [
  H2_PALETTE.green,
  H2_PALETTE.amber,
  H2_PALETTE.sky,
  H2_PALETTE.violet,
  H2_PALETTE.rose,
  H2_PALETTE.emerald,
  H2_PALETTE.red,
  H2_PALETTE.greenSoft,
  H2_PALETTE.amberSoft,
  H2_PALETTE.slate,
];

export function fmtISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function fmtMonthLabel(d: Date): string {
  return d.toLocaleString("en-US", { month: "short", year: "2-digit" });
}
function fmtMonthShort(d: Date): string {
  return d.toLocaleString("en-US", { month: "short" });
}
function fmtDayLabel(d: Date): string {
  return d.toLocaleString("en-US", { month: "short", day: "numeric" });
}

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function expense(t: Transaction): number {
  const a = Number(t.amount) || 0;
  return a < 0 ? -a : 0;
}
function income(t: Transaction): number {
  const a = Number(t.amount) || 0;
  return a > 0 ? a : 0;
}

// -- Cash flow ---------------------------------------------------------------

export type CashFlowDay = { date: string; income: number; expense: number; net: number };

export function dailyCashFlow(txns: Transaction[]): CashFlowDay[] {
  const map = new Map<string, CashFlowDay>();
  for (const t of txns) {
    const slot = map.get(t.occurredOn) ?? { date: t.occurredOn, income: 0, expense: 0, net: 0 };
    slot.income += income(t);
    slot.expense += expense(t);
    slot.net = slot.income - slot.expense;
    map.set(t.occurredOn, slot);
  }
  return Array.from(map.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function rollupByPeriod(
  rows: CashFlowDay[],
  period: "day" | "week" | "month",
): CashFlowDay[] {
  if (period === "day") return rows;
  const map = new Map<string, CashFlowDay>();
  for (const r of rows) {
    const d = new Date(r.date + "T00:00:00");
    let key: string;
    if (period === "week") {
      const sun = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
      key = fmtISO(sun);
    } else {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
    }
    const slot = map.get(key) ?? { date: key, income: 0, expense: 0, net: 0 };
    slot.income += r.income;
    slot.expense += r.expense;
    slot.net = slot.income - slot.expense;
    map.set(key, slot);
  }
  return Array.from(map.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function withRunningNet(rows: CashFlowDay[]): (CashFlowDay & { running: number })[] {
  let acc = 0;
  return rows.map((r) => {
    acc += r.net;
    return { ...r, running: acc };
  });
}

// 30-day rolling average of daily expense.
export function rolling30DayBurn(rows: CashFlowDay[]): { date: string; avg: number }[] {
  if (rows.length === 0) return [];
  const out: { date: string; avg: number }[] = [];
  const window: number[] = [];
  for (const r of rows) {
    window.push(r.expense);
    if (window.length > 30) window.shift();
    const avg = window.reduce((s, x) => s + x, 0) / window.length;
    out.push({ date: r.date, avg: Math.round(avg * 100) / 100 });
  }
  return out;
}

export type CashFlowKpis = {
  avgIncome: number;
  avgExpense: number;
  avgNet: number;
  savingsRatePct: number;
};

export function cashFlowKpis(rows: CashFlowDay[]): CashFlowKpis {
  if (rows.length === 0) {
    return { avgIncome: 0, avgExpense: 0, avgNet: 0, savingsRatePct: 0 };
  }
  const months = new Map<string, { i: number; e: number }>();
  for (const r of rows) {
    const k = r.date.slice(0, 7);
    const slot = months.get(k) ?? { i: 0, e: 0 };
    slot.i += r.income;
    slot.e += r.expense;
    months.set(k, slot);
  }
  const arr = Array.from(months.values());
  const n = arr.length || 1;
  const avgIncome = arr.reduce((s, x) => s + x.i, 0) / n;
  const avgExpense = arr.reduce((s, x) => s + x.e, 0) / n;
  const avgNet = avgIncome - avgExpense;
  const savingsRatePct = avgIncome > 0 ? (avgNet / avgIncome) * 100 : 0;
  return { avgIncome, avgExpense, avgNet, savingsRatePct };
}

// -- Spending ----------------------------------------------------------------

export type CategoryTotal = { id: string; name: string; total: number };

export function categoryTotals(
  txns: Transaction[],
  catNameById: Map<string, string>,
): CategoryTotal[] {
  const map = new Map<string, number>();
  for (const t of txns) {
    const e = expense(t);
    if (e <= 0) continue;
    const k = t.categoryId ?? "uncategorized";
    map.set(k, (map.get(k) ?? 0) + e);
  }
  return Array.from(map.entries())
    .map(([id, total]) => ({
      id,
      name: id === "uncategorized" ? "Uncategorized" : (catNameById.get(id) ?? "Uncategorized"),
      total,
    }))
    .sort((a, b) => b.total - a.total);
}

// 12-week (84-day) heatmap calendar: one cell per day with spend total.
export function spendingHeatmap(
  txns: Transaction[],
  today: Date,
): { date: string; dow: number; week: number; amount: number }[] {
  const days = 12 * 7;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
  // Walk back to Sunday so weeks align.
  const startSun = new Date(start.getFullYear(), start.getMonth(), start.getDate() - start.getDay());
  const cells: { date: string; dow: number; week: number; amount: number }[] = [];
  const totals = new Map<string, number>();
  for (const t of txns) {
    const e = expense(t);
    if (e <= 0) continue;
    totals.set(t.occurredOn, (totals.get(t.occurredOn) ?? 0) + e);
  }
  const totalDays = Math.ceil(
    (today.getTime() - startSun.getTime()) / 86_400_000,
  ) + 1;
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(startSun.getFullYear(), startSun.getMonth(), startSun.getDate() + i);
    const iso = fmtISO(d);
    cells.push({
      date: iso,
      dow: d.getDay(),
      week: Math.floor(i / 7),
      amount: totals.get(iso) ?? 0,
    });
  }
  return cells;
}

export function dayOfWeekSpend(
  txns: Transaction[],
): { day: string; dow: number; avg: number }[] {
  const sums = [0, 0, 0, 0, 0, 0, 0];
  const daysSeen = new Map<string, Set<number>>();
  for (const t of txns) {
    const e = expense(t);
    if (e <= 0) continue;
    const d = new Date(t.occurredOn + "T00:00:00");
    const dow = d.getDay();
    sums[dow] += e;
    const set = daysSeen.get(t.occurredOn) ?? new Set<number>();
    set.add(dow);
    daysSeen.set(t.occurredOn, set);
  }
  const dowDayCount = [0, 0, 0, 0, 0, 0, 0];
  for (const [iso] of daysSeen) {
    const d = new Date(iso + "T00:00:00").getDay();
    dowDayCount[d] += 1;
  }
  return DOW_LABELS.map((day, dow) => ({
    day,
    dow,
    avg: dowDayCount[dow] > 0 ? sums[dow] / dowDayCount[dow] : 0,
  }));
}

export type MerchantTotal = { name: string; total: number; count: number };

export function topMerchants(txns: Transaction[], limit = 10): MerchantTotal[] {
  const map = new Map<string, MerchantTotal>();
  for (const t of txns) {
    const e = expense(t);
    if (e <= 0) continue;
    const key = (t.description ?? "(unknown)").trim() || "(unknown)";
    const slot = map.get(key) ?? { name: key, total: 0, count: 0 };
    slot.total += e;
    slot.count += 1;
    map.set(key, slot);
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total).slice(0, limit);
}

// 6-month per-category spend series (sparkline data).
export function categoryMonthlyTrends(
  txns: Transaction[],
  catNameById: Map<string, string>,
  today: Date,
  topN = 8,
): { id: string; name: string; total: number; series: { month: string; spend: number }[] }[] {
  const monthsBack = 6;
  const monthKeys: string[] = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  // categoryId -> monthKey -> spend
  const byCat = new Map<string, Map<string, number>>();
  for (const t of txns) {
    const e = expense(t);
    if (e <= 0) continue;
    const mk = t.occurredOn.slice(0, 7);
    if (!monthKeys.includes(mk)) continue;
    const cat = t.categoryId ?? "uncategorized";
    const inner = byCat.get(cat) ?? new Map<string, number>();
    inner.set(mk, (inner.get(mk) ?? 0) + e);
    byCat.set(cat, inner);
  }
  const arr = Array.from(byCat.entries()).map(([id, m]) => {
    let total = 0;
    const series = monthKeys.map((mk) => {
      const v = m.get(mk) ?? 0;
      total += v;
      return { month: mk.slice(5), spend: Math.round(v * 100) / 100 };
    });
    return {
      id,
      name: id === "uncategorized" ? "Uncategorized" : (catNameById.get(id) ?? "Uncategorized"),
      total,
      series,
    };
  });
  return arr.sort((a, b) => b.total - a.total).slice(0, topN);
}

export function reimbursableSplit(
  txns: Transaction[],
): { reimbursable: number; reimbursed: number; outstandingReimbursable: number; personal: number } {
  let reimbursable = 0;
  let reimbursed = 0;
  let personal = 0;
  for (const t of txns) {
    if (t.source !== "amex") continue;
    const e = expense(t);
    if (e <= 0) continue;
    if (t.reimbursable) {
      reimbursable += e;
      if (t.reimbursed) reimbursed += e;
    } else {
      personal += e;
    }
  }
  return {
    reimbursable,
    reimbursed,
    outstandingReimbursable: Math.max(0, reimbursable - reimbursed),
    personal,
  };
}

// -- Budget ------------------------------------------------------------------

export function budgetVariance(budget: BudgetMonthDetail | undefined): {
  name: string;
  variance: number;
  planned: number;
  actual: number;
}[] {
  if (!budget) return [];
  return budget.lines
    .map((l) => {
      const planned = Number(l.plannedAmount) || 0;
      const actual = Number(l.actualAmount) || 0;
      return {
        name: l.categoryName,
        planned,
        actual,
        variance: actual - planned, // positive = over budget
      };
    })
    .filter((r) => r.planned > 0 || r.actual > 0)
    .sort((a, b) => b.variance - a.variance);
}

// Cumulative planned vs actual through the day-of-month cursor.
export function budgetBurndown(
  budget: BudgetMonthDetail | undefined,
  txns: Transaction[],
  monthStart: string,
  today: Date,
): { day: number; planned: number; actual: number }[] {
  if (!budget) return [];
  const start = new Date(monthStart + "T00:00:00");
  const daysInMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const expenseLines = budget.lines.filter((l) => Number(l.plannedAmount) > 0);
  const totalPlanned = expenseLines.reduce((s, l) => s + Number(l.plannedAmount), 0);
  const isCurrentMonth =
    start.getFullYear() === today.getFullYear() &&
    start.getMonth() === today.getMonth();
  const cursor = isCurrentMonth ? today.getDate() : daysInMonth;
  const catIds = new Set(expenseLines.map((l) => l.categoryId));
  const dailySpend = new Array<number>(daysInMonth + 1).fill(0);
  for (const t of txns) {
    if (!t.occurredOn.startsWith(monthStart.slice(0, 7))) continue;
    if (!t.categoryId || !catIds.has(t.categoryId)) continue;
    const e = expense(t);
    if (e <= 0) continue;
    const day = Number(t.occurredOn.slice(8, 10));
    if (day >= 1 && day <= daysInMonth) dailySpend[day] += e;
  }
  const out: { day: number; planned: number; actual: number }[] = [];
  let actual = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    actual += dailySpend[d];
    const planned = (totalPlanned * d) / daysInMonth;
    out.push({
      day: d,
      planned: Math.round(planned * 100) / 100,
      actual: d <= cursor ? Math.round(actual * 100) / 100 : NaN,
    });
  }
  return out;
}

// Build a category × month grid aligned by explicit `monthKeys` (oldest →
// newest). Missing data is represented as null so the UI can render an
// empty cell rather than mis-shifting data.
export type ConsistencyCell = {
  monthKey: string;
  pct: number;
  planned: number;
  actual: number;
} | null;

export function budgetConsistencyHeatmap(
  budgets: (BudgetMonthDetail | undefined)[],
  monthKeys: string[],
): { category: string; cells: ConsistencyCell[] }[] {
  // monthKey -> categoryName -> cell
  const byMonth = new Map<string, Map<string, ConsistencyCell>>();
  for (const mk of monthKeys) byMonth.set(mk, new Map());
  for (const b of budgets) {
    if (!b) continue;
    const mk = b.monthStart.slice(0, 7);
    if (!byMonth.has(mk)) continue;
    const slot = byMonth.get(mk)!;
    for (const line of b.lines) {
      const planned = Number(line.plannedAmount) || 0;
      const actual = Number(line.actualAmount) || 0;
      const pct = planned > 0 ? (actual / planned) * 100 : actual > 0 ? 999 : 0;
      slot.set(line.categoryName, { monthKey: mk, pct, planned, actual });
    }
  }
  const allCats = new Set<string>();
  for (const slot of byMonth.values()) for (const cat of slot.keys()) allCats.add(cat);
  const rows = Array.from(allCats).map((category) => {
    const cells: ConsistencyCell[] = monthKeys.map(
      (mk) => byMonth.get(mk)?.get(category) ?? null,
    );
    return { category, cells };
  });
  return rows.sort((a, b) => {
    const at = a.cells.reduce((s, c) => s + (c?.planned ?? 0), 0);
    const bt = b.cells.reduce((s, c) => s + (c?.planned ?? 0), 0);
    return bt - at;
  });
}

// -- Debt --------------------------------------------------------------------

export function debtToSim(d: Debt): SimDebt {
  return {
    id: d.id,
    name: d.name,
    apr: Number(d.apr),
    balance: Number(d.balance),
    minPayment: Number(d.minPayment),
    status: d.status,
  };
}

export function payoffStackedSeries(
  sim: SimResult,
  debts: SimDebt[],
): { month: string; date: Date; total: number; [debtKey: string]: number | string | Date }[] {
  // Recharts stacked Area requires keyed columns per debt.
  const cap = Math.min(sim.months.length, 120);
  const out: ReturnType<typeof payoffStackedSeries> = [];
  for (let i = 0; i < cap; i++) {
    const m = sim.months[i];
    const row: Record<string, number | string | Date> = {
      month: fmtMonthLabel(m.date),
      date: m.date,
      total: Math.round(m.totalBalanceEnd),
    };
    for (const d of debts) {
      const snap = m.perDebt.find((p) => p.id === d.id);
      row[d.name] = snap ? Math.round(snap.endBalance) : 0;
    }
    out.push(row as (typeof out)[number]);
  }
  return out;
}

// Snowball waterfall: per killed debt, the cumulative freed-up minimums that
// roll into the next debt as each one is killed.
export function snowballWaterfall(sim: SimResult): {
  name: string;
  monthLabel: string;
  freed: number;
  cumulative: number;
}[] {
  let cum = 0;
  return sim.killedOrder.map((k) => {
    cum += k.minFreed;
    return {
      name: k.name,
      monthLabel: fmtMonthLabel(k.date),
      freed: Math.round(k.minFreed * 100) / 100,
      cumulative: Math.round(cum * 100) / 100,
    };
  });
}

// Interest vs principal per month for the next N months.
export function interestVsPrincipal(
  sim: SimResult,
  monthsAhead = 24,
): { month: string; interest: number; principal: number }[] {
  return sim.months.slice(0, monthsAhead).map((m) => ({
    month: fmtMonthLabel(m.date),
    interest: Math.round(m.totalInterest * 100) / 100,
    principal: Math.round((m.totalMinsPaid + m.totalExtraPaid - m.totalInterest) * 100) / 100,
  }));
}

export function perDebtProgress(
  debts: Debt[],
  sim: SimResult,
): {
  id: string;
  name: string;
  balance: number;
  apr: number;
  minPayment: number;
  payoffDate: Date | null;
  monthsLeft: number | null;
}[] {
  const killById = new Map(sim.killedOrder.map((k) => [k.id, k] as const));
  return debts
    .filter((d) => d.status === "active")
    .map((d) => {
      const kill = killById.get(d.id);
      return {
        id: d.id,
        name: d.name,
        balance: Number(d.balance),
        apr: Number(d.apr),
        minPayment: Number(d.minPayment),
        payoffDate: kill?.date ?? null,
        monthsLeft: kill?.monthIndex ?? null,
      };
    })
    .sort((a, b) => (a.monthsLeft ?? 9999) - (b.monthsLeft ?? 9999));
}

// Total interest you'd pay if you only ever paid the minimums on every debt
// (no avalanche/snowball ordering, no extra). Useful as a comparison point
// for "interest avoided" by following the plan.
export function interestIfMinimumsOnly(debts: SimDebt[]): number {
  let total = 0;
  for (const d of debts) {
    if ((d.status ?? "active") !== "active") continue;
    const r = d.apr / 12;
    const P = d.balance;
    const M = d.minPayment;
    if (P <= 0 || M <= 0) continue;
    if (r <= 0) continue;
    if (M <= P * r) return Infinity;
    const n = -Math.log(1 - (r * P) / M) / Math.log(1 + r);
    total += Math.ceil(n) * M - P;
  }
  return Math.max(0, total);
}

// -- Behaviour ----------------------------------------------------------------

export function daysSinceLast(
  txns: Transaction[],
  matcher: (t: Transaction) => boolean,
  today: Date,
): number | null {
  let latest: string | null = null;
  for (const t of txns) {
    if (!matcher(t)) continue;
    if (latest === null || t.occurredOn > latest) latest = t.occurredOn;
  }
  if (!latest) return null;
  const d = new Date(latest + "T00:00:00");
  return Math.max(0, Math.floor((today.getTime() - d.getTime()) / 86_400_000));
}

// Day-of-month spending pattern: real data, one bucket per day-of-month.
export function spendByDayOfMonth(
  txns: Transaction[],
): { day: number; label: string; amount: number }[] {
  const buckets = new Array<number>(31).fill(0);
  for (const t of txns) {
    const e = expense(t);
    if (e <= 0) continue;
    const day = Number(t.occurredOn.slice(8, 10));
    if (day >= 1 && day <= 31) buckets[day - 1] += e;
  }
  return buckets.map((amount, i) => ({
    day: i + 1,
    label: String(i + 1),
    amount: Math.round(amount * 100) / 100,
  }));
}

// Hourly spend clock — uses ONLY transactions whose occurredOn carries a time
// component (e.g. "2026-04-12T14:33:00"). Returns null when no transaction in
// the input has any time component, so the caller can render an honest empty
// state rather than fabricating hours.
export function hourlySpendClock(
  txns: Transaction[],
): { hour: number; label: string; amount: number }[] | null {
  const buckets = new Array<number>(24).fill(0);
  let used = 0;
  for (const t of txns) {
    const e = expense(t);
    if (e <= 0) continue;
    if (t.occurredOn.length <= 10 || !t.occurredOn.includes("T")) continue;
    const h = Number(t.occurredOn.slice(11, 13));
    if (Number.isNaN(h)) continue;
    buckets[h] += e;
    used += 1;
  }
  if (used === 0) return null;
  return buckets.map((amount, hour) => ({
    hour,
    label: hour === 0 ? "12a" : hour < 12 ? `${hour}a` : hour === 12 ? "12p" : `${hour - 12}p`,
    amount: Math.round(amount * 100) / 100,
  }));
}

// Per-category cumulative burndown for the selected month: a line per top
// category, with cumulative actual spend through each day vs. the paced plan.
export function perCategoryBurndown(
  budget: BudgetMonthDetail | undefined,
  txns: Transaction[],
  monthStart: string,
  today: Date,
  topN = 5,
): {
  daysInMonth: number;
  categories: { id: string; name: string; planned: number; series: { day: number; actual: number | null; planned: number }[] }[];
} {
  if (!budget) return { daysInMonth: 30, categories: [] };
  const start = new Date(monthStart + "T00:00:00");
  const daysInMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const isCurrentMonth =
    start.getFullYear() === today.getFullYear() && start.getMonth() === today.getMonth();
  const cursor = isCurrentMonth ? today.getDate() : daysInMonth;
  const lines = budget.lines
    .map((l) => ({
      id: l.categoryId,
      name: l.categoryName,
      planned: Number(l.plannedAmount) || 0,
    }))
    .filter((l) => l.planned > 0)
    .sort((a, b) => b.planned - a.planned)
    .slice(0, topN);
  const idSet = new Set(lines.map((l) => l.id));
  const dailyByCat = new Map<string, number[]>();
  for (const id of idSet) dailyByCat.set(id, new Array<number>(daysInMonth + 1).fill(0));
  for (const t of txns) {
    if (!t.occurredOn.startsWith(monthStart.slice(0, 7))) continue;
    if (!t.categoryId || !idSet.has(t.categoryId)) continue;
    const e = expense(t);
    if (e <= 0) continue;
    const day = Number(t.occurredOn.slice(8, 10));
    if (day < 1 || day > daysInMonth) continue;
    dailyByCat.get(t.categoryId)![day] += e;
  }
  const categories = lines.map((l) => {
    const daily = dailyByCat.get(l.id) ?? new Array<number>(daysInMonth + 1).fill(0);
    let cumActual = 0;
    const series: { day: number; actual: number | null; planned: number }[] = [];
    for (let d = 1; d <= daysInMonth; d++) {
      cumActual += daily[d];
      const planned = (l.planned * d) / daysInMonth;
      series.push({
        day: d,
        actual: d <= cursor ? Math.round(cumActual * 100) / 100 : null,
        planned: Math.round(planned * 100) / 100,
      });
    }
    return { id: l.id, name: l.name, planned: l.planned, series };
  });
  return { daysInMonth, categories };
}

// Streak: how many of the last `windowMonths` calendar months had total
// expense ≤ total income (i.e. positive net cash flow). Real data.
export function onTrackMonthStreak(
  txns: Transaction[],
  today: Date,
  windowMonths = 6,
): Streak {
  const monthsBack: string[] = [];
  for (let i = 0; i < windowMonths; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    monthsBack.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  const totals = new Map<string, { i: number; e: number }>();
  for (const t of txns) {
    const k = t.occurredOn.slice(0, 7);
    if (!monthsBack.includes(k)) continue;
    const slot = totals.get(k) ?? { i: 0, e: 0 };
    slot.i += income(t);
    slot.e += expense(t);
    totals.set(k, slot);
  }
  // Most recent first; current streak = leading run starting from this month.
  let current = 0;
  let longest = 0;
  let run = 0;
  for (const k of monthsBack) {
    const s = totals.get(k);
    const ok = s ? s.i >= s.e : false;
    if (ok) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  // Compute current streak (leading consecutive months from today).
  for (const k of monthsBack) {
    const s = totals.get(k);
    const ok = s ? s.i >= s.e : false;
    if (!ok) break;
    current += 1;
  }
  return { current, longest };
}

// Streak: consecutive months in the trailing window where total actual
// spend ≤ total planned spend. Honest because it's computed from real budget
// + actual numbers; if budget rows are missing for a month, that month
// breaks the streak (we don't pretend it was on-plan).
export function underBudgetMonthStreak(
  budgets: (BudgetMonthDetail | undefined)[],
): Streak {
  // budgets[] is in chronological order, oldest -> newest; the current month
  // sits at the end.
  const flags: boolean[] = [];
  for (const b of budgets) {
    if (!b || b.lines.length === 0) {
      flags.push(false);
      continue;
    }
    const planned = b.lines.reduce((s, l) => s + Number(l.plannedAmount), 0);
    const actual = b.lines.reduce((s, l) => s + Number(l.actualAmount), 0);
    flags.push(planned > 0 && actual <= planned);
  }
  let longest = 0;
  let run = 0;
  for (const f of flags) {
    if (f) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  let current = 0;
  for (let i = flags.length - 1; i >= 0; i--) {
    if (!flags[i]) break;
    current += 1;
  }
  return { current, longest };
}

// "Plan progress" gauge for the debt thermometer. We don't have a true
// historical "starting balance" snapshot, but the avalanche projection IS
// real, so we surface the next 12 months of projected payoff as a percentage:
// % of TODAY'S total balance the plan eliminates over the next year.
export function payoffProjectionGauge(
  sim: SimResult,
  monthsAhead = 12,
): { pct: number; eliminated: number; startingBalance: number; monthsAhead: number } {
  const start = sim.startingTotalBalance;
  if (start <= 0) {
    return { pct: 0, eliminated: 0, startingBalance: 0, monthsAhead };
  }
  const idx = Math.min(monthsAhead, sim.months.length) - 1;
  const endBal =
    idx >= 0 ? sim.months[idx].totalBalanceEnd : start;
  const eliminated = Math.max(0, start - endBal);
  return {
    pct: Math.min(100, (eliminated / start) * 100),
    eliminated: Math.round(eliminated),
    startingBalance: Math.round(start),
    monthsAhead,
  };
}

export type BiggestEntry = { description: string; amount: number; date: string };

export function biggest(txns: Transaction[]): {
  expense: BiggestEntry | null;
  income: BiggestEntry | null;
} {
  let bigE: BiggestEntry | null = null;
  let bigI: BiggestEntry | null = null;
  for (const t of txns) {
    const a = Number(t.amount) || 0;
    if (a < 0) {
      const v = -a;
      if (!bigE || v > bigE.amount) bigE = { description: t.description, amount: v, date: t.occurredOn };
    } else if (a > 0) {
      if (!bigI || a > bigI.amount) bigI = { description: t.description, amount: a, date: t.occurredOn };
    }
  }
  return { expense: bigE, income: bigI };
}

export type Streak = { current: number; longest: number };

// Longest streak of consecutive days with no transaction matching `matcher`.
export function noPurchaseStreak(
  txns: Transaction[],
  matcher: (t: Transaction) => boolean,
  today: Date,
  windowDays = 180,
): Streak {
  const hit = new Set<string>();
  for (const t of txns) if (matcher(t)) hit.add(t.occurredOn);
  let longest = 0;
  let run = 0;
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (windowDays - 1 - i));
    if (hit.has(fmtISO(d))) {
      run = 0;
    } else {
      run += 1;
      if (run > longest) longest = run;
    }
  }
  let current = 0;
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (windowDays - 1 - i));
    if (hit.has(fmtISO(d))) break;
    current += 1;
  }
  return { current, longest };
}

// Money personality radar across a few coarse axes — heuristic match by
// category name keywords so it works without any new tagging.
const PERSONALITY_RULES: { axis: string; keywords: string[] }[] = [
  { axis: "Essentials", keywords: ["rent", "mortgage", "utility", "utilities", "electric", "water", "gas", "internet", "phone", "insurance"] },
  { axis: "Lifestyle", keywords: ["shopping", "amazon", "clothing", "personal", "household", "home", "pets"] },
  { axis: "Transport", keywords: ["gas", "fuel", "uber", "lyft", "transit", "parking", "auto", "car"] },
  { axis: "Food", keywords: ["grocery", "groceries", "dining", "restaurant", "coffee", "food"] },
  { axis: "Entertainment", keywords: ["entertainment", "subscription", "music", "movie", "stream", "game"] },
  { axis: "Debt Paydown", keywords: ["payment", "loan", "card", "credit", "debt"] },
];

export function personalityRadar(
  txns: Transaction[],
  catNameById: Map<string, string>,
): { axis: string; value: number }[] {
  const totals = new Map<string, number>(PERSONALITY_RULES.map((r) => [r.axis, 0]));
  for (const t of txns) {
    const e = expense(t);
    if (e <= 0) continue;
    const haystack = (
      (t.categoryId ? catNameById.get(t.categoryId) ?? "" : "") +
      " " +
      (t.description ?? "")
    ).toLowerCase();
    let placed = false;
    for (const rule of PERSONALITY_RULES) {
      if (rule.keywords.some((k) => haystack.includes(k))) {
        totals.set(rule.axis, (totals.get(rule.axis) ?? 0) + e);
        placed = true;
        break;
      }
    }
    if (!placed) {
      totals.set("Lifestyle", (totals.get("Lifestyle") ?? 0) + e);
    }
  }
  const max = Math.max(1, ...Array.from(totals.values()));
  return PERSONALITY_RULES.map((r) => ({
    axis: r.axis,
    value: Math.round(((totals.get(r.axis) ?? 0) / max) * 100),
  }));
}

// -- Helpers ----------------------------------------------------------------

export function monthRange(today: Date, monthsBack: number): { start: Date; end: Date } {
  const start = new Date(today.getFullYear(), today.getMonth() - monthsBack + 1, 1);
  const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  return { start, end };
}

export function debtsKilledOrder(sim: SimResult) {
  return sim.killedOrder.map((k, i) => ({
    rank: i + 1,
    name: k.name,
    date: k.date,
    label: fmtMonthLabel(k.date),
    monthIndex: k.monthIndex,
  }));
}

export function debtFreeCountdown(sim: SimResult, today: Date): {
  months: number | null;
  days: number | null;
  date: Date | null;
} {
  if (sim.ranOutOfTime || !sim.debtFreeDate) return { months: null, days: null, date: null };
  const date = sim.debtFreeDate;
  const months = sim.monthsToFreedom;
  const days = Math.max(0, Math.floor((date.getTime() - today.getTime()) / 86_400_000));
  return { months, days, date };
}

export function totalsForDebts(debts: Debt[]) {
  let totalBalance = 0;
  let totalMin = 0;
  for (const d of debts) {
    if (d.status !== "active") continue;
    totalBalance += Number(d.balance);
    totalMin += Number(d.minPayment);
  }
  return { totalBalance, totalMin };
}

export { simulate };
export type { Strategy, SimResult, SimDebt };

// Used by Recharts components that don't accept undefined for `payload`.
export function safeNumber(n: number | string | null | undefined, fallback = 0): number {
  if (n === null || n === undefined) return fallback;
  const v = typeof n === "string" ? Number(n) : n;
  return Number.isFinite(v) ? v : fallback;
}
