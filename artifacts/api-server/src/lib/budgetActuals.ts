// (PR-D, owner decisions 6 and 14) The Budget month's spend side: category
// actuals and the allowance card's aggregate rows, from ONE pass over the
// month's ledger rows.
//
// It replaced two SQL SUMs because a posted row that replaced a filed pending
// row counts under the pending row's filing (review H1, `effectiveFiling`), and
// that filing lives on another row — SQL grouped by the stored columns cannot
// see it. The arithmetic is the SQL's, unchanged:
//   - spend:  `amex` source and amount > 0 → amount; any other source and
//             amount < 0 → −amount; else 0;
//   - inflow: the mirror;
//   - category actuals skip transfers only (a row with no category has no line);
//   - the allowance skips transfers, card payments, reimbursables and debt
//     payments (`isCountableSpend`), and buckets by unplanned > monthly > weekly.
// Whole cents throughout.
//
// Pure: the route reads the rows and the pairs (one snapshot), this arranges.

import type { AllowanceAggregateRow } from "./budgetAllowance";
import { effectiveFiling, type Filing } from "./pendingFiling";
import type { SupersededPending } from "./supersededPending";

/** One ledger row, as the Budget month reads it. */
export interface BudgetMonthRow extends Filing {
  id: string;
  source: string;
  amount: string;
  pending: boolean;
  isTransfer: boolean;
  isExternalCardPayment: boolean;
}

/** Whole cents, split by posting state. */
export type PostingSplit = { posted: number; pending: number };

export interface CategoryActual {
  spend: PostingSplit;
  inflow: PostingSplit;
  /** Per source: rows, spend cents, inflow cents (both halves merged). */
  sources: Map<string, { count: number; spend: number; inflow: number }>;
}

export interface BudgetMonthSpend {
  byCategory: Map<string, CategoryActual>;
  /** One row per countable, bucketed transaction — `buildAllowanceRollup` sums them. */
  allowanceRows: AllowanceAggregateRow[];
  /** Pending rows in the month a posted row replaced: counted nowhere. Sorted. */
  replacedPendingIds: string[];
  /** Posted rows counted under a category they do not store. Sorted by id. */
  inheritedCategories: { transactionId: string; categoryId: string }[];
}

const centsOf = (amount: string): number => Math.round((parseFloat(amount) || 0) * 100);

export function spendCents(source: string, cents: number): number {
  if (source === "amex") return cents > 0 ? cents : 0;
  return cents < 0 ? -cents : 0;
}

export function inflowCents(source: string, cents: number): number {
  if (source === "amex") return cents < 0 ? -cents : 0;
  return cents > 0 ? cents : 0;
}

export function aggregateBudgetMonth(
  rows: readonly BudgetMonthRow[],
  supersede: Pick<SupersededPending, "replacedIds" | "replacedBy">,
  uncategorizedIds: ReadonlySet<string>,
): BudgetMonthSpend {
  const byCategory = new Map<string, CategoryActual>();
  const allowanceRows: AllowanceAggregateRow[] = [];
  const replacedPendingIds: string[] = [];
  const inheritedCategories: { transactionId: string; categoryId: string }[] = [];

  for (const row of rows) {
    // A pending row its posted row replaced counts nowhere: the posted row
    // carries the charge at its final amount.
    if (supersede.replacedIds.has(row.id)) {
      replacedPendingIds.push(row.id);
      continue;
    }
    const t = effectiveFiling(row, supersede.replacedBy.get(row.id)?.filing, uncategorizedIds);
    if (t.categoryId && t.categoryId !== row.categoryId) {
      inheritedCategories.push({ transactionId: row.id, categoryId: t.categoryId });
    }

    const cents = centsOf(row.amount);
    const spend = spendCents(row.source, cents);
    const inflow = inflowCents(row.source, cents);

    if (!row.isTransfer && t.categoryId) {
      const a = byCategory.get(t.categoryId) ?? {
        spend: { posted: 0, pending: 0 },
        inflow: { posted: 0, pending: 0 },
        sources: new Map(),
      };
      if (row.pending) {
        a.spend.pending += spend;
        a.inflow.pending += inflow;
      } else {
        a.spend.posted += spend;
        a.inflow.posted += inflow;
      }
      const s = a.sources.get(row.source) ?? { count: 0, spend: 0, inflow: 0 };
      s.count += 1;
      s.spend += spend;
      s.inflow += inflow;
      a.sources.set(row.source, s);
      byCategory.set(t.categoryId, a);
    }

    if (!row.isTransfer && !row.isExternalCardPayment && !t.reimbursable && !t.debtId) {
      const bucket = t.unplannedAllowance
        ? "unplanned"
        : t.monthlyAllowance
          ? "monthly"
          : t.weeklyAllowance
            ? "weekly"
            : null;
      if (bucket) {
        allowanceRows.push({
          bucket,
          subBucket: t.weeklyBucket,
          pending: row.pending,
          spend: (spend / 100).toFixed(2),
          cnt: "1",
        });
      }
    }
  }

  replacedPendingIds.sort();
  inheritedCategories.sort((a, b) => a.transactionId.localeCompare(b.transactionId));
  return { byCategory, allowanceRows, replacedPendingIds, inheritedCategories };
}
