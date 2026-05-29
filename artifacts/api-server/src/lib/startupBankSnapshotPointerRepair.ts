import { and, eq, isNull } from "drizzle-orm";
import { db, forecastSettingsTable, householdsTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * One-shot startup pass: repair a single household's
 * `forecast_settings.bank_snapshot_account_id`, which is NULL even
 * though the snapshot tile already carries the correct balance / name /
 * mask for the user's Chase TOTAL CHECKING (…5526) account.
 *
 * Why this matters: `cashSignal.ts` resolves the configured checking
 * account's external Plaid id by joining `bank_snapshot_account_id ->
 * plaid_accounts.id`. When the pointer is NULL the lookup is skipped,
 * `configuredCheckingExternalId` stays null, and `isBankRow()` returns
 * false for every transaction carrying a `plaid_account_id`. That drops
 * all of the household's `plaid:chase` rows out of the bank set, leaves
 * `matchedTxnBankSet` empty, and breaks the matched-transaction dedupe —
 * so already-paid recurring items (e.g. the Chase Amazon Prime Visa
 * minimum) get mis-flagged as past-due on /forecast.
 *
 * The fix only touches the pointer column. The balance / at / source /
 * name / mask fields are intentionally left alone — they are already
 * correct ($2,000 / 05-28) and re-pulling a live balance (the
 * /forecast/bank-snapshot path) would overwrite them.
 *
 * Idempotent: the `bank_snapshot_account_id IS NULL` guard means once
 * the pointer is set the WHERE clause matches nothing, so subsequent
 * boots are a no-op. Best-effort: errors are logged, never thrown, and
 * never block boot.
 */
const HOUSEHOLD_ID = "a7182af8-49f0-48f3-920e-f916c7eab872";
const TARGET_ACCOUNT_ID = "9ab57174-3dc4-4c63-bdda-349b95c98330";

export async function runStartupBankSnapshotPointerRepair(): Promise<{
  repaired: number;
}> {
  const summary = { repaired: 0 };
  try {
    const [household] = await db
      .select({ ownerUserId: householdsTable.ownerUserId })
      .from(householdsTable)
      .where(eq(householdsTable.id, HOUSEHOLD_ID));
    if (!household) {
      // Wrong DB (e.g. a fresh dev database) — nothing to repair.
      return summary;
    }

    const result = await db
      .update(forecastSettingsTable)
      .set({ bankSnapshotAccountId: TARGET_ACCOUNT_ID })
      .where(
        and(
          eq(forecastSettingsTable.userId, household.ownerUserId),
          isNull(forecastSettingsTable.bankSnapshotAccountId),
        ),
      )
      .returning({ userId: forecastSettingsTable.userId });

    summary.repaired = result.length;
    if (summary.repaired > 0) {
      logger.info(
        { householdId: HOUSEHOLD_ID, accountId: TARGET_ACCOUNT_ID },
        "Startup bank-snapshot pointer repair: set bank_snapshot_account_id",
      );
    }
  } catch (err) {
    logger.error({ err }, "Startup bank-snapshot pointer repair failed");
  }
  return summary;
}
