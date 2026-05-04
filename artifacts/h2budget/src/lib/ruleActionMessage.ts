import type { RuleAction } from "@workspace/api-client-react";

/**
 * Build a short, user-facing description of what the auto-learn flow did
 * to the user's mapping rules in response to a quick-categorize PATCH.
 * Returns `null` when there's nothing interesting to surface (no-op /
 * same-category) so callers can skip the toast description entirely
 * (per Task #185's "skip on no-op cases" rule).
 *
 * The shapes mirror server's RuleAction discriminated union:
 *   - `created`               → "Future 'X' charges will auto-categorize here."
 *   - `created_priority_bump` → ditto, plus "Your 'Y' rule is unchanged."
 *   - `skipped_generic`       → "Your 'Y' rule already routes 'X' — edit it to change that."
 *   - `repointed`             → "Updated your 'X' rule to point here."
 *   - `none`                  → null (no toast description)
 */
export function ruleActionMessage(action: RuleAction | undefined): string | null {
  if (!action) return null;
  switch (action.kind) {
    case "created":
      return action.pattern
        ? `Future "${action.pattern}" charges will auto-categorize here.`
        : null;
    case "created_priority_bump":
      if (!action.pattern) return null;
      return action.genericPattern
        ? `Future "${action.pattern}" charges will auto-categorize here. Your "${action.genericPattern}" rule is unchanged.`
        : `Future "${action.pattern}" charges will auto-categorize here.`;
    case "skipped_generic":
      if (!action.pattern || !action.genericPattern) return null;
      return `Your "${action.genericPattern}" rule already routes "${action.pattern}" — edit it to change that.`;
    case "repointed":
      return action.pattern
        ? `Updated your "${action.pattern}" rule to point here.`
        : null;
    case "none":
    default:
      return null;
  }
}
