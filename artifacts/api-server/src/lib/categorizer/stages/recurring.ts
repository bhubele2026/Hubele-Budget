import { descriptionsFuzzyEqual, tokenizeDescription } from "@workspace/avalanche-core";
import type { EngineContext, EngineRow, StageResult } from "../types";

/**
 * An active recurring item whose name matches the description
 * (`descriptionsFuzzyEqual`) and whose amount is within max($25, 25%):
 * 0.9 when within max($1, 1%), else 0.7.
 */
export function recurringStage(row: EngineRow, ctx: EngineContext): StageResult | null {
  const abs = Math.abs(Number(row.amount) || 0);
  if (abs === 0 || tokenizeDescription(row.description).size === 0) return null;
  let best: { id: string; categoryId: string; diff: number; tight: boolean } | null = null;
  for (const r of ctx.recurring) {
    if (tokenizeDescription(r.name).size === 0) continue;
    if (!descriptionsFuzzyEqual(r.name, row.description)) continue;
    const plan = Math.abs(r.amount);
    const diff = Math.abs(abs - plan);
    if (diff > Math.max(25, plan * 0.25)) continue;
    const tight = diff <= Math.max(1, plan * 0.01);
    if (
      !best ||
      (tight && !best.tight) ||
      (tight === best.tight && (diff < best.diff || (diff === best.diff && r.id < best.id)))
    ) {
      best = { id: r.id, categoryId: r.categoryId, diff, tight };
    }
  }
  if (!best) return null;
  return {
    source: "recurring",
    categoryId: best.categoryId,
    confidence: best.tight ? 0.9 : 0.7,
    explanation: best.tight
      ? "Matches a bill you track, same amount."
      : "Matches a bill you track; the amount is a little different.",
    recurringItemId: best.id,
  };
}
