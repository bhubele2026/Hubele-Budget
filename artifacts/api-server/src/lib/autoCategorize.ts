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

export function matchRule(
  description: string,
  rules: RuleRow[],
): string | null {
  if (!description) return null;
  const hay = description.toLowerCase();
  for (const r of rules) {
    if (!r.categoryId) continue;
    const needle = r.pattern.toLowerCase();
    if (!needle) continue;
    let hit = false;
    switch (r.matchType) {
      case "exact":
        hit = hay === needle;
        break;
      case "starts_with":
        hit = hay.startsWith(needle);
        break;
      case "contains":
      default:
        hit = hay.includes(needle);
        break;
    }
    if (hit) return r.categoryId;
  }
  return null;
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
