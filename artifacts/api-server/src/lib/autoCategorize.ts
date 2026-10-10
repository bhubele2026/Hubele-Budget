import { eq } from "drizzle-orm";
import { db, budgetCategoriesTable, mappingRulesTable } from "@workspace/db";
import {
  categoryDirectionConflict,
  isCardLedgerRow,
  type DirectionConflict,
  type SpendContext,
} from "@workspace/avalanche-core";
import {
  TRANSFER_DESC_PATTERNS as SHARED_TRANSFER_DESC_PATTERNS,
  TRANSFER_PFC_PRIMARY as SHARED_TRANSFER_PFC_PRIMARY,
  isHeuristicTransfer as sharedIsHeuristicTransfer,
} from "@workspace/api-zod";
import { uncategorizedCategoryIds } from "./pendingFiling";
import { spendContextOf } from "./spendContext";

export type RuleRow = {
  id: string;
  pattern: string;
  matchType: string;
  categoryId: string | null;
  priority: number;
  /** (PR-A) Third key of the deterministic tie-break (`compareRules`). */
  createdAt?: Date | null;
};

/**
 * (PR-A) Deterministic rule order: priority desc, pattern length desc (the
 * more specific pattern first), created_at asc, id asc. Equal priorities used
 * to fall back to whatever order Postgres returned the rows in, so two
 * overlapping rules could swap winners between requests.
 */
export function compareRules(a: RuleRow, b: RuleRow): number {
  return (
    b.priority - a.priority ||
    b.pattern.length - a.pattern.length ||
    (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * (#623) Load mapping rules scoped by householdId so a member sees the
 * shared household's rule set, not just rules they personally created.
 */
export async function loadUserRules(householdId: string): Promise<RuleRow[]> {
  const rows = await db
    .select()
    .from(mappingRulesTable)
    .where(eq(mappingRulesTable.householdId, householdId));
  return [...rows].sort(compareRules);
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
 * (#642) The transfer / card-payment heuristic now lives in the shared
 * `@workspace/api-zod` package so the dashboard's bucket-membership
 * predicate, the chip detector, and the server-side write-path guards
 * all agree on what "looks like a transfer". Re-exported here for
 * backward compatibility with existing server callers.
 */
export const TRANSFER_PFC_PRIMARY: ReadonlySet<string> = SHARED_TRANSFER_PFC_PRIMARY;
export const TRANSFER_DESC_PATTERNS: readonly string[] = SHARED_TRANSFER_DESC_PATTERNS;
export const isHeuristicTransfer = sharedIsHeuristicTransfer;

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
  /**
   * (WP5d) Set when the winning rule would file the row against the money's
   * direction (`categoryDirectionConflict`: money in under an expense
   * category, money out under an income one). `categoryId` is then null and
   * the rule is NOT reported as `matchedRuleId` (it filed nothing): the row is
   * stored uncategorized, and the engine's queue decision names the rule.
   */
  directionConflict: { kind: DirectionConflict; ruleId: string; pattern: string } | null;
};

/**
 * (WP5d) What the insert-time direction guard needs: the household's
 * categories (`loadRuleContext`) and the row as it will be stored. Omit the
 * guard and `categorize` behaves exactly as before (no direction check).
 */
export interface CategorizeGuard {
  spendCtx: SpendContext;
  uncategorizedIds: ReadonlySet<string>;
  /** Signed as stored: bank/Plaid money out is negative; an Amex-workbook charge positive. */
  amount: string | number;
  source: string;
  /** The row's Plaid account is a credit account (see `isCardLedgerRow`). */
  isCardAccount: boolean;
  /** The row's final transfer flag, when the caller decides it (else the heuristic's). */
  isTransfer?: boolean;
  debtId?: string | null;
  isExternalCardPayment?: boolean;
  reimbursable?: boolean;
}

/**
 * Canonical mapping of a transaction to a budget category, plus a transfer
 * flag. Description rules win over Plaid PFC fallbacks so user-defined
 * mapping_rules always take precedence.
 *
 * ⭐ (WP5d) With a `guard`, a rule that would file money in under an expense
 * category (a paycheck under Dining) or money out under an income one (a
 * cafeteria charge under the paycheck) files NOTHING: the result carries
 * `categoryId: null` and `directionConflict`, so the row inserts uncategorized
 * and the categorizer queues it, naming the rule (WP5c, `decide.ts`).
 */
export function categorize(
  input: CategorizeInput,
  rules: RuleRow[],
  guard?: CategorizeGuard,
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
    const conflict = guard
      ? categoryDirectionConflict(
          {
            amount: guard.amount,
            source: guard.source,
            isTransfer: guard.isTransfer ?? isTransfer,
            categoryId: matched.categoryId,
            description: desc,
            debtId: guard.debtId ?? null,
            isExternalCardPayment: guard.isExternalCardPayment ?? false,
            reimbursable: guard.reimbursable ?? false,
            pfcDetailed: input.pfcDetailed ?? null,
          },
          matched.categoryId,
          guard.spendCtx,
          { isCardAccount: guard.isCardAccount, uncategorizedIds: guard.uncategorizedIds },
        )
      : null;
    if (conflict) {
      return {
        categoryId: null,
        isTransfer,
        matchedRuleId: null,
        matchedRulePattern: null,
        directionConflict: { kind: conflict, ruleId: matched.id, pattern: matched.pattern },
      };
    }
    return {
      categoryId: matched.categoryId,
      isTransfer,
      matchedRuleId: matched.id,
      matchedRulePattern: matched.pattern,
      directionConflict: null,
    };
  }

  return {
    categoryId: null,
    isTransfer,
    matchedRuleId: null,
    matchedRulePattern: null,
    directionConflict: null,
  };
}

/** (WP5d) The rules and the categories an insert-time fill needs. */
export interface RuleContext {
  /** Deterministic order (`compareRules`), as `loadUserRules` returns them. */
  rules: RuleRow[];
  spendCtx: SpendContext;
  /** The household's system "Uncategorized" category ids. */
  uncategorizedIds: ReadonlySet<string>;
}

/**
 * (WP5d) Load once per sync / import / request: the household's mapping rules
 * plus its categories as the direction guard reads them (kinds, debt links,
 * the system Uncategorized ids).
 */
export async function loadRuleContext(householdId: string): Promise<RuleContext> {
  const [rules, cats] = await Promise.all([
    loadUserRules(householdId),
    db
      .select({
        id: budgetCategoriesTable.id,
        name: budgetCategoriesTable.name,
        debtId: budgetCategoriesTable.debtId,
        kind: budgetCategoriesTable.kind,
      })
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.householdId, householdId)),
  ]);
  return { rules, spendCtx: spendContextOf(cats), uncategorizedIds: uncategorizedCategoryIds(cats) };
}

/**
 * (WP5d) The guard for one row, from a loaded context. `accountType` is the
 * row's Plaid account type (`plaid_accounts.type`), when it has one.
 */
export function directionGuard(
  rc: Pick<RuleContext, "spendCtx" | "uncategorizedIds">,
  row: {
    amount: string | number;
    source: string;
    accountType?: string | null;
    isTransfer?: boolean;
    debtId?: string | null;
    isExternalCardPayment?: boolean;
    reimbursable?: boolean;
  },
): CategorizeGuard {
  return {
    spendCtx: rc.spendCtx,
    uncategorizedIds: rc.uncategorizedIds,
    amount: row.amount,
    source: row.source,
    isCardAccount: isCardLedgerRow(row.source, row.accountType ?? null),
    ...(row.isTransfer !== undefined ? { isTransfer: row.isTransfer } : {}),
    debtId: row.debtId ?? null,
    isExternalCardPayment: row.isExternalCardPayment ?? false,
    reimbursable: row.reimbursable ?? false,
  };
}
