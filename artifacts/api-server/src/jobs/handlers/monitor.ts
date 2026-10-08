import type { Job } from "pg-boss";
import { eq } from "drizzle-orm";
import { db, householdsTable, plaidItemsTable } from "@workspace/db";
import { logger } from "../../lib/logger";
import { settleSilentAcceptances } from "../../lib/categorizer/review";
import { runMonitor } from "../../monitor/run";
import { emit } from "../emit";
import { QUEUES } from "../queues";

// (AI-3) The monitor's job: queue `monitor.household`.
//
//   { householdId, ownerUserId }  one household's pass (`runMonitor`).
//   { fanout: true }              the daily 02:15 America/Chicago tick: enqueue
//                                 one per-household job for every household
//                                 with a Plaid item. One schedule, however many
//                                 households there are.
//
// Idempotent on retry (the run is keyed by the pg-boss job id). A throw fails
// the job, so pg-boss retries it (retryLimit 2) and then parks it in the DLQ.
// Chaining from `txn.arrived` is one `enqueueMonitor(...)` call from that
// handler once PR-A lands — see docs/reviews/2026-10-07-ai3-monitoring.md.
//
// (V1) Each household's pass first settles provisional model suggestions left
// standing for 14 days (review.ts settleSilentAcceptances; idempotent), so the
// model's record moves nightly even on a day no charge arrives.

export const MONITOR_CRON = "15 2 * * *";
export const MONITOR_TZ = "America/Chicago";

export interface MonitorJobData {
  householdId?: string;
  ownerUserId?: string;
  fanout?: boolean;
  trigger?: "txn_arrived" | "schedule";
}

/** pg-boss send options for one household's job. */
export function monitorSendOptions(householdId: string) {
  return {
    singletonKey: `mon:${householdId}`,
    singletonSeconds: 600,
    expireInSeconds: 300,
    retryLimit: 2,
  } as const;
}

export async function enqueueMonitor(
  householdId: string,
  ownerUserId: string,
  trigger: "txn_arrived" | "schedule" = "schedule",
): Promise<string | null> {
  return emit(QUEUES.monitorHousehold, { householdId, ownerUserId, trigger }, monitorSendOptions(householdId));
}

/** Households with at least one Plaid item, with their owners. */
export async function householdsToMonitor(): Promise<Array<{ householdId: string; ownerUserId: string }>> {
  const rows = await db
    .selectDistinct({ householdId: householdsTable.id, ownerUserId: householdsTable.ownerUserId })
    .from(plaidItemsTable)
    .innerJoin(householdsTable, eq(plaidItemsTable.householdId, householdsTable.id));
  return rows;
}

export async function handleMonitorJobs(jobs: Job<MonitorJobData>[]): Promise<{ households: number; fannedOut: number }> {
  let households = 0;
  let fannedOut = 0;
  for (const job of jobs) {
    const data = job.data ?? {};
    if (data.fanout) {
      for (const h of await householdsToMonitor()) {
        await enqueueMonitor(h.householdId, h.ownerUserId, "schedule");
        fannedOut++;
      }
      continue;
    }
    if (!data.householdId || !data.ownerUserId) {
      logger.warn({ jobId: job.id }, "monitor job without a household; dropped");
      continue;
    }
    await settleSilentAcceptances(data.householdId);
    await runMonitor(data.householdId, {
      ownerUserId: data.ownerUserId,
      trigger: data.trigger ?? "schedule",
      jobId: job.id,
    });
    households++;
  }
  return { households, fannedOut };
}
