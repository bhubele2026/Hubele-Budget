import { and, isNotNull, ne, sql } from "drizzle-orm";
import { db, forecastSettingsTable } from "@workspace/db";
import { dedupePlaidAccountsForUser } from "./dedupePlaidAccounts";
import { logger } from "./logger";

/**
 * (#434) One-shot startup pass: walk every user with a non-empty
 * `forecast_settings.accountSnapshots` map and run
 * `dedupePlaidAccountsForUser` on them.
 *
 * Task #429 made the dedupe routine also prune/salvage orphan
 * `accountSnapshots` keys, but the repair only fires for a given user
 * when something triggers it (Chase seed path, the user-scoped
 * `POST /forecast/dedupe-plaid-accounts` endpoint, a Plaid relink, or
 * the gated auto-heal in `listCheckingAccounts`). Users whose
 * auto-dedupe gate was already stamped before #429 won't see
 * Starting/Ending balance come back until they happen to trigger one
 * of those — this sweep covers that long tail.
 *
 * Called directly (bypassing the `runAutoDedupeIfNeeded` gate) because
 * the gate would skip already-stamped users, which is exactly the
 * cohort we're trying to heal. The dedupe routine is idempotent, so a
 * clean account is a no-op (the report shows zero changes).
 *
 * Best-effort: per-user failures are logged but never thrown, and the
 * sweep itself never blocks boot — it runs as a fire-and-forget after
 * the server has already started listening.
 */
export async function runStartupAccountSnapshotsRepair(): Promise<{
  scanned: number;
  changed: number;
  failed: number;
}> {
  const summary = { scanned: 0, changed: 0, failed: 0 };
  let users: Array<{ userId: string }> = [];
  try {
    users = await db
      .select({ userId: forecastSettingsTable.userId })
      .from(forecastSettingsTable)
      .where(
        and(
          isNotNull(forecastSettingsTable.accountSnapshots),
          ne(
            sql`jsonb_typeof(${forecastSettingsTable.accountSnapshots})`,
            sql`'null'`,
          ),
          sql`(${forecastSettingsTable.accountSnapshots})::text <> '{}'`,
        ),
      );
  } catch (err) {
    logger.error(
      { err },
      "Startup accountSnapshots repair: failed to enumerate eligible users",
    );
    return summary;
  }

  for (const { userId } of users) {
    summary.scanned += 1;
    try {
      const report = await dedupePlaidAccountsForUser(userId);
      const changed =
        report.duplicatesRemoved > 0 ||
        report.snapshotRepointed ||
        report.syntheticDropped ||
        report.accountSnapshotsRepointed > 0 ||
        report.accountSnapshotsPruned > 0 ||
        (report.transactionsDeduped ?? 0) > 0;
      if (changed) {
        summary.changed += 1;
        logger.info(
          {
            userId,
            duplicatesRemoved: report.duplicatesRemoved,
            transactionsRepointed: report.transactionsRepointed,
            debtsRepointed: report.debtsRepointed,
            snapshotRepointed: report.snapshotRepointed,
            syntheticDropped: report.syntheticDropped,
            accountSnapshotsRepointed: report.accountSnapshotsRepointed,
            accountSnapshotsPruned: report.accountSnapshotsPruned,
            transactionsDeduped: report.transactionsDeduped ?? 0,
          },
          "Startup accountSnapshots repair: healed user",
        );
      }
    } catch (err) {
      summary.failed += 1;
      logger.error(
        { err, userId },
        "Startup accountSnapshots repair: dedupe failed for user",
      );
    }
  }

  return summary;
}
