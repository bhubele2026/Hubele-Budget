import type { Job } from "pg-boss";
import { logger } from "../../lib/logger";
import { runBankAutoSort } from "../../lib/bankAutoSort";
import { enqueueCategorize, MAX_JOB_IDS } from "./categorize";
import { enqueueMonitor } from "./monitor";

// (AI-1) Queue `txn.arrived`: new or changed rows landed for a household (the
// end of a Plaid sync emits it). It fans out to the two things that react to
// arrivals:
//
//   categorize.batch   only when the sync left rows its deterministic stages
//                      could not decide (`txnIds` = those ids)
//   monitor.household  always (AI-3's pass over the household's money facts)
//   bank auto-sort     ⭐ (BANK-AUTO) always, inline: the rows H2 is sure of are
//                      matched, and provisional categories the household's own
//                      filings agree with are filed (lib/bankAutoSort.ts).
//                      Idempotent; a failure is logged and never fails the job.
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
    try {
      const sorted = await runBankAutoSort(d.householdId, d.ownerUserId);
      if (sorted.matched.length > 0 || sorted.categorized.length > 0) {
        logger.info(
          { householdId: d.householdId, matched: sorted.matched.length, categorized: sorted.categorized.length },
          "[bank-auto-sort] sorted after sync",
        );
      }
    } catch (err) {
      logger.warn({ householdId: d.householdId, err }, "[bank-auto-sort] failed after sync (non-fatal)");
    }
    await enqueueMonitor(d.householdId, d.ownerUserId, "txn_arrived");
    monitor++;
  }
  return { categorize, monitor };
}
