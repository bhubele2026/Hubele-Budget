import { eq } from "drizzle-orm";
import { db, mappingRulesTable } from "@workspace/db";

export type RuleRow = {
  id: string;
  pattern: string;
  matchType: string;
  categoryId: string | null;
  priority: number;
};

/**
 * (#623) Load mapping rules scoped by householdId so a member sees the
 * shared household's rule set, not just rules they personally created.
 */
export async function loadUserRules(householdId: string): Promise<RuleRow[]> {
  const rows = await db
    .select()
    .from(mappingRulesTable)
    .where(eq(mappingRulesTable.householdId, householdId));
  return [...rows].sort((a, b) => b.priority - a.priority);
}

function ruleMatchesDescription(rule: RuleRow, hay: string): boolean {
  const needle = rule.pattern.toLowerCase();
  if (!needle) return false;
  switch (rule.matchType) {
    case "exact":
      return hay === needle;
    case "starts_with":
      return hay.startsWith(needle);
    case "contains":
    default:
      return hay.includes(needle);
  }
}

export function matchRule(
  description: string,
  rules: RuleRow[],
): string | null {
  if (!description) return null;
  const hay = description.toLowerCase();
  for (const r of rules) {
    if (!r.categoryId) continue;
    if (ruleMatchesDescription(r, hay)) return r.categoryId;
  }
  return null;
}

/**
 * Same priority-walk semantics as `matchRule`, but returns the entire winning
 * rule (id + categoryId + pattern). Used by `categorize` so attribution
 * pipelines (Plaid sync / XLSX import) can build per-rule "matched by your X
 * rule" toasts without a second pass over the rule list.
 */
export function matchRuleEntry(
  description: string,
  rules: RuleRow[],
): RuleRow | null {
  if (!description) return null;
  const hay = description.toLowerCase();
  for (const r of rules) {
    if (!r.categoryId) continue;
    if (ruleMatchesDescription(r, hay)) return r;
  }
  return null;
}

/**
 * Returns the id of the rule that auto-categorize would currently attribute
 * for the given transaction. The intent is "which rule is responsible for
 * this row sitting in this category" — surfaced on Transactions / Amex rows
 * so the user can jump straight to that rule on the Mapping Rules page.
 *
 * Semantics, mirroring the auto-categorize pipeline:
 *   - Walk the user's rules in priority-descending order (the input is
 *     expected to already be sorted by `loadUserRules`).
 *   - The first rule whose pattern matches the description is the
 *     candidate. If its `categoryId` matches the transaction's current
 *     `categoryId`, that's the attribution. Otherwise the user (or some
 *     other path) clearly overrode the auto-pick, so we report no rule
 *     attribution rather than a misleading one.
 *   - Returns null for transactions with no `categoryId`, no description,
 *     or no matching rule at all.
 */
export function findMatchedRuleId(
  description: string | null | undefined,
  currentCategoryId: string | null | undefined,
  rules: RuleRow[],
): string | null {
  if (!currentCategoryId) return null;
  if (!description) return null;
  const hay = description.toLowerCase();
  for (const r of rules) {
    if (!r.categoryId) continue;
    if (!ruleMatchesDescription(r, hay)) continue;
    return r.categoryId === currentCategoryId ? r.id : null;
  }
  return null;
}

/**
 * Returns every rule whose pattern matches the description, ignoring whether
 * the rule currently has a `categoryId`. This is the auto-relearn entrypoint
 * used by the PATCH /transactions handler to repoint stale rules (e.g. seed
 * debt-payment rules pre-pointed at "Misc / Buffer" because the per-debt
 * category didn't exist yet at seed time) onto the user's freshly chosen
 * category. `matchRule` keeps its single-result, category-required semantics
 * for the categorize() hot path.
 */
export function findMatchingRules(
  description: string,
  rules: RuleRow[],
): RuleRow[] {
  if (!description) return [];
  const hay = description.toLowerCase();
  const out: RuleRow[] = [];
  for (const r of rules) {
    if (ruleMatchesDescription(r, hay)) out.push(r);
  }
  return out;
}

/**
 * Plaid `personal_finance_category.primary` values that always represent
 * money-movement between the user's own accounts and must NOT count toward
 * either budgeted income or budgeted spending.
 */
const TRANSFER_PFC_PRIMARY = new Set([
  "TRANSFER_IN",
  "TRANSFER_OUT",
]);

/**
 * Description fragments (case-insensitive) that flag obvious internal transfers
 * even when there is no Plaid PFC available (e.g. ODP between checking/savings).
 */
const TRANSFER_DESC_PATTERNS = [
  "odp transfer",
  "online transfer to",
  "online transfer from",
  "transfer to savings",
  "transfer from savings",
  "internal transfer",
];

export type CategorizeInput = {
  description: string;
  pfcPrimary?: string | null;
  pfcDetailed?: string | null;
};

export type CategorizeResult = {
  categoryId: string | null;
  isTransfer: boolean;
  // Id + pattern of the mapping_rule that won the priority walk and assigned
  // `categoryId`. Null when no description rule matched (e.g. the row is an
  // un-categorized transfer or no rule's pattern was hit). Surfaced by Plaid
  // sync / XLSX import so the client can build a per-rule attribution
  // breakdown ("Auto-categorized 12 new transactions: 5 via 'STARBUCKS', …").
  matchedRuleId: string | null;
  matchedRulePattern: string | null;
};

/**
 * Canonical mapping of a transaction to a budget category, plus a transfer
 * flag. Description rules win over Plaid PFC fallbacks so user-defined
 * mapping_rules always take precedence.
 */
export function categorize(
  input: CategorizeInput,
  rules: RuleRow[],
): CategorizeResult {
  const desc = input.description ?? "";
  const haystack = desc.toLowerCase();

  const pfcPrim = (input.pfcPrimary ?? "").toUpperCase();
  const isTransfer =
    TRANSFER_PFC_PRIMARY.has(pfcPrim) ||
    TRANSFER_DESC_PATTERNS.some((p) => haystack.includes(p));

  // Description rules.
  const matched = matchRuleEntry(desc, rules);
  if (matched && matched.categoryId) {
    return {
      categoryId: matched.categoryId,
      isTransfer,
      matchedRuleId: matched.id,
      matchedRulePattern: matched.pattern,
    };
  }

  return {
    categoryId: null,
    isTransfer,
    matchedRuleId: null,
    matchedRulePattern: null,
  };
}
