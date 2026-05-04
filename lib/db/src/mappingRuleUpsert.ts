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

export type UpsertMappingRuleStatus = "inserted" | "updated" | "noop";

/**
 * Result of an `upsertMappingRule` call. `ruleId` is the id of the row that
 * the upsert touched (the just-inserted rule for `inserted`, the existing
 * rule's id for `updated`/`noop`). It's `null` only when the upsert was
 * skipped before touching the table — currently just the short-pattern
 * guard at the top of the function.
 */
export type UpsertMappingRuleResult = {
  status: UpsertMappingRuleStatus;
  ruleId: string | null;
};

/**
 * Idempotent upsert of a mapping rule keyed by `(userId, pattern)`. Used by
 * both the live PATCH /transactions auto-learn flow and one-shot backfill
 * scripts so they share a single canonical persistence path.
 *
 * Returns `status: "noop"` when the existing rule already has at least the
 * given priority and matches the same target+matchType (so re-runs don't
 * churn createdAt or downgrade priority). The returned `ruleId` lets
 * callers reference the rule afterward — used by the auto-learn flow to
 * report a "created" rule's id back to the client so it can offer an
 * Undo affordance from the toast.
 */
export async function upsertMappingRule(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conn: NodePgDatabase<any>,
  input: UpsertMappingRuleInput,
): Promise<UpsertMappingRuleResult> {
  const { userId, pattern, matchType, categoryId, priority } = input;
  if (!pattern || pattern.length < 3) return { status: "noop", ruleId: null };

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
    const [inserted] = await conn
      .insert(mappingRulesTable)
      .values({
        userId,
        pattern,
        matchType,
        categoryId,
        priority,
      })
      .returning({ id: mappingRulesTable.id });
    return { status: "inserted", ruleId: inserted!.id };
  }

  const row = existing[0];
  const sameTarget = row.categoryId === categoryId;
  const sameMatch = row.matchType === matchType;
  const samePriority = row.priority >= priority;
  if (sameTarget && sameMatch && samePriority)
    return { status: "noop", ruleId: row.id };

  await conn
    .update(mappingRulesTable)
    .set({
      categoryId,
      matchType,
      priority: Math.max(row.priority, priority),
    })
    .where(eq(mappingRulesTable.id, row.id));
  return { status: "updated", ruleId: row.id };
}
