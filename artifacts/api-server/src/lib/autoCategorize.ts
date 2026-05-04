import { eq } from "drizzle-orm";
import { db, mappingRulesTable } from "@workspace/db";

export type RuleRow = {
  id: string;
  pattern: string;
  matchType: string;
  categoryId: string | null;
  priority: number;
};

export async function loadUserRules(userId: string): Promise<RuleRow[]> {
  const rows = await db
    .select()
    .from(mappingRulesTable)
    .where(eq(mappingRulesTable.userId, userId));
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
  const fromDesc = matchRule(desc, rules);
  if (fromDesc) return { categoryId: fromDesc, isTransfer };

  return { categoryId: null, isTransfer };
}
