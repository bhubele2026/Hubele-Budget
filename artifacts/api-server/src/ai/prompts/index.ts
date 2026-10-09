import type Anthropic from "@anthropic-ai/sdk";
import { logger } from "../../lib/logger";
import { recapV1 } from "./recap.v1";
import { recapV2 } from "./recap.v2";
import { recapV3 } from "./recap.v3";
import type { AiTask } from "../config";
import { categorizeV1 } from "./categorize.v1";
import { chatV1 } from "./chat.v1";

// (AI-0) Versioned prompts. Each task maps version keys ("v1", "v2", …) to a
// prompt; the newest runs unless AI_PROMPT_<TASK> names another version (an
// eval can pin one). System text is stable — no dates, ids or other
// per-call values in it — so prompt caching can hit; per-call facts go in
// `build`'s messages, outside text wrapped with `untrusted()`.
//
// Each business prompt arrives with the package that owns its task (AI-1:
// categorize.v1; AI-4a: recap.v1). `ping.v1` exists for the tests only.

export interface PromptDef<I = any> {
  /** Recorded on every ai_usage row, e.g. "categorize.v2". */
  PROMPT_VERSION: string;
  system: string;
  build(input: I): Anthropic.MessageParam[];
}

export type PromptRegistry = Partial<Record<AiTask, Record<string, PromptDef>>>;

export const PROMPTS: PromptRegistry = {
  // (AI-1) The categorization prompt.
  categorize: { v1: categorizeV1 },
  // (AI-4a) The morning recap prompt.
  // (Dashboard refinement) v3: the cash sentence says "Checking covers $X until <day>".
  recap: { v1: recapV1, v2: recapV2, v3: recapV3 },
  // (AI-2) The Ask prompt.
  chat: { v1: chatV1 },
};

function versionNumber(key: string): number {
  const m = /^v(\d+)$/.exec(key);
  return m ? Number(m[1]) : -1;
}

export function resolvePrompt(task: AiTask, registry: PromptRegistry = PROMPTS): PromptDef | null {
  const versions = registry[task];
  if (!versions) return null;
  const keys = Object.keys(versions);
  if (keys.length === 0) return null;
  const pinned = process.env[`AI_PROMPT_${task.toUpperCase()}`]?.trim();
  if (pinned) {
    if (versions[pinned]) return versions[pinned]!;
    logger.warn({ task, pinned }, "AI_PROMPT_<TASK> names a version that does not exist — using the newest");
  }
  const newest = keys.reduce((a, b) => (versionNumber(b) > versionNumber(a) ? b : a));
  return versions[newest] ?? null;
}
