// (#854 — Budget overhaul, Phase 1) Pure budget-line classifier + judgement.
//
// The Reports → Budget tab used to grade every budget line on a single
// "% of plan used" axis, which produces three wrong signals:
//   - income overperforming reads as "over budget" (red)
//   - a missing paycheck reads as "under budget" (green)
//   - debts / fixed bills that hit their exact target get flagged red
//
// This module classifies each line into one of four KINDS and judges each on
// the axis that actually matters for that kind. It has NO db calls — the
// facts builder (budgetFacts.ts) loads the context and calls these helpers.

export type BudgetLineClass = "income" | "debt" | "bill" | "flex";

export type LineStatus = "good" | "watch" | "miss";

// The minimal line shape needed to classify. `kind` is the category kind
// ("income" | "expense"), `sourceKind` is how the category is sourced
// ("manual" | "auto_bills" | "auto_debts"), `debtId` links to a tracked debt.
export interface ClassifiableLine {
  kind: string;
  sourceKind: string;
  debtId?: string | null;
}

// income  = the category is an income category.
// debt    = sourced from the Debt Tracker (auto_debts).
// bill    = an auto-pulled recurring expense bill (auto_bills + expense).
// flex    = everything else — i.e. a manual expense envelope (Dining, etc.).
export function classifyBudgetLine(line: ClassifiableLine): BudgetLineClass {
  if (line.kind === "income") return "income";
  if (line.sourceKind === "auto_debts") return "debt";
  if (line.sourceKind === "auto_bills" && line.kind === "expense") return "bill";
  return "flex";
}

// Judge a single line into a discrete status. The raw pct is intentionally
// NOT returned here — it lives in the facts payload alongside the status.
//
// `monthHasPassed` is true once the whole month is in the past, which flips a
// few "still in progress" leniencies (a missing paycheck or an unpaid bill is
// only a `miss` once the month is over; mid-month it's a `watch`).
export function judgeLine(
  cls: BudgetLineClass,
  planned: number,
  actual: number,
  monthHasPassed: boolean,
): LineStatus {
  switch (cls) {
    case "income": {
      // Income is judged on "did the money show up?" — overperforming is
      // good, never "over budget".
      if (planned === 0) return "good";
      const pct = actual / planned;
      if (pct >= 0.95) return "good";
      if (pct >= 0.5) return "watch";
      // Below half the planned income: still recoverable while the month is
      // in progress, a clear miss once it's over.
      return monthHasPassed ? "miss" : "watch";
    }
    case "debt":
    case "bill": {
      // Fixed obligations are judged on "did we pay roughly the target?" —
      // hitting ~100% is exactly right, not "over budget".
      if (planned === 0 && actual === 0) return "good";
      if (planned === 0 && actual > 0) return "watch";
      const pct = actual / planned;
      if (pct >= 0.9 && pct <= 1.15) return "good";
      if (pct === 0) return monthHasPassed ? "miss" : "watch";
      return "watch";
    }
    case "flex": {
      // Flex envelopes are judged on overspend — under plan is good, a small
      // overrun is a watch, a big overrun is a miss.
      if (planned === 0 && actual === 0) return "good";
      if (planned === 0 && actual > 0) return "watch";
      const pct = actual / planned;
      if (pct <= 1.0) return "good";
      if (pct <= 1.15) return "watch";
      return "miss";
    }
  }
}
