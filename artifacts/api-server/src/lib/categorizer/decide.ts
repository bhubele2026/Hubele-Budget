// (PR-A) The deterministic pipeline for one row — pure, no I/O.
import { heuristicStage, refundStage } from "./stages/heuristic";
import { inheritedStage } from "./stages/inherited";
import { lockedStage } from "./stages/locked";
import { memoryStage } from "./stages/memory";
import { recurringStage } from "./stages/recurring";
import { ruleStage } from "./stages/rule";
import type { EngineContext, EngineRow, StageResult } from "./types";

/**
 * locked → refund → memory → rule → recurring → inherited → heuristic. The
 * first stage that yields wins. (Round 2) memory precedes rule: a memory row
 * exists only because a person corrected or confirmed that merchant, so it is
 * the more specific, more recent signal; a rule is a broad pattern. Memory
 * still applies only to rows that arrived after it was learned. `inherited`
 * overrides an earlier automatic pick only where the read-time
 * `effectiveFiling` would (see stages/inherited.ts). The model stage is not
 * here: it sees only what this returns nothing (or a queue decision) for.
 *
 * ⭐ (B6) A credit that links to an earlier purchase (`refundStage`) is a
 * refund, and a refund is never auto-filed: its queue decision comes before
 * memory, rules and recurring items, which would otherwise file it as the
 * purchase it returns. Only the filing of the pending row it replaced still
 * carries (`inherited`, as the readers' `effectiveFiling` already counts it).
 */
export function decideRow(row: EngineRow, ctx: EngineContext): StageResult | null {
  const locked = lockedStage(row);
  if (locked) return locked;
  const refund = refundStage(row, ctx);
  if (refund) return inheritedStage(row, null, ctx) ?? refund;
  const earlier = memoryStage(row, ctx) ?? ruleStage(row, ctx) ?? recurringStage(row, ctx);
  const inherited = inheritedStage(row, earlier, ctx);
  if (inherited) return inherited;
  if (earlier) return earlier;
  return heuristicStage(row, ctx);
}
