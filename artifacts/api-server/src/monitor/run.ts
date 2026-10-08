import { eq } from "drizzle-orm";
import { db, householdsTable, agentRunsTable, agentActionsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { DETECTED_KINDS, runDetectors } from "./detectors";
import { loadMonitorFacts } from "./facts";
import { upsertFindings } from "./store";
import type { Finding, MonitorFacts } from "./types";

// (AI-3) One monitor pass for one household: read the facts once, run the pure
// detectors, record what is new. No model call anywhere. Idempotent: a second
// pass over unchanged facts changes no finding and writes no action (it only
// adds its own agent_runs row), and a retried job finds its run by job id.

export type MonitorTrigger = "user" | "txn_arrived" | "schedule" | "retry";

export interface RunMonitorOptions {
  trigger?: MonitorTrigger;
  /** The pg-boss job id; a retry of the same job reuses its run row. */
  jobId?: string;
  ownerUserId?: string;
  todayISO?: string;
  now?: Date;
  /** Tests hand in facts instead of reading the household. */
  facts?: MonitorFacts;
}

export interface RunMonitorResult {
  runId: string;
  status: "succeeded" | "failed";
  detected: number;
  created: number;
  autoResolved: number;
  summary: string;
  /** True when a retried job found its run already finished. */
  alreadyDone: boolean;
}

export function summaryOf(detected: number, created: number): string {
  return `${detected} ${detected === 1 ? "finding" : "findings"}, ${created} new`;
}

export async function runMonitor(householdId: string, opts: RunMonitorOptions = {}): Promise<RunMonitorResult> {
  const now = opts.now ?? new Date();
  const trigger = opts.trigger ?? "schedule";

  let ownerUserId = opts.ownerUserId;
  if (!ownerUserId) {
    const [h] = await db
      .select({ owner: householdsTable.ownerUserId })
      .from(householdsTable)
      .where(eq(householdsTable.id, householdId));
    if (!h) throw new Error("monitor: household not found");
    ownerUserId = h.owner;
  }

  // One run row per job id: a retried job picks its row back up.
  let run: typeof agentRunsTable.$inferSelect | undefined;
  if (opts.jobId) {
    [run] = await db.select().from(agentRunsTable).where(eq(agentRunsTable.jobId, opts.jobId));
    if (run && run.householdId !== householdId) throw new Error("monitor: job id belongs to another household");
    if (run?.status === "succeeded") {
      return { runId: run.id, status: "succeeded", detected: 0, created: 0, autoResolved: 0, summary: run.summary ?? "", alreadyDone: true };
    }
  }
  if (run) {
    [run] = await db
      .update(agentRunsTable)
      .set({ status: "running", trigger: run.trigger === "retry" ? "retry" : trigger, error: null, finishedAt: null })
      .where(eq(agentRunsTable.id, run.id))
      .returning();
  } else {
    [run] = await db
      .insert(agentRunsTable)
      .values({
        householdId,
        kind: "monitor",
        trigger,
        status: "running",
        startedAt: now,
        ...(opts.jobId ? { jobId: opts.jobId } : {}),
      })
      .returning();
  }
  const runId = run!.id;

  try {
    const facts = opts.facts ?? (await loadMonitorFacts(householdId, ownerUserId, opts.todayISO, now));
    const found: Finding[] = runDetectors(facts);

    const result = await db.transaction(async (tx) => {
      const r = await upsertFindings(tx, householdId, found, DETECTED_KINDS, now);
      if (r.created.length) {
        await tx.insert(agentActionsTable).values(
          r.created.map((f) => ({
            householdId,
            runId,
            type: "finding",
            targetKind: "finding",
            targetId: f.id,
            before: null,
            after: { kind: f.kind, severity: f.severity, confidence: f.confidence, dedupeKey: f.dedupeKey },
            outcome: f.severity === "high" ? "needs_attention" : "applied",
            reversible: false,
          })),
        );
      }
      return r;
    });

    const summary = summaryOf(result.detected, result.created.length);
    await db
      .update(agentRunsTable)
      .set({ status: "succeeded", finishedAt: new Date(), summary })
      .where(eq(agentRunsTable.id, runId));
    return {
      runId,
      status: "succeeded",
      detected: result.detected,
      created: result.created.length,
      autoResolved: result.autoResolved,
      summary,
      alreadyDone: false,
    };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    await db
      .update(agentRunsTable)
      .set({ status: "failed", finishedAt: new Date(), error: message })
      .where(eq(agentRunsTable.id, runId))
      .catch((e) => logger.error({ err: e }, "monitor: could not record the failure"));
    throw err;
  }
}
