import { db, aiUsageTable } from "@workspace/db";
import { logger } from "../lib/logger";
import type { AiTask } from "./config";
import type { AiFailureKind, TokenUsage } from "./types";

// (AI-0) The ai_usage ledger: one row per API attempt, plus a zero-cost row
// for each call the budget blocked. Nothing about the prompt or the answer is
// stored — counts, cost, timing, status and ids only.

export type AiUsageStatus = "ok" | AiFailureKind;

export interface UsageRecord {
  householdId: string | null;
  task: AiTask;
  model: string;
  promptVersion?: string | null;
  runId?: string | null;
  usage?: TokenUsage | null;
  costUsd: number | null;
  latencyMs?: number | null;
  status: AiUsageStatus;
  requestId?: string | null;
  createdAt?: Date;
}

/**
 * Append one ledger row. A failed write is logged and swallowed: the ledger
 * must never turn a finished model call into an error for the user.
 */
export async function recordUsage(rec: UsageRecord): Promise<void> {
  try {
    await db.insert(aiUsageTable).values({
      householdId: rec.householdId,
      task: rec.task,
      model: rec.model,
      promptVersion: rec.promptVersion ?? null,
      runId: rec.runId ?? null,
      inputTokens: rec.usage?.inputTokens ?? null,
      outputTokens: rec.usage?.outputTokens ?? null,
      cacheWriteTokens: rec.usage?.cacheWriteTokens ?? null,
      cacheReadTokens: rec.usage?.cacheReadTokens ?? null,
      costUsd: rec.costUsd === null ? null : rec.costUsd.toFixed(6),
      latencyMs: rec.latencyMs ?? null,
      status: rec.status,
      requestId: rec.requestId ?? null,
      ...(rec.createdAt ? { createdAt: rec.createdAt } : {}),
    });
  } catch (err) {
    logger.error(
      { err, ai: { task: rec.task, status: rec.status, model: rec.model } },
      "ai_usage write failed",
    );
  }
}
