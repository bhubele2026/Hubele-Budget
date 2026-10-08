import type { EngineRow, StageResult } from "../types";

/** A row a person filed is never moved. Emitted once, then skipped. */
export function lockedStage(row: EngineRow): StageResult | null {
  if (!row.categoryLockedByUser) return null;
  return {
    source: "locked",
    categoryId: row.categoryId,
    confidence: 1,
    explanation: "You filed this one yourself.",
  };
}
