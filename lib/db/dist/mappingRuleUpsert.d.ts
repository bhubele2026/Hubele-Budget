import type { NodePgDatabase } from "drizzle-orm/node-postgres";
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
export declare function upsertMappingRule(conn: NodePgDatabase<any>, input: UpsertMappingRuleInput): Promise<UpsertMappingRuleResult>;
//# sourceMappingURL=mappingRuleUpsert.d.ts.map