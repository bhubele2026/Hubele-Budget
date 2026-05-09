import { and, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { avalancheSettingsTable, db } from "@workspace/db";
import { logger } from "./logger";

/**
 * One-shot startup pass: revert users that the (now-removed)
 * `healAvalancheDuplication` routine auto-migrated from
 * `extra_source='manual'` to `extra_source='budget_line'` between the
 * deploy of commit ed23a30 and the revert. That heal turned out to
 * hide the manual-extra slider on the Avalanche page and zero out the
 * "Avalanche — Extra to Highest APR" group on the Budget page for the
 * affected user, because the linked category lives under a different
 * group.
 *
 * Targets only rows whose `updated_at` falls inside the bad heal's
 * window, so any user who legitimately switched to budget_line mode
 * themselves (before or after the window) is left untouched. The flip
 * back to manual restores the slider and lets
 * `syncAvalanchePaymentCategory` re-create the standalone
 * "Avalanche payment" budget line on the next budget GET, mirroring
 * `manualExtra`.
 *
 * Best-effort: errors are logged, never thrown; never blocks boot.
 */
const HEAL_WINDOW_START = new Date("2026-05-08T23:00:00.000Z");
const HEAL_WINDOW_END = new Date("2026-05-09T03:00:00.000Z");

export async function runStartupAvalancheHealRevert(): Promise<{
  scanned: number;
  reverted: number;
  failed: number;
}> {
  const summary = { scanned: 0, reverted: 0, failed: 0 };
  try {
    const candidates = await db
      .select({
        userId: avalancheSettingsTable.userId,
        extraBudgetCategoryId:
          avalancheSettingsTable.extraBudgetCategoryId,
        manualExtra: avalancheSettingsTable.manualExtra,
        updatedAt: avalancheSettingsTable.updatedAt,
      })
      .from(avalancheSettingsTable)
      .where(
        and(
          eq(avalancheSettingsTable.extraSource, "budget_line"),
          isNotNull(avalancheSettingsTable.extraBudgetCategoryId),
          gte(avalancheSettingsTable.updatedAt, HEAL_WINDOW_START),
          lte(avalancheSettingsTable.updatedAt, HEAL_WINDOW_END),
        ),
      );

    summary.scanned = candidates.length;
    if (candidates.length === 0) return summary;

    for (const row of candidates) {
      try {
        await db
          .update(avalancheSettingsTable)
          .set({
            extraSource: "manual",
            extraBudgetCategoryId: null,
            updatedAt: sql`NOW()`,
          })
          .where(eq(avalancheSettingsTable.userId, row.userId));
        summary.reverted += 1;
        logger.info(
          {
            userId: row.userId,
            previousLinkedCategoryId: row.extraBudgetCategoryId,
            manualExtra: row.manualExtra,
          },
          "Startup avalanche-heal revert: restored manual mode",
        );
      } catch (err) {
        summary.failed += 1;
        logger.error(
          { err, userId: row.userId },
          "Startup avalanche-heal revert: failed to restore user",
        );
      }
    }
  } catch (err) {
    logger.error(
      { err },
      "Startup avalanche-heal revert: failed to enumerate candidates",
    );
  }
  return summary;
}
