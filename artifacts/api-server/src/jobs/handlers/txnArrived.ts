import type { Job } from "pg-boss";
import { logger } from "../../lib/logger";
import { enqueueCategorize, MAX_JOB_IDS } from "./categorize";
import { enqueueMonitor } from "./monitor";

// (AI-1) Queue `txn.arrived`: new or changed rows landed for a household (the
// end of a Plaid sync emits it). It fans out to the two things that react to
// arrivals:
//
//   categorize.batch   only when the sync left rows its deterministic stages
//                      could not decide (`txnIds` = those ids)
//   monitor.household  always (AI-3's pass over the household's money facts)
//
// Both are singleton-throttled per household, so a burst of syncs collapses.

export interface TxnArrivedData {
  householdId?: string;
  ownerUserId?: string;
  /** Rows the deterministic stages left ambiguous. */
  txnIds?: string[];
  /** How many rows the sync touched (for the log only). */
  arrived?: number;
}

export async function handleTxnArrived(
  jobs: Job<TxnArrivedData>[],
): Promise<{ categorize: number; monitor: number }> {
  let categorize = 0;
  let monitor = 0;
  for (const job of jobs) {
    const d = job.data ?? {};
    if (!d.householdId || !d.ownerUserId) {
      logger.warn({ jobId: job.id }, "txn.arrived without a household; dropped");
      continue;
    }
    const ids = (d.txnIds ?? []).slice(0, MAX_JOB_IDS);
    if (ids.length > 0) {
      await enqueueCategorize(d.householdId, d.ownerUserId, ids, "txn_arrived");
      categorize++;
    }
    await enqueueMonitor(d.householdId, d.ownerUserId, "txn_arrived");
    monitor++;
  }
  return { categorize, monitor };
}
