import { and, desc, eq, isNull, ilike, sql } from "drizzle-orm";
import { db, transactionsTable } from "@workspace/db";

/**
 * Build the SQL pattern for ilike from a mapping rule's matchType. Mirrors
 * `ruleMatchesDescription`'s semantics (case-insensitive substring/exact/
 * prefix) but uses Postgres ilike so we can do the candidate scan in a
 * single query instead of pulling rows back to JS.
 */
export function ilikePatternFor(rule: {
  matchType: string;
  pattern: string;
}): string {
  const safe = rule.pattern.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
  switch (rule.matchType) {
    case "exact":
      return safe;
    case "starts_with":
      return `${safe}%`;
    case "contains":
    default:
      return `%${safe}%`;
  }
}

export type PatternCandidate = {
  id: string;
  occurredOn: string;
  description: string | null;
  amount: string;
};

/**
 * Look up the older transactions whose description matches a mapping
 * rule's pattern AND that currently sit in `fromCategoryId`. Used by:
 *
 *   - the per-row PATCH auto-learn flow when it repoints an existing
 *     specific rule (fromCategoryId is the rule's old category) so the
 *     server can ship a small preview list to the client's "apply to
 *     past charges?" toast.
 *
 *   - the same prompt for *brand-new specific rules* (fromCategoryId
 *     is null → uncategorized rows only) so explicit user category
 *     edits aren't trampled.
 *
 *   - the bulk re-categorize endpoint that the client posts to when
 *     the user accepts the prompt.
 *
 *   - the Mapping Rules page (POST /mapping-rules → counts older
 *     uncategorized rows matching the freshly hand-created rule, so
 *     the client can offer the same prompt as the auto-learn flow).
 *
 * Ordered most-recent first so the first N rows can be served straight
 * through to the client as a preview list. Bulk callers don't care
 * about order (they just need the full id set) so this is safe to
 * apply unconditionally.
 */
export async function selectPatternCandidates(
  userId: string,
  rule: { pattern: string; matchType: string },
  fromCategoryId: string | null,
): Promise<PatternCandidate[]> {
  return db
    .select({
      id: transactionsTable.id,
      occurredOn: transactionsTable.occurredOn,
      description: transactionsTable.description,
      amount: transactionsTable.amount,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        fromCategoryId === null
          ? isNull(transactionsTable.categoryId)
          : eq(transactionsTable.categoryId, fromCategoryId),
        eq(transactionsTable.isTransfer, false),
        ilike(transactionsTable.description, ilikePatternFor(rule)),
      ),
    )
    .orderBy(desc(transactionsTable.occurredOn));
}

/**
 * Count-only variant for callers that just need the candidate count
 * (e.g. the Mapping Rules page prompt) without the per-row payload.
 * Same `fromCategoryId === null` semantics as `selectPatternCandidates`.
 */
export async function countPatternCandidates(
  userId: string,
  rule: { pattern: string; matchType: string },
  fromCategoryId: string | null,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, userId),
        fromCategoryId === null
          ? isNull(transactionsTable.categoryId)
          : eq(transactionsTable.categoryId, fromCategoryId),
        eq(transactionsTable.isTransfer, false),
        ilike(transactionsTable.description, ilikePatternFor(rule)),
      ),
    );
  return row?.count ?? 0;
}
