import type { Job } from "pg-boss";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import {
  db,
  agentActionsTable,
  agentRunsTable,
  aiUsageTable,
  categoryDecisionsTable,
  householdsTable,
  transactionsTable,
} from "@workspace/db";
import { addDaysISO, householdToday } from "@workspace/avalanche-core";
import { isAiEnabled } from "../../ai/client";
import type { AiFailureInfo } from "../../ai/types";
import { logger } from "../../lib/logger";
import { runCategorizationBatch, type Decision } from "../../lib/categorizer";
import { evaluateModelGate } from "../../lib/categorizer/modelGate";
import { settleSilentAcceptances } from "../../lib/categorizer/review";
import { AnthropicModelStage } from "../../lib/categorizer/modelStage";
import { emit } from "../emit";
import { QUEUES } from "../queues";

// (AI-1) The categorization job: queue `categorize.batch`.
//
//   { householdId, ownerUserId, txnIds, trigger }
//
// The deterministic stages already ran inline at sync time, so this pass is
// idempotent: it runs them again over the ids (a no-op for anything decided),
// then asks the MODEL stage about whatever is still ambiguous. One agent_runs
// row per run (keyed by the pg-boss job id, so a retry picks its row back up);
// one agent_actions row per decision the model made, reversible through
// POST /agent/actions/:id/undo. Nothing here stores a merchant string.
//
// The payload's ids can be incomplete (the queue throttles to one job per
// household per minute), so the job also sweeps the last CATCH_UP_DAYS days of
// rows that still have no category.
//
// (V1, V7) First, provisional model suggestions left standing for 14 days are
// settled as 'unreviewed' (review.ts settleSilentAcceptances): out of the
// queue, still provisional, and NOT part of the gate's record. The gate is `evaluateModelGate` — the same
// function GET /categorization/settings shows the household.
//
// Failures: budget_exceeded ends the run `budget_exceeded` and does NOT retry
// (the rows stay queued for the next run); a retryable provider failure ends
// the run `failed` and throws so pg-boss retries; any other failure ends the
// run `failed` without a retry (the same prompt would fail the same way).

export const CATCH_UP_DAYS = 14;
export const MAX_JOB_IDS = 2000;

export interface CategorizeJobData {
  householdId?: string;
  ownerUserId?: string;
  txnIds?: string[];
  trigger?: "txn_arrived" | "user";
}

/** pg-boss send options: one categorize job per household per minute. */
export function categorizeSendOptions(householdId: string) {
  return {
    singletonKey: `cat:${householdId}`,
    singletonSeconds: 60,
    expireInSeconds: 300,
    retryLimit: 3,
  } as const;
}

export async function enqueueCategorize(
  householdId: string,
  ownerUserId: string,
  txnIds: readonly string[],
  trigger: "txn_arrived" | "user" = "txn_arrived",
): Promise<string | null> {
  return emit(
    QUEUES.categorizeBatch,
    { householdId, ownerUserId, txnIds: txnIds.slice(0, MAX_JOB_IDS), trigger },
    categorizeSendOptions(householdId),
  );
}

/**
 * (V7) The backlog run's model pass: every id, in jobs of at most MAX_JOB_IDS.
 * Each chunk has its own singleton key (`cat:<household>:all:<n>`), so the
 * per-household one-a-minute throttle on `cat:<household>` neither drops a
 * chunk nor is bypassed by everyday syncs; a second click inside the minute
 * is still deduped chunk for chunk. Returns how many ids were handed over.
 */
export async function enqueueCategorizeChunks(
  householdId: string,
  ownerUserId: string,
  txnIds: readonly string[],
  trigger: "txn_arrived" | "user" = "user",
): Promise<number> {
  let n = 0;
  for (let i = 0; i < txnIds.length; i += MAX_JOB_IDS) {
    const part = txnIds.slice(i, i + MAX_JOB_IDS);
    await emit(
      QUEUES.categorizeBatch,
      { householdId, ownerUserId, txnIds: part, trigger },
      { ...categorizeSendOptions(householdId), singletonKey: `cat:${householdId}:all:${i / MAX_JOB_IDS}` },
    );
    n += part.length;
  }
  return n;
}

export interface CategorizeJobResult {
  status: "skipped" | "idle" | "succeeded" | "failed" | "refused" | "budget_exceeded";
  reason?: string;
  runId?: string;
  filed: number;
  waiting: number;
  actions: number;
  failure?: AiFailureInfo;
}

const RETRYABLE_KINDS = new Set(["rate_limited", "timeout", "connection", "api_error"]);

function summaryOf(status: string, filed: number, waiting: number): string {
  const charges = (n: number) => `${n} charge${n === 1 ? "" : "s"}`;
  if (status === "budget_exceeded") return `Paused: this month's AI budget is used up. ${charges(waiting)} waiting for you.`;
  if (status === "refused") return `The categorizer declined this batch. ${charges(waiting)} waiting for you.`;
  if (status === "failed") {
    return filed > 0
      ? `Filed ${charges(filed)}, then stopped on an error. ${waiting} waiting for you.`
      : `Could not reach the categorizer. ${charges(waiting)} waiting for you.`;
  }
  if (filed === 0 && waiting === 0) return "Nothing new to file.";
  return `Filed ${charges(filed)}, ${waiting} waiting for you.`;
}

async function catchUpIds(householdId: string, now: Date): Promise<string[]> {
  const since = addDaysISO(householdToday(now), -CATCH_UP_DAYS);
  const rows = await db
    .select({ id: transactionsTable.id })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        isNull(transactionsTable.categoryId),
        eq(transactionsTable.categoryLockedByUser, false),
        gte(transactionsTable.occurredOn, since),
      ),
    )
    .limit(MAX_JOB_IDS);
  return rows.map((r) => r.id);
}

async function usageOfRun(runId: string) {
  const [u] = await db
    .select({
      input: sql<number>`coalesce(sum(${aiUsageTable.inputTokens}), 0)::int`,
      output: sql<number>`coalesce(sum(${aiUsageTable.outputTokens}), 0)::int`,
      cost: sql<string | null>`sum(${aiUsageTable.costUsd})::text`,
    })
    .from(aiUsageTable)
    .where(eq(aiUsageTable.runId, runId));
  return { input: u?.input ?? 0, output: u?.output ?? 0, cost: u?.cost ?? null };
}

/** The run row for this job: a retry finds its own row by job id. */
async function openRun(householdId: string, trigger: "txn_arrived" | "user", jobId: string | undefined, now: Date) {
  if (jobId) {
    const [existing] = await db.select().from(agentRunsTable).where(eq(agentRunsTable.jobId, jobId));
    if (existing) {
      if (existing.householdId !== householdId) throw new Error("categorize: job id belongs to another household");
      const [re] = await db
        .update(agentRunsTable)
        .set({ status: "running", error: null, finishedAt: null, trigger: existing.trigger === "retry" ? "retry" : existing.trigger })
        .where(eq(agentRunsTable.id, existing.id))
        .returning();
      return { run: re!, reopened: true };
    }
  }
  const [run] = await db
    .insert(agentRunsTable)
    .values({ householdId, kind: "categorize", trigger, status: "running", startedAt: now, ...(jobId ? { jobId } : {}) })
    .returning();
  return { run: run!, reopened: false };
}

export async function runCategorizeJob(
  data: CategorizeJobData,
  opts: { jobId?: string; now?: Date } = {},
): Promise<CategorizeJobResult> {
  const now = opts.now ?? new Date();
  const empty = { filed: 0, waiting: 0, actions: 0 };
  if (!data.householdId) return { status: "skipped", reason: "no household", ...empty };
  const householdId = data.householdId;
  // The owner comes from the household, never from the payload.
  const [hh] = await db
    .select({ ownerUserId: householdsTable.ownerUserId })
    .from(householdsTable)
    .where(eq(householdsTable.id, householdId));
  if (!hh) return { status: "skipped", reason: "no such household", ...empty };
  const trigger = data.trigger === "user" ? "user" : "txn_arrived";
  await settleSilentAcceptances(householdId, now);
  const gate = await evaluateModelGate(householdId, hh.ownerUserId, now);
  const autoAllowed = gate.mode === "auto";
  const ids = [...new Set([...(data.txnIds ?? []).slice(0, MAX_JOB_IDS), ...(await catchUpIds(householdId, now))])];

  // The deterministic stages always run; the model is optional.
  if (gate.mode === "off" || !isAiEnabled()) {
    await runCategorizationBatch(householdId, { txnIds: ids, trigger: "job", now });
    return { status: "skipped", reason: !gate.autoCategorize ? "autoCategorize is off" : "AI is off", ...empty };
  }
  if (ids.length === 0) return { status: "idle", ...empty };

  const { run, reopened } = await openRun(householdId, trigger, opts.jobId, now);
  const stage = new AnthropicModelStage({ autoAllowed, runId: run.id });
  try {
    const out = await runCategorizationBatch(householdId, {
      txnIds: ids,
      trigger: "job",
      modelStage: stage,
      modelAutoAllowed: autoAllowed,
      now,
    });
    const modelDecisions: Decision[] = out.decisions.filter((d) => d.source === "model");
    let actions = 0;
    if (modelDecisions.length > 0) {
      // A retry of the same run must not file the same action twice.
      const already = await db
        .select({ targetId: agentActionsTable.targetId })
        .from(agentActionsTable)
        .where(and(eq(agentActionsTable.runId, run.id), eq(agentActionsTable.type, "set_category")));
      const done = new Set(already.map((a) => a.targetId));
      const fresh = modelDecisions.filter((d) => !done.has(d.transactionId));
      if (fresh.length > 0) {
        await db.insert(agentActionsTable).values(
          fresh.map((d) => {
            const detail = stage.details.get(d.transactionId);
            return {
              householdId,
              runId: run.id,
              type: "set_category",
              targetKind: "transaction",
              targetId: d.transactionId,
              before: { categoryId: d.previousCategoryId },
              after: {
                categoryId: d.categoryId,
                decisionId: d.id,
                confidence: d.confidence,
                band: d.band,
                ...(detail?.isTransfer ? { looksLikeTransfer: true } : {}),
                ...(detail?.recurring ? { recurring: detail.recurring } : {}),
                ...(detail?.split ? { split: detail.split } : {}),
              },
              outcome: d.band === "auto" ? "applied" : "proposed",
              reversible: true,
            };
          }),
        );
        actions = fresh.length;
      }
    }
    // Counted from the run's own actions, so a retry reports what the whole run did.
    const runActions = await db
      .select({ after: agentActionsTable.after })
      .from(agentActionsTable)
      .where(and(eq(agentActionsTable.runId, run.id), eq(agentActionsTable.type, "set_category")));
    const filed = runActions.filter((a) => {
      const x = a.after as { band?: string; categoryId?: string | null } | null;
      return x?.band !== "queue" && x?.categoryId != null;
    }).length;
    const waiting = out.ambiguous.length;
    const failure = stage.failure;
    const benign = failure?.kind === "disabled";
    const status: CategorizeJobResult["status"] =
      !failure || benign ? "succeeded" : failure.kind === "budget_exceeded" ? "budget_exceeded" : failure.kind === "refusal" ? "refused" : "failed";

    // Nothing asked, nothing answered, nothing wrong: leave no trace in the Activity trail.
    if (!reopened && status === "succeeded" && stage.usage.calls === 0 && modelDecisions.length === 0) {
      await db.delete(agentRunsTable).where(eq(agentRunsTable.id, run.id));
      return { status: "idle", ...empty };
    }

    const u = await usageOfRun(run.id);
    await db
      .update(agentRunsTable)
      .set({
        status,
        finishedAt: new Date(),
        inputTokens: u.input,
        outputTokens: u.output,
        costUsd: u.cost,
        summary: summaryOf(status, filed, waiting),
        error: failure && !benign ? `${failure.kind}`.slice(0, 300) : null,
      })
      .where(eq(agentRunsTable.id, run.id));
    const result: CategorizeJobResult = { status, runId: run.id, filed, waiting, actions, ...(failure && !benign ? { failure } : {}) };
    if (failure && RETRYABLE_KINDS.has(failure.kind) && failure.retryable) {
      // pg-boss retries with backoff; the run row is reused by job id.
      throw new Error(`categorize: ${failure.kind}`);
    }
    return result;
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    await db
      .update(agentRunsTable)
      .set({ status: "failed", finishedAt: new Date(), error: message, summary: "Could not finish this batch. Charges are waiting for you." })
      .where(and(eq(agentRunsTable.id, run.id), eq(agentRunsTable.status, "running")))
      .catch(() => {});
    logger.error({ err, jobId: opts.jobId }, "categorize job failed");
    throw err;
  }
}

export async function handleCategorizeJobs(jobs: Job<CategorizeJobData>[]): Promise<CategorizeJobResult[]> {
  const results: CategorizeJobResult[] = [];
  for (const job of jobs) {
    results.push(await runCategorizeJob(job.data ?? {}, { jobId: job.id }));
  }
  return results;
}

/**
 * Unresolved review-queue rows (open queue-band decisions), for a manual "run
 * it now". (V7) `limit: null` reads them all (the backlog run chunks them).
 */
export async function openQueueTxnIds(householdId: string, limit: number | null = MAX_JOB_IDS): Promise<string[]> {
  const q = db
    .selectDistinct({ id: categoryDecisionsTable.transactionId })
    .from(categoryDecisionsTable)
    .where(
      and(
        eq(categoryDecisionsTable.householdId, householdId),
        eq(categoryDecisionsTable.band, "queue"),
        isNull(categoryDecisionsTable.resolvedAt),
        isNull(categoryDecisionsTable.undoneAt),
      ),
    );
  const rows = limit == null ? await q : await q.limit(limit);
  return rows.map((r) => r.id);
}
