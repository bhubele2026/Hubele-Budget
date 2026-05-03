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
