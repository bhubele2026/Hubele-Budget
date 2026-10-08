import type { Job } from "pg-boss";
import { eq } from "drizzle-orm";
import { db, debtsTable, householdsTable, plaidItemsTable } from "@workspace/db";
import { monthStartOf } from "@workspace/avalanche-core";
import { prepareBudgetMonth } from "../../routes/budget";
import { writeAchievedMilestones, writeDebtProgressSnapshots } from "../../lib/debtProgressSnapshot";
import { householdTodayISO } from "../../lib/householdClock";
import { logger } from "../../lib/logger";
import { writeDailyMetrics } from "../../lib/metricsSnapshot";
import { emit } from "../emit";
import { QUEUES } from "../queues";

// (PR-E) The nightly progress snapshot: queue `metrics.snapshot`.
//
//   { householdId, ownerUserId, asOf? }  one household's pass.
//   { fanout: true }                     the 03:30 America/Chicago tick: enqueue
//                                        one job per household that has a debt or
//                                        a Plaid item. One schedule, however many
//                                        households there are.
//
// One pass = the budget syncs that no longer run on a GET (this month's
// auto_debts / auto_bills / Avalanche lines; failure is logged, never fatal) →
// `writeDebtProgressSnapshots` → `writeAchievedMilestones` → `writeDailyMetrics`.
// Every step is an upsert or insert-only, so a retry, or two runs in a day, leave
// one row per day. The per-household job is a pg-boss singleton per household per
// day. A throw fails the job; pg-boss retries it and then parks it in the DLQ.

export const METRICS_CRON = "30 3 * * *";
export const METRICS_TZ = "America/Chicago";

export interface MetricsJobData {
  householdId?: string;
  ownerUserId?: string;
  /** YYYY-MM-DD; default the household's today. */
  asOf?: string;
  fanout?: boolean;
}

/** pg-boss send options: one job per household per day. */
export function metricsSendOptions(householdId: string, day: string) {
  return {
    singletonKey: `metrics:${householdId}:${day}`,
    singletonSeconds: 6 * 60 * 60,
    expireInSeconds: 300,
    retryLimit: 2,
  } as const;
}

export async function enqueueMetricsSnapshot(
  householdId: string,
  ownerUserId: string,
  day: string = householdTodayISO(),
): Promise<string | null> {
  return emit(QUEUES.metricsSnapshot, { householdId, ownerUserId, asOf: day }, metricsSendOptions(householdId, day));
}

/** Households with a debt or a Plaid item, with their owners. */
export async function householdsToSnapshot(): Promise<Array<{ householdId: string; ownerUserId: string }>> {
  const [withItems, withDebts] = await Promise.all([
    db
      .selectDistinct({ householdId: householdsTable.id, ownerUserId: householdsTable.ownerUserId })
      .from(plaidItemsTable)
      .innerJoin(householdsTable, eq(plaidItemsTable.householdId, householdsTable.id)),
    db
      .selectDistinct({ householdId: householdsTable.id, ownerUserId: householdsTable.ownerUserId })
      .from(debtsTable)
      .innerJoin(householdsTable, eq(debtsTable.householdId, householdsTable.id)),
  ]);
  const byId = new Map<string, string>();
  for (const r of [...withItems, ...withDebts]) byId.set(r.householdId, r.ownerUserId);
  return [...byId].map(([householdId, ownerUserId]) => ({ householdId, ownerUserId }));
}

export interface MetricsRunResult {
  asOf: string;
  snapshotsWritten: number;
  milestonesInserted: string[];
  metricsWritten: boolean;
}

/** One household's pass for `asOfDay` (also what `POST /metrics/recompute` runs). */
export async function runMetricsSnapshot(
  householdId: string,
  ownerUserId: string,
  asOfDay: string = householdTodayISO(),
): Promise<MetricsRunResult> {
  // The budget syncs only make sense for today's month; a failure must not cost
  // the day its metrics.
  if (asOfDay === householdTodayISO()) {
    try {
      await prepareBudgetMonth(householdId, ownerUserId, ownerUserId, monthStartOf(asOfDay));
    } catch (err) {
      logger.warn({ err, householdId }, "nightly budget sync failed; continuing with the metrics");
    }
  }
  const snapshots = await writeDebtProgressSnapshots(householdId, asOfDay);
  const milestones = await writeAchievedMilestones(householdId, asOfDay);
  const metrics = await writeDailyMetrics(householdId, ownerUserId, asOfDay);
  return {
    asOf: asOfDay,
    snapshotsWritten: snapshots.written,
    milestonesInserted: milestones.inserted,
    metricsWritten: metrics.written,
  };
}

export async function handleMetricsSnapshot(
  jobs: Job<MetricsJobData>[],
): Promise<{ households: number; fannedOut: number }> {
  let households = 0;
  let fannedOut = 0;
  for (const job of jobs) {
    const data = job.data ?? {};
    if (data.fanout) {
      for (const h of await householdsToSnapshot()) {
        await enqueueMetricsSnapshot(h.householdId, h.ownerUserId);
        fannedOut++;
      }
      continue;
    }
    if (!data.householdId || !data.ownerUserId) {
      logger.warn({ jobId: job.id }, "metrics job without a household; dropped");
      continue;
    }
    await runMetricsSnapshot(data.householdId, data.ownerUserId, data.asOf);
    households++;
  }
  return { households, fannedOut };
}
