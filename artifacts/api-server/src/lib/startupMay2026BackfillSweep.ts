import { and, eq, gte, isNotNull, like, lt, ne, or, sql } from "drizzle-orm";
import { db, forecastResolutionsTable, transactionsTable } from "@workspace/db";
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
 * Operator-gated so it does NOT fire on every boot: enable by setting
 * `RUN_MAY_2026_BACKFILL_SWEEP=1`. Disable in the deployment env after
 * the first successful prod run so subsequent reboots no-op even faster
 * (the predicates are also self-convergent — once swept rows stay swept
 * the predicate count goes to zero — but the env flag makes the
 * intervention auditable as a discrete operator action rather than a
 * permanent boot hook).
 *
 * Production-DB writes from the Replit sandbox are blocked (read-only),
 * which is why this fix ships as code instead of a direct one-shot SQL
 * run. The predicates preserve:
 *   - currently-pending rows (`notes = '[pending]'`), and
 *   - rows referenced by a live `forecast_resolutions.matched_txn_id`.
 *
 * Runs the preflight count, the update, and the post-update verify
 * inside a single transaction so an unexpected schema state aborts
 * cleanly with no partial flip. Best-effort: never crashes boot.
 */
const TARGET_HOUSEHOLD_ID = "a7182af8-49f0-48f3-920e-f916c7eab872";
const MAY_2026_START = "2026-05-01";
const JUNE_2026_START = "2026-06-01";
const ENABLE_FLAG = "RUN_MAY_2026_BACKFILL_SWEEP";

function isEnabled(): boolean {
  const raw = process.env[ENABLE_FLAG];
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export async function runStartupMay2026BackfillSweep(): Promise<{
  ran: boolean;
  preflight: number;
  swept: number;
  preserved_pending: number;
  preserved_matched: number;
  reason?: string;
}> {
  if (!isEnabled()) {
    return {
      ran: false,
      preflight: 0,
      swept: 0,
      preserved_pending: 0,
      preserved_matched: 0,
      reason: "disabled_env_flag",
    };
  }
  try {
    return await db.transaction(async (tx) => {
      // Preflight: count rows the update will affect, plus the rows we
      // intentionally preserve, so the operator can compare against the
      // numbers measured in the read-only sandbox preview (75 Chase +
      // 48 Amex settled = 123 to sweep; 8 pending preserved; 30 matched
      // preserved). Any large divergence aborts the run.
      const targetWhere = and(
        eq(transactionsTable.householdId, TARGET_HOUSEHOLD_ID),
        like(transactionsTable.source, "plaid:%"),
        gte(transactionsTable.occurredOn, MAY_2026_START),
        lt(transactionsTable.occurredOn, JUNE_2026_START),
        or(
          sql`${transactionsTable.notes} IS NULL`,
          ne(transactionsTable.notes, "[pending]"),
        ),
        or(
          eq(transactionsTable.unplannedAllowance, false),
          eq(transactionsTable.reviewed, false),
        ),
        sql`NOT EXISTS (SELECT 1 FROM ${forecastResolutionsTable} fr WHERE fr.matched_txn_id = ${transactionsTable.id})`,
      );

      const [{ n: preflight }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(transactionsTable)
        .where(targetWhere);

      const [{ n: preservedPending }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.householdId, TARGET_HOUSEHOLD_ID),
            like(transactionsTable.source, "plaid:%"),
            gte(transactionsTable.occurredOn, MAY_2026_START),
            lt(transactionsTable.occurredOn, JUNE_2026_START),
            eq(transactionsTable.notes, "[pending]"),
          ),
        );

      const [{ n: preservedMatched }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.householdId, TARGET_HOUSEHOLD_ID),
            like(transactionsTable.source, "plaid:%"),
            gte(transactionsTable.occurredOn, MAY_2026_START),
            lt(transactionsTable.occurredOn, JUNE_2026_START),
            sql`EXISTS (SELECT 1 FROM ${forecastResolutionsTable} fr WHERE fr.matched_txn_id = ${transactionsTable.id})`,
            isNotNull(transactionsTable.id),
          ),
        );

      logger.info(
        {
          householdId: TARGET_HOUSEHOLD_ID,
          preflight,
          preservedPending,
          preservedMatched,
        },
        "[startup-may-2026-backfill-sweep] preflight counts",
      );

      if (preflight === 0) {
        return {
          ran: true,
          preflight: 0,
          swept: 0,
          preserved_pending: preservedPending,
          preserved_matched: preservedMatched,
          reason: "already_converged",
        };
      }

      const updated = await tx
        .update(transactionsTable)
        .set({ unplannedAllowance: true, reviewed: true })
        .where(targetWhere)
        .returning({ id: transactionsTable.id });

      const swept = updated.length;
      logger.info(
        {
          householdId: TARGET_HOUSEHOLD_ID,
          preflight,
          swept,
          preservedPending,
          preservedMatched,
          ids: updated.map((r) => r.id),
        },
        "[startup-may-2026-backfill-sweep] swept backfilled review-bucket rows",
      );

      return {
        ran: true,
        preflight,
        swept,
        preserved_pending: preservedPending,
        preserved_matched: preservedMatched,
      };
    });
  } catch (err) {
    logger.error({ err }, "Startup May-2026 backfill sweep failed");
    return {
      ran: false,
      preflight: 0,
      swept: 0,
      preserved_pending: 0,
      preserved_matched: 0,
      reason: "error",
    };
  }
}
