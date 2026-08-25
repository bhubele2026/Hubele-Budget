import type { BudgetMonthDetail } from "@workspace/api-client-react";

/**
 * ⭐ THE PAGE'S ONE ORGANIZING QUESTION: where does this dollar come from?
 *
 * Brad's brief was one sentence — *"do not all one off — all comes from bills
 * and debt payments"* — and this is it, made into a layout. The page reads top
 * to bottom as a claim about provenance:
 *
 *     Income       ← the paychecks, from Bills
 *     Bills        ┐ these two, and only these two,
 *     Debt payments┘ are THE PLAN
 *     Allowance      tracked; its money is already in Bills
 *     Not from a bill  shown, editable, and NOT in the plan
 *
 * The server decides which bucket each line falls in (`planSource`, see
 * api-server/src/lib/budgetPlanSource.ts) so the sections and the headline
 * cannot disagree — the page never re-derives the classification, it only
 * arranges it.
 */
export type PlanSourceKey = "income" | "bills" | "debts" | "unbacked";

export interface PlanSectionDef {
  key: PlanSourceKey;
  title: string;
  /** Four words at most — it sits under the title, not in a paragraph. */
  sub: string;
  /** The one sentence at the foot of the card. */
  foot: string;
  help: string;
  /** False for the sections that are shown but not summed into the plan. */
  inPlan: boolean;
  testId: string;
}

export const PLAN_SECTIONS: readonly PlanSectionDef[] = [
  {
    key: "income",
    title: "Income",
    sub: "Paychecks, from Bills",
    foot: "Every income line is a recurring item on the Bills page. Change one there and it changes here.",
    help: "Recurring income items expanded across this month. Income is judged on whether the money showed up, never on being over plan.",
    inPlan: false,
    testId: "section-income",
  },
  {
    key: "bills",
    title: "Bills",
    sub: "Recurring, by envelope",
    foot: "Each envelope is the sum of the bills pointed at it. Reassign a bill on the Bills page to move it.",
    help: "Every recurring expense item, rolled into the envelope it is assigned to. Most bills do not have their own envelope — Insurance is State Farm plus TruStage.",
    inPlan: true,
    testId: "section-bills",
  },
  {
    key: "debts",
    title: "Debt payments",
    sub: "Minimums and the extra",
    foot: "Minimums come from the Debt Tracker; the extra is the Avalanche page's. Change either there.",
    help: "One line per active debt at its current minimum payment, plus the Avalanche extra.",
    inPlan: true,
    testId: "section-debts",
  },
  {
    key: "unbacked",
    title: "Not from a bill",
    sub: "Planned by hand",
    foot: "These are not in the plan above. Give one a bill on the Bills page, or spend it out of the allowance, and it joins.",
    help: "Envelopes with no recurring item and no debt behind them. They are deliberately left out of the planned total so the month is not planned twice for money that already lives in a bill or in the allowance.",
    inPlan: false,
    testId: "section-unbacked",
  },
] as const;

export type BudgetLine = BudgetMonthDetail["lines"][number];

/**
 * Split a month's lines into the four sections, biggest plan first.
 *
 * ⚠️ SORTED BY SIZE, NOT BY `sortOrder`. Hand-ordering went away with the drag
 * handle: within a source the only ranking a reader wants is "what is the
 * money", and a stable one means the same envelope does not move between two
 * renders of the same month. Ties fall back to the name so the order is total.
 */
export function splitBySource(
  lines: readonly BudgetLine[],
): Record<PlanSourceKey, BudgetLine[]> {
  const out: Record<PlanSourceKey, BudgetLine[]> = {
    income: [],
    bills: [],
    debts: [],
    unbacked: [],
  };
  for (const l of lines) {
    const key = (l.planSource ?? "unbacked") as PlanSourceKey;
    (out[key] ?? out.unbacked).push(l);
  }
  for (const key of Object.keys(out) as PlanSourceKey[]) {
    out[key].sort((a, b) => {
      const d =
        (parseFloat(b.plannedAmount) || 0) - (parseFloat(a.plannedAmount) || 0);
      if (d !== 0) return d;
      const e =
        (parseFloat(b.actualAmount) || 0) - (parseFloat(a.actualAmount) || 0);
      if (e !== 0) return e;
      return a.categoryName.localeCompare(b.categoryName);
    });
  }
  return out;
}

/**
 * The verdict for a whole section, in words.
 *
 * ⚠️ INCOME IS JUDGED ON ARRIVAL, EXPENSES ON OVERSPEND. Grading both on
 * "percent of plan used" is what made a good month — a bonus landing — read as
 * "over budget" in red, and a missed paycheck read as "under budget" in green.
 * Same split as the server's `judgeLine` (api-server/src/lib/budgetLineClass.ts).
 */
export function sectionVerdict(
  key: PlanSourceKey,
  planned: number,
  actual: number,
): { word: string; tone: "ok" | "warn" | "bad" | "gray" } {
  if (planned === 0 && actual === 0) return { word: "nothing yet", tone: "gray" };
  if (key === "income") {
    if (planned === 0) return { word: "no plan", tone: "gray" };
    const pct = actual / planned;
    if (pct >= 0.95) return { word: "arrived", tone: "ok" };
    if (pct >= 0.5) return { word: "part in", tone: "warn" };
    return { word: "waiting", tone: "warn" };
  }
  if (planned === 0) return { word: "no plan", tone: "gray" };
  if (actual > planned) return { word: "over", tone: "bad" };
  return { word: "inside plan", tone: "ok" };
}
