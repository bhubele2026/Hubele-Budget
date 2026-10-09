import {
  classifyRefund,
  incomeAmount,
  isDebtCategory,
  isExcludedCategoryName,
  isRealIncome,
  type SpendContext,
  type SpendTxn,
} from "@/lib/avalanche";

/**
 * ⭐ "INCOME FILED UNDER AN EXPENSE CATEGORY" — a deterministic review flag.
 *
 * A paycheck credit sitting in Dining & Coffee (seen live, 2026-10-09) is not
 * spending and not income anywhere the app looks: the spending rule ignores an
 * inflow, and `isRealIncome` only counts an inflow filed under an INCOME
 * category. So it silently drops out of both. This says so, for a person to
 * re-file. It never changes a row or a total.
 *
 * Built only from the shared household rules (`@workspace/avalanche-core`, via
 * `@/lib/avalanche`), never a rule of its own:
 *   - the row is an inflow by `incomeAmount` (an Amex-workbook row, whose
 *     positive amount is a charge, never is);
 *   - it is a row `isRealIncome` WOULD count if it were filed under income —
 *     not a transfer, not a debt row or debt category, not an excluded
 *     category (Transfer, Ignore, Reimbursement, …);
 *   - its category exists and is an EXPENSE category;
 *   - it is not a refund by `classifyRefund` (money back on a card, or a
 *     credit whose description says REFUND), which belongs in the expense
 *     category it nets;
 *   - and it is not marked reimbursable (a reimbursement landing in an
 *     expense category is expected — lead's ruling, 2026-10-09).
 * Pure: same row and categories in, same answer out.
 */

/** A category as the categories list gives it (a generated `Category` fits). */
export interface DirectionCategory {
  name: string;
  kind: string;
  /** Set on a debt's own category, when the caller has it. */
  debtId?: string | null;
  /** `auto_debts` marks a debt's own category (one per debt, server-synced). */
  sourceKind?: string | null;
}

/** What the flag reads from a row (a generated `Transaction` fits). */
export interface DirectionTxn {
  amount: string | number;
  source: string;
  categoryId?: string | null;
  description: string;
  isTransfer: boolean;
  debtId?: string | null;
  isExternalCardPayment: boolean;
  reimbursable: boolean;
  pfcDetailed?: string | null;
}

function contextOf(categoriesById: ReadonlyMap<string, DirectionCategory>): SpendContext {
  const map: SpendContext["categoriesById"] = new Map();
  for (const [id, c] of categoriesById) {
    map.set(id, {
      name: c.name,
      kind: c.kind,
      debtId: c.debtId ?? (c.sourceKind === "auto_debts" ? `auto_debts:${id}` : null),
    });
  }
  return { categoriesById: map, debtCategoryIds: new Set() };
}

/** Categories keyed by id, for `isInflowFiledAsExpense`. */
export function categoriesByIdOf<C extends DirectionCategory & { id: string }>(
  categories: readonly C[] | null | undefined,
): Map<string, C> {
  return new Map((categories ?? []).map((c) => [c.id, c]));
}

export function isInflowFiledAsExpense(
  txn: DirectionTxn,
  categoriesById: ReadonlyMap<string, DirectionCategory>,
): boolean {
  const tx: SpendTxn = {
    amount: txn.amount,
    source: txn.source,
    isTransfer: txn.isTransfer,
    categoryId: txn.categoryId ?? null,
    description: txn.description,
    debtId: txn.debtId ?? null,
    isExternalCardPayment: txn.isExternalCardPayment,
    reimbursable: txn.reimbursable,
    pfcDetailed: txn.pfcDetailed ?? null,
  };
  if (incomeAmount(tx) <= 0) return false;
  // (Lead's ruling, 2026-10-09) A credit marked reimbursable is money coming
  // back for something the household paid: it is expected in an expense
  // category, so it is never flagged.
  if (tx.reimbursable === true) return false;
  if (tx.isTransfer === true || tx.debtId) return false;
  if (!tx.categoryId) return false;
  const ctx = contextOf(categoriesById);
  const cat = ctx.categoriesById.get(tx.categoryId);
  if (!cat || cat.kind !== "expense") return false;
  if (isExcludedCategoryName(cat.name) || isDebtCategory(tx, ctx)) return false;
  // Already income by the household rule: nothing to flag (an expense
  // category never is, so this only guards a future change to that rule).
  if (isRealIncome(tx, ctx)) return false;
  if (classifyRefund(tx, ctx) !== null) return false;
  return true;
}
