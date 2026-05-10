import { and, eq, ilike, or } from "drizzle-orm";
import { db, transactionsTable } from "@workspace/db";
import { TRANSFER_DESC_PATTERNS } from "./autoCategorize";
import { logger } from "./logger";

/**
 * (#632) One-shot startup pass: find existing transactions whose
 * description matches the card-payment / transfer patterns added in
 * this task and either (a) aren't yet flagged `isTransfer=true`, or (b)
 * still carry one of the Weekly/Monthly/Unplanned allowance flags. For
 * each, set `isTransfer=true` and zero out the three allowance flags so
 * the row stops contaminating dashboard buckets.
 *
 * Description-only by design: the schema does not persist Plaid's
 * personal_finance_category, so PFC-based catch-up isn't possible from
 * stored data. The live classifier (`autoCategorize` + `plaidSync`)
 * already covers the LOAN_PAYMENTS PFC path on every future sync, so
 * any row touched again will be repaired automatically. See follow-up
 * task #636 for persisting PFC and broadening the backfill.
 *
 * Skips rows the user has explicitly toggled
 * (`is_transfer_user_overridden=true`) — same contract the live
 * classifier and Plaid sync upserts honor.
 *
 * Idempotent: once converged, the WHERE clause matches nothing and the
 * sweep is a no-op. Best-effort: errors are logged, never thrown, and
 * never block boot.
 */
export async function runStartupCardPaymentReclassify(): Promise<{
  scanned: number;
  reclassified: number;
}> {
  const summary = { scanned: 0, reclassified: 0 };
  try {
    // Description match: OR-chain of case-insensitive ILIKE %frag% built
    // via Drizzle's `or()` builder so the SQL is fully parenthesised
    // (precedence-safe) and composes cleanly inside the outer `and()`.
    const descConds = TRANSFER_DESC_PATTERNS.map((frag) =>
      ilike(transactionsTable.description, `%${frag}%`),
    );
    const descMatch = or(...descConds);
    if (!descMatch) {
      // No patterns configured -> nothing to do.
      return summary;
    }

    const needsFix = or(
      eq(transactionsTable.isTransfer, false),
      eq(transactionsTable.weeklyAllowance, true),
      eq(transactionsTable.monthlyAllowance, true),
      eq(transactionsTable.unplannedAllowance, true),
    )!;

    const result = await db
      .update(transactionsTable)
      .set({
        isTransfer: true,
        weeklyAllowance: false,
        monthlyAllowance: false,
        unplannedAllowance: false,
      })
      .where(
        and(
          eq(transactionsTable.isTransferUserOverridden, false),
          descMatch,
          needsFix,
        ),
      )
      .returning({ id: transactionsTable.id });

    summary.scanned = result.length;
    summary.reclassified = result.length;
    logger.info(
      summary,
      "Startup card-payment reclassify sweep complete",
    );
  } catch (err) {
    logger.error({ err }, "Startup card-payment reclassify sweep failed");
  }
  return summary;
}
