import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

/**
 * (#676) One-shot startup pass scoped to a single household: after the
 * user re-linked Chase in Production on 2026-05-16, Plaid back-filled
 * ~90 days of history into the household, flooding the forecast review
 * bucket with 75 settled May Chase rows (plus 48 settled May Amex rows
 * from the earlier re-link) on top of the 8 actually-pending charges.
 * The user explicitly asked for the review bucket to drop to just the
 * real pending charges.
 *
 * For the target household, mark every `plaid:%`-sourced May 2026
 * transaction as `reviewed = true, unplanned_allowance = true` UNLESS:
 *   - the row is currently pending (`notes = '[pending]'`), or
 *   - the row is referenced by a live `forecast_resolutions.matched_txn_id`
 *
 * Idempotent: the WHERE clause excludes rows already swept on the next
 * boot (they keep their pending/match status; the flag flip on settled
 * backfill rows is safe to re-apply but the row count goes to zero
 * once everything's converged). Best-effort: never crashes boot.
 */
const TARGET_HOUSEHOLD_ID = "a7182af8-49f0-48f3-920e-f916c7eab872";

export async function runStartupMay2026BackfillSweep(): Promise<{
  ran: boolean;
  swept: number;
  reason?: string;
}> {
  try {
    const result = await db.execute(sql`
      UPDATE transactions
         SET unplanned_allowance = true,
             reviewed = true
       WHERE household_id = ${TARGET_HOUSEHOLD_ID}::uuid
         AND source LIKE 'plaid:%'
         AND occurred_on >= '2026-05-01'
         AND occurred_on <  '2026-06-01'
         AND (notes IS NULL OR notes <> '[pending]')
         AND (unplanned_allowance = false OR reviewed = false)
         AND NOT EXISTS (
           SELECT 1 FROM forecast_resolutions fr
            WHERE fr.matched_txn_id = transactions.id
         )
    `);
    const swept = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    if (swept > 0) {
      logger.info(
        { householdId: TARGET_HOUSEHOLD_ID, swept },
        "[startup-may-2026-backfill-sweep] swept backfilled review-bucket rows",
      );
    }
    return { ran: true, swept };
  } catch (err) {
    logger.error({ err }, "Startup May-2026 backfill sweep failed");
    return { ran: false, swept: 0, reason: "error" };
  }
}
