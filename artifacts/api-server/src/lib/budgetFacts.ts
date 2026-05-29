// (#854 — Budget overhaul, Phase 1) Structured, class-aware Budget facts.
//
// Mirrors spendingFacts.ts / behaviorFacts.ts in shape: a thin route handler
// calls buildBudgetFacts(), which loads the same line set + actuals the
// `GET /budget/months/:monthStart` endpoint computes, classifies every line
// into income / debt / bill / flex (budgetLineClass.ts), and judges each on
// the right axis. No UI is wired to this yet — Phase 2 rebuilds the Budget
// tab on top of this pipeline.
//
// Actuals reuse the amex-aware signed-sum semantics already implemented in
// routes/budget.ts and reportsAdvisorSummary.ts buildBudgetFacts (the sum is
// not currently extracted into a shared helper; it is duplicated inline in
// both places, so this third copy stays faithful to those rather than
// inventing a new convention). Amex charges are POSITIVE (spend), bank
// outflows are NEGATIVE (spend); income categories use the inflow side.

import { and, eq, gte, lt } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  db,
  transactionsTable,
  budgetCategoriesTable,
  budgetLinesTable,
} from "@workspace/db";
import {
  classifyBudgetLine,
  judgeLine,
  type BudgetLineClass,
  type LineStatus,
} from "./budgetLineClass";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

// --- Output shape ----------------------------------------------------------
export interface BudgetLineFact {
  categoryId: string;
  name: string;
  class: BudgetLineClass;
  planned: number;
  actual: number;
  pct: number;
  status: LineStatus;
}

export interface FlexLineFact extends BudgetLineFact {
  unbudgeted: boolean;
}

export interface BudgetClassSection {
  paidCount: number;
  totalCount: number;
  lines: BudgetLineFact[];
}

export interface BudgetFlexSection {
  paidCount: number;
  totalCount: number;
  lines: FlexLineFact[];
  plannedTotal: number;
  actualTotal: number;
  pacePlanToDate: number;
  paceStatus: "under" | "on_track" | "over";
  projectedMonthEnd: number;
  projectedVsPlan: number;
  burndown: {
    day: number;
    date: string;
    plannedCumulative: number;
    actualCumulative: number | null;
  }[];
}

export interface BudgetStreakRow {
  categoryId: string;
  name: string;
  class: BudgetLineClass;
  currentStreakGood: number;
  longestStreakGood: number;
  cells: (LineStatus | null)[];
}

export interface BudgetFacts {
  range: {
    monthStart: string;
    monthEnd: string;
    daysInMonth: number;
    daysElapsed: number;
    monthHasPassed: boolean;
    monthLabel: string;
    monthsBack: number;
  };
  income: BudgetClassSection;
  bills: BudgetClassSection;
  debts: BudgetClassSection;
  flex: BudgetFlexSection;
  streak: {
    monthKeys: string[];
    rows: BudgetStreakRow[];
  };
}

// --- Helpers ---------------------------------------------------------------
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function pctWhole(actual: number, planned: number): number {
  if (planned <= 0) return 0;
  return Math.round((actual / planned) * 100);
}

function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

interface MonthBounds {
  monthStart: string;
  monthEnd: string; // last day, inclusive (YYYY-MM-DD)
  nextMonthStart: string; // first day of next month (exclusive upper bound)
  daysInMonth: number;
  monthKey: string; // YYYY-MM
  monthLabel: string; // "May 2026"
  monthHasPassed: boolean;
  daysElapsed: number; // clamped 1..daysInMonth
}

function monthBounds(monthStart: string, todayIso: string): MonthBounds {
  const d = new Date(`${monthStart}T00:00:00Z`);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  const nextMonth = new Date(Date.UTC(year, month + 1, 1));
  const daysInMonth = lastDay.getUTCDate();
  const monthEnd = lastDay.toISOString().slice(0, 10);
  const nextMonthStart = nextMonth.toISOString().slice(0, 10);
  const monthKey = monthStart.slice(0, 7);
  const monthLabel = `${MONTH_NAMES[month]} ${year}`;

  const monthHasPassed = todayIso > monthEnd;
  let daysElapsed: number;
  if (monthHasPassed) {
    daysElapsed = daysInMonth;
  } else if (todayIso < monthStart) {
    daysElapsed = 1; // requested month is in the future — clamp
  } else {
    daysElapsed = Number(todayIso.slice(8, 10));
  }
  daysElapsed = Math.min(daysInMonth, Math.max(1, daysElapsed));

  return {
    monthStart,
    monthEnd,
    nextMonthStart,
    daysInMonth,
    monthKey,
    monthLabel,
    monthHasPassed,
    daysElapsed,
  };
}

// Step monthStart back by `n` whole months, returning the first-of-month ISO.
function monthStartMinus(monthStart: string, n: number): string {
  const d = new Date(`${monthStart}T00:00:00Z`);
  const back = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1));
  return back.toISOString().slice(0, 10);
}

interface CategoryMeta {
  name: string;
  kind: string;
  sourceKind: string;
  debtId: string | null;
  excludeFromBudget: boolean;
}

// A judged line for a single month (used by both the requested-month sections
// and the streak board). Only ACTIVE lines (planned>0 OR actual>0) are
// returned — inactive $0/$0 rows are noise.
interface JudgedLine {
  categoryId: string;
  name: string;
  class: BudgetLineClass;
  planned: number;
  actual: number;
  status: LineStatus;
}

// Load + classify + judge every active, non-excluded budget line for one
// month. Returns the judged lines plus the amex-aware per-category actuals
// (so the caller can derive flex burndown without re-querying).
async function loadMonth(
  householdId: string,
  monthStart: string,
  todayIso: string,
  categoriesById: Map<string, CategoryMeta>,
): Promise<{ bounds: MonthBounds; lines: JudgedLine[] }> {
  const bounds = monthBounds(monthStart, todayIso);

  const lineRows = await db
    .select({
      categoryId: budgetLinesTable.categoryId,
      planned: budgetLinesTable.plannedAmount,
    })
    .from(budgetLinesTable)
    .where(
      and(
        eq(budgetLinesTable.householdId, householdId),
        eq(budgetLinesTable.monthStart, monthStart),
      ),
    );

  // amex-aware spend + inflow per category (transfers excluded). Matches the
  // CASE expressions in routes/budget.ts and reportsAdvisorSummary.ts.
  const actualsRows = await db
    .select({
      categoryId: transactionsTable.categoryId,
      spend: sql<string>`coalesce(sum(case
        when ${transactionsTable.source} = 'amex' and ${transactionsTable.amount} > 0 then ${transactionsTable.amount}
        when ${transactionsTable.source} <> 'amex' and ${transactionsTable.amount} < 0 then -${transactionsTable.amount}
        else 0 end)::text, '0')`,
      inflow: sql<string>`coalesce(sum(case
        when ${transactionsTable.source} = 'amex' and ${transactionsTable.amount} < 0 then -${transactionsTable.amount}
        when ${transactionsTable.source} <> 'amex' and ${transactionsTable.amount} > 0 then ${transactionsTable.amount}
        else 0 end)::text, '0')`,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        gte(transactionsTable.occurredOn, monthStart),
        lt(transactionsTable.occurredOn, bounds.nextMonthStart),
        eq(transactionsTable.isTransfer, false),
      ),
    )
    .groupBy(transactionsTable.categoryId);

  const spendByCat = new Map<string, number>();
  const inflowByCat = new Map<string, number>();
  for (const r of actualsRows) {
    if (!r.categoryId) continue;
    spendByCat.set(r.categoryId, num(r.spend));
    inflowByCat.set(r.categoryId, num(r.inflow));
  }

  const lines: JudgedLine[] = [];
  for (const row of lineRows) {
    const cat = categoriesById.get(row.categoryId);
    if (!cat) continue; // line points at a deleted category — skip
    if (cat.excludeFromBudget) continue; // Uncategorized / Transfer / Ignore

    const cls = classifyBudgetLine(cat);
    const planned = round2(num(row.planned));
    const actual = round2(
      cls === "income"
        ? inflowByCat.get(row.categoryId) ?? 0
        : spendByCat.get(row.categoryId) ?? 0,
    );

    if (planned <= 0 && actual <= 0) continue; // inactive — drop

    const status = judgeLine(cls, planned, actual, bounds.monthHasPassed);
    lines.push({
      categoryId: row.categoryId,
      name: cat.name,
      class: cls,
      planned,
      actual,
      status,
    });
  }

  return { bounds, lines };
}

function sectionFor(
  lines: JudgedLine[],
  cls: BudgetLineClass,
): BudgetClassSection {
  const inClass = lines
    .filter((l) => l.class === cls)
    .map((l) => ({
      categoryId: l.categoryId,
      name: l.name,
      class: l.class,
      planned: l.planned,
      actual: l.actual,
      pct: pctWhole(l.actual, l.planned),
      status: l.status,
    }));
  return {
    paidCount: inClass.filter((l) => l.status === "good").length,
    totalCount: inClass.length,
    lines: inClass.sort((a, b) => b.pct - a.pct),
  };
}

export async function buildBudgetFacts(
  householdId: string,
  monthStart: string,
  monthsBack = 6,
): Promise<BudgetFacts> {
  const todayIso = new Date().toISOString().slice(0, 10);

  // --- Category context (loaded once) ------------------------------------
  const cats = await db
    .select({
      id: budgetCategoriesTable.id,
      name: budgetCategoriesTable.name,
      kind: budgetCategoriesTable.kind,
      sourceKind: budgetCategoriesTable.sourceKind,
      debtId: budgetCategoriesTable.debtId,
      excludeFromBudget: budgetCategoriesTable.excludeFromBudget,
    })
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.householdId, householdId));

  const categoriesById = new Map<string, CategoryMeta>();
  for (const c of cats) {
    categoriesById.set(c.id, {
      name: c.name,
      kind: c.kind,
      sourceKind: c.sourceKind,
      debtId: c.debtId,
      excludeFromBudget: c.excludeFromBudget,
    });
  }

  // --- Requested month ---------------------------------------------------
  const { bounds, lines } = await loadMonth(
    householdId,
    monthStart,
    todayIso,
    categoriesById,
  );

  const income = sectionFor(lines, "income");
  const bills = sectionFor(lines, "bill");
  const debts = sectionFor(lines, "debt");

  // --- Flex section (the only class with pace / projection / burndown) ----
  const flexLines: FlexLineFact[] = lines
    .filter((l) => l.class === "flex")
    .map((l) => ({
      categoryId: l.categoryId,
      name: l.name,
      class: l.class,
      planned: l.planned,
      actual: l.actual,
      pct: pctWhole(l.actual, l.planned),
      status: l.status,
      unbudgeted: l.planned === 0 && l.actual > 0,
    }))
    // Sort by pct desc; unbudgeted overruns (planned 0, actual>0) have no
    // finite pct so they float to the top as the most urgent overspends.
    .sort((a, b) => {
      const ka = a.unbudgeted ? Number.POSITIVE_INFINITY : a.pct;
      const kb = b.unbudgeted ? Number.POSITIVE_INFINITY : b.pct;
      return kb - ka;
    });

  const flexPlannedTotal = round2(
    flexLines.reduce((s, l) => s + l.planned, 0),
  );
  const flexActualTotal = round2(flexLines.reduce((s, l) => s + l.actual, 0));

  const pacePlanToDate = round2(
    (flexPlannedTotal * bounds.daysElapsed) / bounds.daysInMonth,
  );

  let paceStatus: "under" | "on_track" | "over";
  if (pacePlanToDate === 0) {
    paceStatus = flexActualTotal > 0 ? "over" : "on_track";
  } else {
    const ratio = flexActualTotal / pacePlanToDate;
    paceStatus = ratio < 0.95 ? "under" : ratio > 1.05 ? "over" : "on_track";
  }

  const projectedMonthEnd =
    bounds.daysElapsed > 0
      ? round2((flexActualTotal / bounds.daysElapsed) * bounds.daysInMonth)
      : 0;
  const projectedVsPlan = round2(projectedMonthEnd - flexPlannedTotal);

  // Per-day cumulative flex spend for the burndown. Future days (beyond
  // daysElapsed when the month is current) are null.
  const flexCatIds = new Set(
    lines.filter((l) => l.class === "flex").map((l) => l.categoryId),
  );
  const dailyFlexSpend = new Map<string, number>();
  if (flexCatIds.size > 0) {
    const dayRows = await db
      .select({
        occurredOn: transactionsTable.occurredOn,
        categoryId: transactionsTable.categoryId,
        spend: sql<string>`coalesce(sum(case
          when ${transactionsTable.source} = 'amex' and ${transactionsTable.amount} > 0 then ${transactionsTable.amount}
          when ${transactionsTable.source} <> 'amex' and ${transactionsTable.amount} < 0 then -${transactionsTable.amount}
          else 0 end)::text, '0')`,
      })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, householdId),
          gte(transactionsTable.occurredOn, monthStart),
          lt(transactionsTable.occurredOn, bounds.nextMonthStart),
          eq(transactionsTable.isTransfer, false),
        ),
      )
      .groupBy(transactionsTable.occurredOn, transactionsTable.categoryId);
    for (const r of dayRows) {
      if (!r.categoryId || !flexCatIds.has(r.categoryId)) continue;
      dailyFlexSpend.set(
        r.occurredOn,
        (dailyFlexSpend.get(r.occurredOn) ?? 0) + num(r.spend),
      );
    }
  }

  const yearMonth = monthStart.slice(0, 7);
  const burndown: BudgetFlexSection["burndown"] = [];
  let cumulative = 0;
  for (let day = 1; day <= bounds.daysInMonth; day += 1) {
    const date = `${yearMonth}-${String(day).padStart(2, "0")}`;
    const plannedCumulative = round2(
      (flexPlannedTotal * day) / bounds.daysInMonth,
    );
    let actualCumulative: number | null;
    if (day > bounds.daysElapsed && !bounds.monthHasPassed) {
      actualCumulative = null; // future day in an in-progress month
    } else {
      cumulative += dailyFlexSpend.get(date) ?? 0;
      actualCumulative = round2(cumulative);
    }
    burndown.push({ day, date, plannedCumulative, actualCumulative });
  }

  const flex: BudgetFlexSection = {
    paidCount: flexLines.filter((l) => l.status === "good").length,
    totalCount: flexLines.length,
    lines: flexLines,
    plannedTotal: flexPlannedTotal,
    actualTotal: flexActualTotal,
    pacePlanToDate,
    paceStatus,
    projectedMonthEnd,
    projectedVsPlan,
    burndown,
  };

  // --- Streak board (trailing monthsBack months, oldest -> newest) -------
  const monthKeysIso: string[] = [];
  for (let i = monthsBack - 1; i >= 0; i -= 1) {
    monthKeysIso.push(monthStartMinus(monthStart, i));
  }
  const monthKeys = monthKeysIso.map((m) => m.slice(0, 7));

  // status per (monthKey -> categoryId). Reuse the requested-month load for
  // the latest month to avoid a duplicate round-trip.
  const perMonth: Map<string, JudgedLine>[] = [];
  for (const mIso of monthKeysIso) {
    let monthLines: JudgedLine[];
    if (mIso === monthStart) {
      monthLines = lines;
    } else {
      monthLines = (
        await loadMonth(householdId, mIso, todayIso, categoriesById)
      ).lines;
    }
    const byCat = new Map<string, JudgedLine>();
    for (const l of monthLines) byCat.set(l.categoryId, l);
    perMonth.push(byCat);
  }

  // Every category active in any of the months gets a row.
  const streakCatIds = new Set<string>();
  for (const byCat of perMonth) {
    for (const id of byCat.keys()) streakCatIds.add(id);
  }

  const CLASS_ORDER: Record<BudgetLineClass, number> = {
    income: 0,
    bill: 1,
    debt: 2,
    flex: 3,
  };

  const rows: BudgetStreakRow[] = [];
  for (const catId of streakCatIds) {
    const meta = categoriesById.get(catId);
    if (!meta) continue;
    const cls = classifyBudgetLine(meta);
    const cells: (LineStatus | null)[] = perMonth.map(
      (byCat) => byCat.get(catId)?.status ?? null,
    );

    let longest = 0;
    let run = 0;
    for (const c of cells) {
      if (c === "good") {
        run += 1;
        if (run > longest) longest = run;
      } else {
        run = 0;
      }
    }
    let current = 0;
    for (let i = cells.length - 1; i >= 0; i -= 1) {
      if (cells[i] === "good") current += 1;
      else break;
    }

    rows.push({
      categoryId: catId,
      name: meta.name,
      class: cls,
      currentStreakGood: current,
      longestStreakGood: longest,
      cells,
    });
  }
  rows.sort((a, b) => {
    const ca = CLASS_ORDER[a.class];
    const cb = CLASS_ORDER[b.class];
    if (ca !== cb) return ca - cb;
    return a.name.localeCompare(b.name);
  });

  return {
    range: {
      monthStart: bounds.monthStart,
      monthEnd: bounds.monthEnd,
      daysInMonth: bounds.daysInMonth,
      daysElapsed: bounds.daysElapsed,
      monthHasPassed: bounds.monthHasPassed,
      monthLabel: bounds.monthLabel,
      monthsBack,
    },
    income,
    bills,
    debts,
    flex,
    streak: { monthKeys, rows },
  };
}
