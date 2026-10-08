import { compareRules, matchRuleEntry } from "../../autoCategorize";

export { compareRules };
import type { EngineContext, EngineRow, StageResult } from "../types";

export function ruleTokenCount(pattern: string): number {
  return pattern.trim().split(/\s+/).filter(Boolean).length;
}

/** A household rule (user-authored) matched: 0.95 for a 2+ word pattern, 0.85 for one word. */
export function ruleStage(row: EngineRow, ctx: EngineContext): StageResult | null {
  const r = matchRuleEntry(row.description, ctx.rules);
  if (!r || !r.categoryId) return null;
  return {
    source: "rule",
    categoryId: r.categoryId,
    confidence: ruleTokenCount(r.pattern) >= 2 ? 0.95 : 0.85,
    explanation: "Matched one of your rules.",
    ruleId: r.id,
  };
}
