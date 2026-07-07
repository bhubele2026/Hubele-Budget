// Nightly sweep: compute + upsert today's budget-health row for every
// household, so the daily trend fills in even for households that never open
// the app. Independent of Plaid (no billable calls) — safe to run every day.

import { db, householdsTable } from "@workspace/db";
import { upsertTodayHealth } from "./healthSnapshot";
import { logger } from "./logger";

export async function runDailyHealthSnapshots(): Promise<{
  scanned: number;
  ok: number;
  failed: number;
}> {
  let scanned = 0;
  let ok = 0;
  let failed = 0;
  const households = await db
    .select({ id: householdsTable.id, ownerUserId: householdsTable.ownerUserId })
    .from(householdsTable);
  for (const h of households) {
    scanned += 1;
    if (!h.ownerUserId) {
      failed += 1;
      continue;
    }
    try {
      await upsertTodayHealth(h.id, h.ownerUserId);
      ok += 1;
    } catch (err) {
      failed += 1;
      logger.warn({ err, householdId: h.id }, "daily health snapshot failed for household");
    }
  }
  return { scanned, ok, failed };
}
