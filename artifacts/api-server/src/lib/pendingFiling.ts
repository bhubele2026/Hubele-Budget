// (PR-D review H1; round 3 M1, L2, NIT4; owner decisions 6 and 14) The filing a
// posted row carries when it replaced a pending row the household had filed.
//
// ⚠️ WHY. Sync never deletes a pending row the user filed, and the posted row
// that replaces it arrives as a FRESH insert: its category is whatever the
// mapping rules assign (or none), every allowance flag false (plaidSync, the
// `values` insert). Counting a pending purchase once (PR-D) therefore made a
// filed $40 charge leave its envelope the moment it posted at $48.
//
// Owner decision 14: the household's filing carries to the posted replacement,
// and a hand filing beats an automatic one. This PR applies it at READ time
// only — nothing is written. Every reader that pairs (the Budget month's
// category actuals and allowance card, `buildSpendingFacts`) calls this one
// helper, so Budget and Spending cannot file the same posted row differently.
//
// ⭐ THE RULE (for PR-I to reuse when it writes this at sync). With P the posted
// row and Q the pending row it replaced; "real category" = not null and not the
// system Uncategorized; "rule category" = what the household's mapping rules
// assign the row's description (`findMatchedRuleId` non-null for that
// category — rules match on description only, and `categorize` sets a category
// from rules and nothing else):
//
//   categoryId      Q's, when Q's is real and either
//                     - P has no real category, or
//                     - P's category IS its rule category (automatic) and Q's
//                       category is NOT Q's rule category (a hand filing).
//                   Otherwise P's own. With no rules loaded, every real
//                   category counts as a hand filing, so P keeps its own.
//   weekly / monthly / unplanned flags
//                   Q's three, only when P has none of them.
//   weeklyBucket    Q's, when P has none and both rows are weekly (after the
//                   flag step) — mergeStatePatch fills a blank slice the same way.
//   reimbursable    true when either is.
//   debtId          Q's, when P has none.
//   isTransfer      true when either is (mergeStatePatch carries it the same way;
//                   it carries no override flag).
//
// Otherwise P's own filing stands, even when that moves the whole charge to
// another envelope (review M2).

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
  isTransfer: boolean;
}

/** The pending row a posted row replaced, as far as inheritance needs it. */
export interface ReplacedFiling {
  description: string;
  filing: Filing;
}

export interface FilingContext {
  /** The household's system Uncategorized category ids. */
  uncategorizedIds: ReadonlySet<string>;
  /**
   * True when the household's mapping rules assign `categoryId` to
   * `description` (`loadRuleCategoryCheck`). Absent = rules not loaded: every
   * real category counts as a hand filing. Load it only when
   * `needsRuleCheck` says a pair needs it.
   */
  isRuleCategory?: (description: string, categoryId: string) => boolean;
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

const isReal = (id: string | null, uncategorizedIds: ReadonlySet<string>): id is string =>
  id != null && !uncategorizedIds.has(id);

/**
 * Does any posted row here need the rules? Only a posted row and its replaced
 * pending row that BOTH carry real, DIFFERENT categories — every other case is
 * decided without asking who filed what.
 */
export function needsRuleCheck(
  rows: Iterable<{ id: string; categoryId: string | null }>,
  replacedBy: ReadonlyMap<string, ReplacedFiling>,
  uncategorizedIds: ReadonlySet<string>,
): boolean {
  for (const row of rows) {
    const r = replacedBy.get(row.id);
    if (!r) continue;
    if (
      isReal(row.categoryId, uncategorizedIds) &&
      isReal(r.filing.categoryId, uncategorizedIds) &&
      row.categoryId !== r.filing.categoryId
    ) {
      return true;
    }
  }
  return false;
}

/**
 * ⭐ The posted row as it counts, given the pending row it replaced — THE RULE
 * above. Pure: returns a new object, never mutates either row. With no
 * replaced row it returns the posted row unchanged.
 */
export function effectiveFiling<T extends Filing & { description: string }>(
  posted: T,
  replaced: ReplacedFiling | null | undefined,
  ctx: FilingContext,
): T {
  if (!replaced) return posted;
  const from = replaced.filing;
  const out: T = { ...posted };
  const { uncategorizedIds, isRuleCategory } = ctx;

  if (isReal(from.categoryId, uncategorizedIds)) {
    if (!isReal(posted.categoryId, uncategorizedIds)) {
      out.categoryId = from.categoryId;
    } else if (
      posted.categoryId !== from.categoryId &&
      isRuleCategory !== undefined &&
      isRuleCategory(posted.description, posted.categoryId) &&
      !isRuleCategory(replaced.description, from.categoryId)
    ) {
      out.categoryId = from.categoryId;
    }
  }

  if (!posted.weeklyAllowance && !posted.monthlyAllowance && !posted.unplannedAllowance) {
    out.weeklyAllowance = from.weeklyAllowance;
    out.monthlyAllowance = from.monthlyAllowance;
    out.unplannedAllowance = from.unplannedAllowance;
  }
  if (!posted.weeklyBucket && from.weeklyBucket && out.weeklyAllowance && from.weeklyAllowance) {
    out.weeklyBucket = from.weeklyBucket;
  }

  if (!posted.reimbursable && from.reimbursable) out.reimbursable = true;
  if (!posted.debtId && from.debtId) out.debtId = from.debtId;
  if (!posted.isTransfer && from.isTransfer) out.isTransfer = true;
  return out;
}
