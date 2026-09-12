// (PR-D review H1; owner decisions 6 and 14) The filing a posted row carries
// when it replaced a pending row the household had already filed.
//
// ⚠️ WHY. Sync never deletes a pending row the user filed, and the posted row
// that replaces it arrives as a FRESH insert: rules-only category, every
// allowance flag false (plaidSync, the `values` insert). Counting a pending
// purchase once (PR-D) therefore made a filed $40 charge leave its envelope
// the moment it posted at $48 — Eating out 40 → 0, weekly 40 → 0, and $48
// under Uncategorized on Spending.
//
// Owner decision 14: reviewed/filing metadata carries to the posted
// replacement. This PR does that at READ time only — nothing is written; PR-I
// writes it at sync. Every reader that pairs (the Budget month's category
// actuals and allowance card, and `buildSpendingFacts`) calls this one helper,
// so Budget and Spending cannot file the same posted row differently.
//
// The rule mirrors dedupe's `mergeStatePatch`: fill what the posted row LACKS,
// never overwrite what it has (review M2 — a posted row filed on its own keeps
// its own filing, even when that moves the charge to another envelope).

import { UNCATEGORIZED_CATEGORY_NAME } from "./budgetSeed";

/** The user-state fields a posted row can inherit. */
export interface Filing {
  categoryId: string | null;
  weeklyAllowance: boolean;
  monthlyAllowance: boolean;
  unplannedAllowance: boolean;
  weeklyBucket: string | null;
  reimbursable: boolean;
  debtId: string | null;
}

/** The household's system "Uncategorized" category ids (by its exact name). */
export function uncategorizedCategoryIds(
  categories: Iterable<{ id: string; name: string }>,
): Set<string> {
  const ids = new Set<string>();
  for (const c of categories) {
    if (c.name === UNCATEGORIZED_CATEGORY_NAME) ids.add(c.id);
  }
  return ids;
}

/**
 * ⭐ The posted row as it counts, given the pending row it replaced.
 *
 *   - `categoryId`: the pending row's, only when the posted row has none or
 *     sits in the system Uncategorized category, and only when the pending
 *     row's is a real category.
 *   - `weeklyAllowance` / `monthlyAllowance` / `unplannedAllowance`: the
 *     pending row's three flags, only when the posted row has none of them.
 *     `weeklyBucket` comes with them, unless the posted row has its own.
 *   - `reimbursable`: true when either is.
 *   - `debtId`: the pending row's, when the posted row has none.
 *
 * Pure: returns a new object, never mutates either row. With no replaced row
 * it returns the posted row unchanged.
 */
export function effectiveFiling<T extends Filing>(
  posted: T,
  replaced: Filing | null | undefined,
  uncategorizedIds: ReadonlySet<string>,
): T {
  if (!replaced) return posted;
  const out: T = { ...posted };

  const realCategory = (id: string | null): id is string =>
    id != null && !uncategorizedIds.has(id);
  if (!realCategory(posted.categoryId) && realCategory(replaced.categoryId)) {
    out.categoryId = replaced.categoryId;
  }

  if (!posted.weeklyAllowance && !posted.monthlyAllowance && !posted.unplannedAllowance) {
    out.weeklyAllowance = replaced.weeklyAllowance;
    out.monthlyAllowance = replaced.monthlyAllowance;
    out.unplannedAllowance = replaced.unplannedAllowance;
    if (!posted.weeklyBucket && replaced.weeklyBucket) out.weeklyBucket = replaced.weeklyBucket;
  }

  if (!posted.reimbursable && replaced.reimbursable) out.reimbursable = true;
  if (!posted.debtId && replaced.debtId) out.debtId = replaced.debtId;
  return out;
}
