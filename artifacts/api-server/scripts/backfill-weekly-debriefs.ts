/**
 * (#766 — Phase D1) Historical Weekly Debrief backfill.
 *
 * Walks every household and computes a `weekly_debriefs` row for
 * every Sun–Sat week between the household's earliest transaction
 * and the most recent past Saturday. Rows are persisted in
 * `awaiting_review` state with a frozen `varianceSnapshot` so the
 * D2 UI has historical data to render immediately and Phase E has
 * an audit trail to summarize.
 *
 * Dry-run is the default — the script prints the first 3 and last
 * 3 weeks per household with a totals preview. Pass `--apply` to
 * actually upsert. Idempotent on (householdId, weekStart): re-runs
 * recompute and update the snapshot. The script intentionally does
 * NOT touch rows already in `locked` state.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-weekly-debriefs.ts
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-weekly-debriefs.ts --apply
 */

import { and, eq, asc, gt } from "drizzle-orm";
import { db, householdsTable, transactionsTable, weeklyDebriefsTable } from "@workspace/db";
import { computeWeekVariance, summarizeActions, weekEndFor, weekStartFor } from "../src/lib/weeklyDebrief";
import { addDays, fmtISO, parseISO } from "../src/lib/cashSignal";

const APPLY = process.argv.includes("--apply");

async function earliestTxnDate(householdId: string): Promise<string | null> {
  const rows = await db
    .select({ d: transactionsTable.occurredOn })
    .from(transactionsTable)
    .where(eq(transactionsTable.householdId, householdId))
    .orderBy(asc(transactionsTable.occurredOn))
    .limit(1);
  return rows[0]?.d ?? null;
}

function previousSaturday(now: Date): string {
  const ws = weekStartFor(now);
  return fmtISO(addDays(parseISO(ws), -1));
}

async function run(): Promise<void> {
  const now = new Date();
  const lastSat = previousSaturday(now);
  const households = await db.select().from(householdsTable);
  console.log(
    `[backfill-weekly-debriefs] mode=${APPLY ? "APPLY" : "DRY-RUN"} now=${now.toISOString()} lastWeekSat=${lastSat} households=${households.length}`,
  );

  for (const h of households) {
    const first = await earliestTxnDate(h.id);
    if (!first) {
      console.log(`  household=${h.id} — no transactions; skipping`);
      continue;
    }
    const startSun = weekStartFor(first);
    const lastSun = weekStartFor(lastSat); // Sunday of last completed week
    if (startSun > lastSun) {
      console.log(`  household=${h.id} — no past weeks to backfill`);
      continue;
    }
    const weeks: string[] = [];
    let cur = parseISO(startSun);
    const end = parseISO(lastSun);
    while (cur <= end) {
      weeks.push(fmtISO(cur));
      cur = addDays(cur, 7);
    }
    console.log(
      `  household=${h.id} earliestTxn=${first} weeks=${weeks.length} (${weeks[0]}..${weeks[weeks.length - 1]})`,
    );

    const sample = new Set<string>([
      ...weeks.slice(0, 3),
      ...weeks.slice(-3),
    ]);

    // Pull locked rows so we don't overwrite them.
    const locked = new Set(
      (
        await db
          .select({ weekStart: weeklyDebriefsTable.weekStart })
          .from(weeklyDebriefsTable)
          .where(
            and(
              eq(weeklyDebriefsTable.householdId, h.id),
              eq(weeklyDebriefsTable.status, "locked"),
            ),
          )
      ).map((r) => r.weekStart),
    );

    let upserts = 0;
    for (const ws of weeks) {
      if (locked.has(ws)) continue;
      const snap = await computeWeekVariance(h.id, ws, { now });
      if (sample.has(ws)) {
        console.log(
          `    ${ws}..${weekEndFor(ws)}  plans=${snap.plans.length} txns=${snap.transactions.length} netPlanned=${snap.totals.plannedNet} netActual=${snap.totals.actualNet} open=${snap.openItemsCount}`,
        );
      }
      if (!APPLY) continue;
      const actions = summarizeActions(snap);
      const nowTs = new Date();
      await db
        .insert(weeklyDebriefsTable)
        .values({
          householdId: h.id,
          weekStart: ws,
          weekEnd: weekEndFor(ws),
          status: "awaiting_review",
          varianceSnapshot: snap,
          actionsSummary: actions,
          updatedAt: nowTs,
        })
        .onConflictDoUpdate({
          target: [weeklyDebriefsTable.householdId, weeklyDebriefsTable.weekStart],
          set: {
            varianceSnapshot: snap,
            actionsSummary: actions,
            updatedAt: nowTs,
          },
        });
      upserts += 1;
    }
    console.log(
      `  household=${h.id} ${APPLY ? `upserted=${upserts}` : "(dry-run, no writes)"}`,
    );
  }
  // Suppress unused-import lint
  void gt;
  console.log(`[backfill-weekly-debriefs] done.`);
}

run().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
