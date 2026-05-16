import { and, eq, gte, like, lt, ne, or, sql, inArray } from "drizzle-orm";
import { db, forecastResolutionsTable, transactionsTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * (#679) Hard-delete the 75 duplicate plaid:chase rows that Plaid
 * back-filled into the target household after the 2026-05-16 Chase
 * re-link. Task #676's sweep only flagged these rows
 * (`unplanned_allowance=true, reviewed=true`); it did not delete
 * them. The Chase inbox view displays every un-matched plaid:chase
 * row regardless of those flags, so the user's inbox still showed
 * "77 pending" and the May spend total was inflated to ~$44k.
 *
 * Target predicate (must match exactly 75 rows in prod at the time
 * of writing — anything materially higher trips the safety abort):
 *   household_id = a7182af8-49f0-48f3-920e-f916c7eab872
 *   AND source   = 'plaid:chase'
 *   AND occurred_on >= 2026-05-01 AND occurred_on < 2026-06-01
 *   AND occurred_on <  2026-05-16   (preserves today's 2 real pendings)
 *   AND (notes IS NULL OR notes <> '[pending]')   (also preserves pendings)
 *   AND NOT EXISTS (forecast_resolutions.matched_txn_id = t.id)   (preserves 1 matched row)
 *
 * Idempotent via the predicate — after the first successful run zero
 * rows match, so subsequent boots short-circuit with
 * `reason:"already_converged"`. Single db.transaction so a partial
 * delete cannot happen. Best-effort: never crashes boot.
 *
 * Safety belt: if the preflight finds more than SAFETY_MAX rows,
 * abort the transaction without deleting and log loudly. DELETE is
 * irreversible — if the predicate ever broadens unexpectedly we
 * want to fail loud, not nuke data.
 */
const TARGET_HOUSEHOLD_ID = "a7182af8-49f0-48f3-920e-f916c7eab872";
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
        eq(transactionsTable.source, "plaid:chase"),
        gte(transactionsTable.occurredOn, MAY_2026_START),
        lt(transactionsTable.occurredOn, JUNE_2026_START),
        lt(transactionsTable.occurredOn, PRESERVE_FROM),
        or(
          sql`${transactionsTable.notes} IS NULL`,
          ne(transactionsTable.notes, "[pending]"),
        ),
        sql`NOT EXISTS (SELECT 1 FROM ${forecastResolutionsTable} fr WHERE fr.matched_txn_id = ${transactionsTable.id})`,
      );

      const [{ n: toDelete }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(transactionsTable)
        .where(targetWhere);

      // Preserved counts so the operator log line is self-explanatory.
      const [{ n: preservedToday }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.householdId, TARGET_HOUSEHOLD_ID),
            eq(transactionsTable.source, "plaid:chase"),
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
            eq(transactionsTable.source, "plaid:chase"),
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
            eq(transactionsTable.source, "plaid:chase"),
            gte(transactionsTable.occurredOn, MAY_2026_START),
            lt(transactionsTable.occurredOn, PRESERVE_FROM),
            eq(transactionsTable.notes, "[pending]"),
          ),
        );

      logger.info(
        {
          householdId: TARGET_HOUSEHOLD_ID,
          toDelete,
          preservedToday,
          preservedMatched,
          preservedPendingOther,
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
            toDelete,
            safetyMax: SAFETY_MAX,
          },
          "[startup-may-2026-chase-delete] safety abort: preflight count exceeds SAFETY_MAX, refusing to delete",
        );
        return {
          ran: false,
          to_delete: toDelete,
          deleted: 0,
          preserved_today: preservedToday,
          preserved_matched: preservedMatched,
          preserved_pending_other: preservedPendingOther,
          reason: "safety_abort_over_max",
        };
      }

      // Capture the target ids first so we can log them AND defensively
      // prune any forecast_resolutions pointing at them (the targetWhere
      // already filters those out, so this is belt-and-suspenders in
      // case a race writes a match between this select and the delete).
      const targets = await tx
        .select({ id: transactionsTable.id })
        .from(transactionsTable)
        .where(targetWhere);
      const targetIds = targets.map((r) => r.id);

      if (targetIds.length > 0) {
        await tx
          .delete(forecastResolutionsTable)
          .where(inArray(forecastResolutionsTable.matchedTxnId, targetIds));
      }

      const deleted = await tx
        .delete(transactionsTable)
        .where(inArray(transactionsTable.id, targetIds))
        .returning({ id: transactionsTable.id });

      logger.info(
        {
          householdId: TARGET_HOUSEHOLD_ID,
          toDelete,
          deleted: deleted.length,
          preservedToday,
          preservedMatched,
          preservedPendingOther,
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
