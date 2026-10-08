// (PR-A) The deterministic pipeline for one row — pure, no I/O.
import { heuristicStage } from "./stages/heuristic";
import { inheritedStage } from "./stages/inherited";
import { lockedStage } from "./stages/locked";
import { memoryStage } from "./stages/memory";
import { recurringStage } from "./stages/recurring";
import { ruleStage } from "./stages/rule";
import type { EngineContext, EngineRow, StageResult } from "./types";

/**
 * locked → memory → rule → recurring → inherited → heuristic. The first stage
 * that yields wins. (Round 2) memory precedes rule: a memory row exists only
 * because a person corrected or confirmed that merchant, so it is the more
 * specific, more recent signal; a rule is a broad pattern. Memory still
 * applies only to rows that arrived after it was learned. `inherited` overrides an earlier automatic pick only where
 * the read-time `effectiveFiling` would (see stages/inherited.ts). The model
 * stage is not here: it sees only what this returns nothing (or a queue
 * decision) for.
 */
export function decideRow(row: EngineRow, ctx: EngineContext): StageResult | null {
  const locked = lockedStage(row);
  if (locked) return locked;
  const earlier = memoryStage(row, ctx) ?? ruleStage(row, ctx) ?? recurringStage(row, ctx);
  const inherited = inheritedStage(row, earlier, ctx);
  if (inherited) return inherited;
  if (earlier) return earlier;
  return heuristicStage(row, ctx);
}
