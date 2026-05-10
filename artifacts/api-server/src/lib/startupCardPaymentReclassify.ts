import { and, eq, ilike, or, sql } from "drizzle-orm";
import { db, transactionsTable } from "@workspace/db";
import {
  TRANSFER_DESC_PATTERNS,
  TRANSFER_PFC_PRIMARY,
} from "./autoCategorize";
import { logger } from "./logger";

/**
 * (#632) One-shot startup pass: find existing transactions whose
 * description matches the card-payment / transfer patterns added in
 * this task and either (a) aren't yet flagged `isTransfer=true`, or (b)
 * still carry one of the Weekly/Monthly/Unplanned allowance flags. For
 * each, set `isTransfer=true` and zero out the three allowance flags so
 * the row stops contaminating dashboard buckets.
 *
 * (#636) Now also catches rows whose description is bland but whose
 * persisted Plaid `pfc_primary` falls in the transfer set
 * (LOAN_PAYMENTS / TRANSFER_IN / TRANSFER_OUT). PFC is nullable on
 * pre-#636 rows; until they're either synced again or backfilled
 * (#641), the description arm remains the safety net.
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
    // (#636) PFC arm: any persisted pfc_primary in the transfer set
    // counts as a transfer regardless of description text. Built as
    // a parameterized IN list via Drizzle's `sql` template so the
    // upper-cased values stay safely escaped.
    const pfcList = Array.from(TRANSFER_PFC_PRIMARY);
    const pfcMatch =
      pfcList.length > 0
        ? sql`upper(${transactionsTable.pfcPrimary}) in (${sql.join(
            pfcList.map((v) => sql`${v}`),
            sql`, `,
          )})`
        : null;
    const matchAny = pfcMatch
      ? or(...descConds, pfcMatch)
      : or(...descConds);
    if (!matchAny) {
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
          matchAny,
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
