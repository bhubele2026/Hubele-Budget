// The Budget page's organizing question: WHERE DOES THIS DOLLAR COME FROM?
//
// Brad, on the old page: "do not all one off — all comes from bills and debt
// payments". That is the model, made literal:
//
//     Planned  =  Bills  +  Debt payments
//     Income   =  Bills (the paychecks)
//
// Everything else on the page is TRACKING, not planning, and must never be
// added to the plan again:
//
//   - The allowance (weekly / monthly / unplanned) is already in the plan, as
//     the `Weekly Spend` and `Monthly Spend` recurring items that fund it.
//     Counting the caps a second time is what produced "there is a 1800 weekly,
//     but also weekly in dining and groceries".
//   - An `unbacked` envelope — a hand-seeded or user-created category with no
//     recurring item and no debt behind it — has a planned amount the user can
//     see and edit, but it is NOT part of `plannedTotal`. Its money is expected
//     to live inside a bill or inside the allowance; until it does, the page
//     says so in words rather than silently inflating the month.
//
// Pure classification — no db, no arithmetic beyond summing what it is handed.
// The route (routes/budget.ts) loads the context and calls these.

import { classifyBudgetLine } from "./budgetLineClass";

export type PlanSource = "income" | "bills" | "debts" | "unbacked";

/** The minimal line shape needed to place a line under a source. */
export interface SourceableLine {
  kind: string;
  sourceKind: string;
  /** How many recurring items roll into this category for the viewed month. */
  linkedBillCount: number;
  /** True for the single system-managed "Avalanche payment" row. */
  isAvalanchePayment?: boolean;
}

/**
 * ⚠️ BILL-BACKING BEATS `sourceKind`. Most expense bills do NOT get their own
 * category — the user points each one at a curated envelope on the Bills page
 * (Insurance = State Farm + TruStage), so a bill-backed envelope still carries
 * `sourceKind: "manual"`. Classifying on `sourceKind` alone would file every
 * one of those as unbacked and empty the plan.
 *
 * The Avalanche payment is a debt payment that is also `sourceKind: "manual"`
 * (it is system-managed from the Avalanche page, not from the Debt Tracker),
 * so it is named explicitly rather than inferred.
 */
export function planSourceOf(line: SourceableLine): PlanSource {
  if (line.isAvalanchePayment) return "debts";
  const cls = classifyBudgetLine(line);
  if (cls === "income") return "income";
  if (cls === "debt") return "debts";
  return line.linkedBillCount > 0 ? "bills" : "unbacked";
}

export interface PlanBucket {
  planned: string;
  actual: string;
  lineCount: number;
}

export interface PlanBySource {
  income: PlanBucket;
  bills: PlanBucket;
  debts: PlanBucket;
  unbacked: PlanBucket;
  /** ⚠️ bills + debts. `unbacked` is deliberately NOT in here. */
  plannedTotal: string;
  /** Actual spend against the planned sources — bills + debts. */
  actualTotal: string;
  /** Planned income less `plannedTotal`. */
  net: string;
}

interface SummableLine {
  planSource: PlanSource;
  plannedAmount: string;
  actualAmount: string;
}

const money = (n: number): string => n.toFixed(2);

/**
 * Roll a month's lines up by source. Every figure the Budget page shows in its
 * hero and its section heads comes from here, so the page itself does no money
 * arithmetic (CLAUDE.md §1) and the sections cannot disagree with the total.
 */
export function rollUpPlanBySource(lines: readonly SummableLine[]): PlanBySource {
  const acc: Record<PlanSource, { planned: number; actual: number; n: number }> =
    {
      income: { planned: 0, actual: 0, n: 0 },
      bills: { planned: 0, actual: 0, n: 0 },
      debts: { planned: 0, actual: 0, n: 0 },
      unbacked: { planned: 0, actual: 0, n: 0 },
    };

  for (const l of lines) {
    const b = acc[l.planSource];
    b.planned += parseFloat(l.plannedAmount) || 0;
    b.actual += parseFloat(l.actualAmount) || 0;
    b.n += 1;
  }

  const bucket = (s: PlanSource): PlanBucket => ({
    planned: money(acc[s].planned),
    actual: money(acc[s].actual),
    lineCount: acc[s].n,
  });

  const plannedTotal = acc.bills.planned + acc.debts.planned;
  const actualTotal = acc.bills.actual + acc.debts.actual;

  return {
    income: bucket("income"),
    bills: bucket("bills"),
    debts: bucket("debts"),
    unbacked: bucket("unbacked"),
    plannedTotal: money(plannedTotal),
    actualTotal: money(actualTotal),
    net: money(acc.income.planned - plannedTotal),
  };
}
