import type { NodePgDatabase } from "drizzle-orm/node-postgres";
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
export declare function upsertMappingRule(conn: NodePgDatabase<any>, input: UpsertMappingRuleInput): Promise<UpsertMappingRuleResult>;
//# sourceMappingURL=mappingRuleUpsert.d.ts.map