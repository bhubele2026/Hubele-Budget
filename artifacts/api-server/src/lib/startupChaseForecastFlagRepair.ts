import { and, eq } from "drizzle-orm";
import { db, transactionsTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * One-shot startup pass: repair `forecast_flag` on a single household's
 * Chase checking transactions that were imported while
 * `forecast_settings.bank_snapshot_account_id` was NULL.
 *
 * Why this is needed: in `plaidSync.ts`, `checkingPlaidAccountId` is
 * resolved from `forecastSettings.bankSnapshotAccountId` (L771-776).
 * While that pointer was NULL, `checkingPlaidAccountId` stayed null, so
 * `isChecking` (L1262-1263) was false for every row and each Chase
 * transaction was inserted with `forecastFlag = isChecking &&
 * !cat.isTransfer` === false (L1534). The pointer was repaired by
 * `startupBankSnapshotPointerRepair`, so new syncs now compute
 * `forecastFlag` correctly — but the rows imported during the broken
 * window are still stuck at `forecast_flag = false` and are therefore
 * invisible to the Debrief / Review queue (`forecast.ts` L376 filters on
 * `forecast_flag = true`).
 *
 * The repair mirrors the sync's own predicate exactly: for the Chase
 * checking account every non-transfer row should have
 * `forecast_flag = true`. The transfer carve-out uses the stored
 * `is_transfer` column, which is the same `cat.isTransfer` the sync
 * persisted (L1521) — so transfers (card payments, internal moves) are
 * correctly left at `forecast_flag = false`.
 *
 * Idempotent: the `forecast_flag = false` guard means once a row is
 * flipped it no longer matches, and future synced rows already get the
 * correct flag at insert time, so subsequent boots are a no-op.
 * Best-effort: errors are logged, never thrown, and never block boot.
 */
const HOUSEHOLD_ID = "a7182af8-49f0-48f3-920e-f916c7eab872";
const CHASE_CHECKING_EXTERNAL_ID = "YEvBBznkA3updAzAk7wyILEPd31z6BSQK184R";

export async function runStartupChaseForecastFlagRepair(): Promise<{
  repaired: number;
}> {
  const summary = { repaired: 0 };
  try {
    const result = await db
      .update(transactionsTable)
      .set({ forecastFlag: true })
      .where(
        and(
          eq(transactionsTable.householdId, HOUSEHOLD_ID),
          eq(transactionsTable.source, "plaid:chase"),
          eq(transactionsTable.plaidAccountId, CHASE_CHECKING_EXTERNAL_ID),
          eq(transactionsTable.forecastFlag, false),
          eq(transactionsTable.isTransfer, false),
        ),
      )
      .returning({ id: transactionsTable.id });

    summary.repaired = result.length;
    if (summary.repaired > 0) {
      logger.info(
        { householdId: HOUSEHOLD_ID, repaired: summary.repaired },
        "Startup Chase forecast-flag repair: flipped forecast_flag to true",
      );
    }
  } catch (err) {
    logger.error({ err }, "Startup Chase forecast-flag repair failed");
  }
  return summary;
}
