import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { mappingRulesTable } from "./schema";

export type UpsertMappingRuleInput = {
  userId: string;
  pattern: string;
  matchType: "contains" | "starts_with" | "exact";
  categoryId: string | null;
  priority: number;
};

export type UpsertMappingRuleResult = "inserted" | "updated" | "noop";

/**
 * Idempotent upsert of a mapping rule keyed by `(userId, pattern)`. Used by
 * both the live PATCH /transactions auto-learn flow and one-shot backfill
 * scripts so they share a single canonical persistence path.
 *
 * Returns `noop` when the existing rule already has at least the given
 * priority and matches the same target+matchType (so re-runs don't churn
 * createdAt or downgrade priority).
 */
export async function upsertMappingRule(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conn: NodePgDatabase<any>,
  input: UpsertMappingRuleInput,
): Promise<UpsertMappingRuleResult> {
  const { userId, pattern, matchType, categoryId, priority } = input;
  if (!pattern || pattern.length < 3) return "noop";

  const existing = await conn
    .select()
    .from(mappingRulesTable)
    .where(
      and(
        eq(mappingRulesTable.userId, userId),
        eq(mappingRulesTable.pattern, pattern),
      ),
    )
    .limit(1);

  if (existing.length === 0) {
    await conn.insert(mappingRulesTable).values({
      userId,
      pattern,
      matchType,
      categoryId,
      priority,
    });
    return "inserted";
  }

  const row = existing[0];
  const sameTarget = row.categoryId === categoryId;
  const sameMatch = row.matchType === matchType;
  const samePriority = row.priority >= priority;
  if (sameTarget && sameMatch && samePriority) return "noop";

  await conn
    .update(mappingRulesTable)
    .set({
      categoryId,
      matchType,
      priority: Math.max(row.priority, priority),
    })
    .where(eq(mappingRulesTable.id, row.id));
  return "updated";
}
