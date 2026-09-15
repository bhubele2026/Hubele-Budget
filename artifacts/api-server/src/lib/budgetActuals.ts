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
// The transfer flag, reimbursable and debt tag read are the EFFECTIVE ones: a
// posted row inherits them from its pending row (round 3 L2). Whole cents.
//
// Pure: the route reads the rows and the pairs (one snapshot), this arranges.

import type { AllowanceAggregateRow } from "./budgetAllowance";
import { effectiveFiling, type Filing, type FilingContext } from "./pendingFiling";
import type { SupersededPending } from "./supersededPending";
import { classifyMovement, type MovementContext, type MovementRow } from "./spendingFilter";

/** One ledger row, as the Budget month reads it. */
export interface BudgetMonthRow extends Filing {
  id: string;
  description: string;
  source: string;
  amount: string;
  pending: boolean;
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
  ctx: FilingContext,
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
    const t = effectiveFiling(row, supersede.replacedBy.get(row.id), ctx);
    if (t.categoryId && t.categoryId !== row.categoryId) {
      inheritedCategories.push({ transactionId: row.id, categoryId: t.categoryId });
    }

    const cents = centsOf(row.amount);
    const spend = spendCents(row.source, cents);
    const inflow = inflowCents(row.source, cents);

    if (!t.isTransfer && t.categoryId) {
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

    if (!t.isTransfer && !row.isExternalCardPayment && !t.reimbursable && !t.debtId) {
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

// ── PR-H: the classifier's view of the allowance bucket (parity only) ──────

/**
 * `BudgetMonthRow` plus the identity fields `classifyMovement` needs
 * (`occurredOn`, `plaidAccountId`, `pfcDetailed`) that this file's own query
 * (`routes/budget.ts`) does not select today — its flag-only bucket rule
 * never needed them.
 */
export interface ClassifierBudgetMonthRow
  extends BudgetMonthRow,
    Pick<MovementRow, "occurredOn" | "plaidAccountId" | "pfcDetailed"> {}

/**
 * ⭐ (PR-H, owner decisions 6, 14, and 7/12) The allowance card's bucket rows,
 * computed from `classifyMovement` instead of this file's own bucket rule
 * (`unplanned > monthly > weekly` after four screens: transfer, external card
 * payment, reimbursable, debt tag).
 *
 * ⚠️ NOT CALLED BY `aggregateBudgetMonth` YET — see `spendingFacts.ts`'s
 * `classifierHouseholdSpend` for why (no query, no second pass, for a number
 * nothing displays), and docs/reviews/2026-09-14-household-money-core.md for
 * the wiring plan.
 *
 * mode "today" (the default) keeps today's handling of the two things
 * `classifyMovement` places differently: a confirmed match buckets by its own
 * flag, and a reimbursable row buckets nowhere.
 *
 * ⚠️ EVEN SO IT IS NOT ROW FOR ROW `aggregateBudgetMonth` (review H1). Today's
 * rule screens only the four things above; the classifier also drops every
 * flagged row the one spending rule (`classifyOutflow`) excludes — a refund
 * or other non-outflow, a debt-linked / excluded / income category, a Plaid
 * card payment, a card-payment or bank-noise description. Those classes are
 * enumerated, and pinned exactly, by `budgetActuals.test.ts`'s randomized
 * comparison; the review note lists each for the owner.
 *
 * mode "forward" is coverage alone (PR10 switches the card onto it): on top of
 * the classes above, a confirmed match buckets NOWHERE — the bill is already
 * counted in the plan (decision 12). (PR8r, the owner's answer 1) A
 * reimbursable row buckets nowhere in either mode: reimbursable comes before
 * the flags.
 *
 * (PR8r, PR-H review N2) Any other `mode` throws.
 */
export function classifierAllowanceRows(
  rows: readonly ClassifierBudgetMonthRow[],
  supersede: Pick<SupersededPending, "replacedIds" | "replacedBy">,
  ctx: FilingContext,
  movement: MovementContext,
  opts: { mode?: "today" | "forward" } = {},
): AllowanceAggregateRow[] {
  const mode = opts.mode ?? "today";
  if (mode !== "today" && mode !== "forward") {
    throw new Error(`classifierAllowanceRows: unknown mode ${JSON.stringify(mode)}`);
  }
  const out: AllowanceAggregateRow[] = [];

  for (const row of rows) {
    if (supersede.replacedIds.has(row.id)) continue;
    const t = effectiveFiling(row, supersede.replacedBy.get(row.id), ctx);
    const movementRow: MovementRow = {
      ...t,
      occurredOn: row.occurredOn,
      plaidAccountId: row.plaidAccountId,
      pfcDetailed: row.pfcDetailed,
    };
    const { coverage } = classifyMovement(movementRow, movement);

    let bucket: "unplanned" | "monthly" | "weekly" | null = null;
    if (coverage === "unplanned") bucket = "unplanned";
    else if (coverage === "allowance_monthly") bucket = "monthly";
    else if (coverage === "allowance_weekly") bucket = "weekly";
    else if (coverage === "bill_matched" && mode === "today") {
      // Reproduce today's rule verbatim: a matched row is not special-cased,
      // so it still buckets by whichever flag it carries.
      bucket = t.unplannedAllowance
        ? "unplanned"
        : t.monthlyAllowance
          ? "monthly"
          : t.weeklyAllowance
            ? "weekly"
            : null;
    }
    if (!bucket) continue;
    // Today's rule screens reimbursable before any flag or match.
    if (mode === "today" && t.reimbursable) continue;

    const cents = centsOf(row.amount);
    const spend = spendCents(row.source, cents);
    out.push({
      bucket,
      subBucket: t.weeklyBucket,
      pending: row.pending,
      spend: (spend / 100).toFixed(2),
      cnt: "1",
    });
  }
  return out;
}
