import { and, eq, gte, inArray, lt, ne, or, sql } from "drizzle-orm";
import { db, forecastResolutionsTable, transactionsTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * (#679) Hard-delete the 75 duplicated `plaid:chase` May-2026 rows that
 * Plaid back-filled into the target household after the user re-linked
 * Chase on 2026-05-16. Task #676 only flagged these rows
 * (`unplanned_allowance=true, reviewed=true`), but the Chase inbox shows
 * every un-matched `plaid:chase` row regardless of those flags AND the
 * May spend total was inflated to $44,046.91 vs the planned $14,362.34.
 * The user has said they will decommission the app if a third publish
 * ships with these duplicates still present, so this helper deletes them.
 *
 * Preserves:
 *   - the 2 real pending rows from today (occurred_on = 2026-05-16)
 *   - any row currently marked `[pending]` in notes
 *   - the 1 row already attached to a forecast_resolutions match
 *
 * Idempotent — the predicate self-converges to zero on subsequent boots,
 * same pattern as Task #678. Safety abort if preflight > SAFETY_MAX (75
 * real; anything meaningfully higher means the predicate matched
 * something unexpected and we want to fail loud, not nuke data).
 *
 * Runs inside a single `db.transaction` so a partial delete cannot
 * happen. Best-effort: never crashes boot. The helper file can be
 * deleted in a follow-up cleanup task once the user confirms the inbox
 * and May spend total are correct in prod.
 */
const TARGET_HOUSEHOLD_ID = "a7182af8-49f0-48f3-920e-f916c7eab872";
const TARGET_SOURCE = "plaid:chase";
const MAY_2026_START = "2026-05-01";
const JUNE_2026_START = "2026-06-01";
const PRESERVE_FROM = "2026-05-16";
const SAFETY_MAX = 200;

export async function runStartupMay2026ChaseDelete(): Promise<{
  ran: boolean;
  to_delete: number;
  deleted: number;
  preserved_today: number;
  preserved_matched: number;
  preserved_pending_other: number;
  reason?: string;
}> {
  try {
    return await db.transaction(async (tx) => {
      const targetWhere = and(
        eq(transactionsTable.householdId, TARGET_HOUSEHOLD_ID),
        eq(transactionsTable.source, TARGET_SOURCE),
        gte(transactionsTable.occurredOn, MAY_2026_START),
        lt(transactionsTable.occurredOn, JUNE_2026_START),
        lt(transactionsTable.occurredOn, PRESERVE_FROM),
        or(
          sql`${transactionsTable.notes} IS NULL`,
          ne(transactionsTable.notes, "[pending]"),
        ),
        sql`NOT EXISTS (SELECT 1 FROM ${forecastResolutionsTable} fr WHERE fr.matched_txn_id = ${transactionsTable.id})`,
      );

      // Snapshot the target ids once. We then drive both the defensive
      // forecast_resolutions prune and the transaction delete off this
      // immutable id list so that re-evaluating `targetWhere` after the
      // prune (which removes matches and would otherwise expand the
      // NOT EXISTS clause's match set) cannot enlarge the delete scope.
      const targetRows = await tx
        .select({ id: transactionsTable.id })
        .from(transactionsTable)
        .where(targetWhere);
      const targetIds = targetRows.map((r) => r.id);
      const toDelete = targetIds.length;

      const [{ n: preservedToday }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.householdId, TARGET_HOUSEHOLD_ID),
            eq(transactionsTable.source, TARGET_SOURCE),
            gte(transactionsTable.occurredOn, PRESERVE_FROM),
            lt(transactionsTable.occurredOn, JUNE_2026_START),
          ),
        );

      const [{ n: preservedMatched }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.householdId, TARGET_HOUSEHOLD_ID),
            eq(transactionsTable.source, TARGET_SOURCE),
            gte(transactionsTable.occurredOn, MAY_2026_START),
            lt(transactionsTable.occurredOn, JUNE_2026_START),
            sql`EXISTS (SELECT 1 FROM ${forecastResolutionsTable} fr WHERE fr.matched_txn_id = ${transactionsTable.id})`,
          ),
        );

      const [{ n: preservedPendingOther }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.householdId, TARGET_HOUSEHOLD_ID),
            eq(transactionsTable.source, TARGET_SOURCE),
            gte(transactionsTable.occurredOn, MAY_2026_START),
            lt(transactionsTable.occurredOn, PRESERVE_FROM),
            eq(transactionsTable.notes, "[pending]"),
          ),
        );

      logger.info(
        {
          householdId: TARGET_HOUSEHOLD_ID,
          to_delete: toDelete,
          preserved_today: preservedToday,
          preserved_matched: preservedMatched,
          preserved_pending_other: preservedPendingOther,
        },
        "[startup-may-2026-chase-delete] preflight counts",
      );

      if (toDelete === 0) {
        return {
          ran: true,
          to_delete: 0,
          deleted: 0,
          preserved_today: preservedToday,
          preserved_matched: preservedMatched,
          preserved_pending_other: preservedPendingOther,
          reason: "already_converged",
        };
      }

      if (toDelete > SAFETY_MAX) {
        logger.error(
          {
            householdId: TARGET_HOUSEHOLD_ID,
            to_delete: toDelete,
            safety_max: SAFETY_MAX,
          },
          "[startup-may-2026-chase-delete] preflight exceeds safety limit; aborting without delete",
        );
        return {
          ran: false,
          to_delete: toDelete,
          deleted: 0,
          preserved_today: preservedToday,
          preserved_matched: preservedMatched,
          preserved_pending_other: preservedPendingOther,
          reason: "safety_abort",
        };
      }

      // Best-effort defensive prune of orphan forecast_resolutions whose
      // matched_txn_id points at a row we're about to delete. Scoped
      // strictly to the snapshotted target id list so we cannot strip
      // a match off a row that the preflight intended to preserve.
      // Given the NOT EXISTS filter above this should never match, but
      // a race that writes a match between snapshot and delete would
      // leave a dangling pointer otherwise.
      await tx
        .delete(forecastResolutionsTable)
        .where(inArray(forecastResolutionsTable.matchedTxnId, targetIds));

      // Delete strictly by the snapshotted id list — NOT by re-evaluating
      // targetWhere — so the prune above cannot expand the delete scope.
      const deleted = await tx
        .delete(transactionsTable)
        .where(inArray(transactionsTable.id, targetIds))
        .returning({ id: transactionsTable.id });

      if (deleted.length !== toDelete) {
        logger.error(
          {
            householdId: TARGET_HOUSEHOLD_ID,
            to_delete: toDelete,
            deleted: deleted.length,
          },
          "[startup-may-2026-chase-delete] scope drift: deleted count does not match preflight",
        );
      }

      logger.info(
        {
          householdId: TARGET_HOUSEHOLD_ID,
          to_delete: toDelete,
          deleted: deleted.length,
          ids: deleted.map((r) => r.id),
        },
        "[startup-may-2026-chase-delete] deleted_rows",
      );

      return {
        ran: true,
        to_delete: toDelete,
        deleted: deleted.length,
        preserved_today: preservedToday,
        preserved_matched: preservedMatched,
        preserved_pending_other: preservedPendingOther,
      };
    });
  } catch (err) {
    logger.error({ err }, "Startup May-2026 chase delete failed");
    return {
      ran: false,
      to_delete: 0,
      deleted: 0,
      preserved_today: 0,
      preserved_matched: 0,
      preserved_pending_other: 0,
      reason: "error",
    };
  }
}
