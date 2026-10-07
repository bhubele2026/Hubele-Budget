import type { Job } from "pg-boss";
import { logger } from "../../lib/logger";
import { prunePlaidSyncAttempts } from "../../lib/plaidSyncAttempts";

// (#279, moved from node-cron in AI-0) Daily prune of the plaid_sync_attempts
// audit log so it stays bounded. No Plaid API calls — free. 03:47 UTC, as
// before. A throw fails the job, so pg-boss retries it and, after the last
// retry, parks it in the DLQ where /ops/jobs shows it.

export const PRUNE_SYNC_ATTEMPTS_CRON = "47 3 * * *";
export const PRUNE_SYNC_ATTEMPTS_TZ = "UTC";

export async function handlePruneSyncAttempts(_jobs: Job<object>[]): Promise<{ deleted: number }> {
  const deleted = await prunePlaidSyncAttempts();
  logger.info({ deleted }, "Daily plaid_sync_attempts prune complete");
  return { deleted };
}
