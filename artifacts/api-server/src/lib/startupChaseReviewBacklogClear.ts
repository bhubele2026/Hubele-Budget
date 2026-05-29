import { and, eq, lte, sql } from "drizzle-orm";
import {
  db,
  forecastResolutionsTable,
  transactionsTable,
} from "@workspace/db";
import { logger } from "./logger";

/**
 * One-shot startup pass: clear the Chase "Review Bucket" backlog for a
 * single household by flipping `forecast_flag = false` on the genuinely
 * stuck, already-categorized rows that have been piling up in the
 * Debrief / Review queue.
 *
 * Why this is needed: after `startupChaseForecastFlagRepair` correctly
 * back-filled `forecast_flag = true` on the household's historical Chase
 * checking rows, ~113 already-categorized transactions landed in the
 * Review Bucket all at once. The user wants a clean slate going forward
 * without reviewing each one. Dropping `forecast_flag` to false removes
 * them from the Debrief / Review pipeline (`forecast.ts` filters on
 * `forecast_flag = true`, L376) while leaving the rows, their
 * categorization, and the budget actuals fully intact — Debrief reads
 * actuals via the category-bucket path, not the forecast_flag gate.
 *
 * The predicate mirrors the awaiting-match counter exactly
 * (`transactions.tsx` L1055-1069): a Chase checking row is "awaiting
 * match" when `forecast_flag = true` and there is NO `forecast_resolutions`
 * row whose `matched_txn_id` points at it with a terminal status of
 * `matched`, `ignored_unforecasted`, or `unplanned`. We additionally
 * require `occurred_on <= today` so future-dated / pending Plaid rows
 * that haven't posted yet are never touched.
 *
 * Safety guard: if the predicate would affect >= 400 rows we bail out
 * with a warn and skip the update — this protects against a bad predicate
 * accidentally zapping thousands of rows.
 *
 * Idempotent: flipped rows no longer match `forecast_flag = true`, and
 * `sentToReviewAt` is intentionally left untouched (the user has been
 * clicking "Review" this morning and that data is meaningful). Future
 * Plaid syncs still insert new rows with `forecast_flag = true`, so the
 * Review pipeline keeps working normally going forward.
 * Best-effort: errors are logged, never thrown, and never block boot.
 */
const HOUSEHOLD_ID = "a7182af8-49f0-48f3-920e-f916c7eab872";
const CHASE_CHECKING_EXTERNAL_ID = "YEvBBznkA3updAzAk7wyILEPd31z6BSQK184R";
const SAFETY_THRESHOLD = 400;

export async function runStartupChaseReviewBacklogClear(): Promise<{
  cleared: number;
}> {
  const summary = { cleared: 0 };
  try {
    // The same "awaiting match" predicate the header chip uses: a Chase
    // checking row that's flagged for review (forecast_flag = true),
    // already occurred (occurred_on <= today), and has NO terminal
    // forecast_resolutions row pointing at it.
    const backlogPredicate = and(
      eq(transactionsTable.householdId, HOUSEHOLD_ID),
      eq(transactionsTable.source, "plaid:chase"),
      eq(transactionsTable.plaidAccountId, CHASE_CHECKING_EXTERNAL_ID),
      eq(transactionsTable.forecastFlag, true),
      lte(transactionsTable.occurredOn, sql`CURRENT_DATE`),
      sql`NOT EXISTS (
        SELECT 1 FROM ${forecastResolutionsTable}
        WHERE ${forecastResolutionsTable.matchedTxnId} = ${transactionsTable.id}
          AND ${forecastResolutionsTable.status} IN ('matched', 'ignored_unforecasted', 'unplanned')
      )`,
    );

    // Safety guard: count first, bail if the predicate is too broad.
    const countRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(transactionsTable)
      .where(backlogPredicate);
    const wouldClear = countRows[0]?.count ?? 0;

    if (wouldClear >= SAFETY_THRESHOLD) {
      logger.warn(
        {
          householdId: HOUSEHOLD_ID,
          wouldClear,
          threshold: SAFETY_THRESHOLD,
        },
        "Startup Chase review-backlog clear: would clear too many rows, skipping update (safety threshold exceeded)",
      );
      return summary;
    }

    if (wouldClear === 0) {
      return summary;
    }

    const result = await db
      .update(transactionsTable)
      .set({ forecastFlag: false })
      .where(backlogPredicate)
      .returning({ id: transactionsTable.id });

    summary.cleared = result.length;
    if (summary.cleared > 0) {
      logger.info(
        { householdId: HOUSEHOLD_ID, cleared: summary.cleared },
        "Startup Chase review-backlog clear: flipped forecast_flag to false on stuck backlog rows",
      );
    }
  } catch (err) {
    logger.error({ err }, "Startup Chase review-backlog clear failed");
  }
  return summary;
}
