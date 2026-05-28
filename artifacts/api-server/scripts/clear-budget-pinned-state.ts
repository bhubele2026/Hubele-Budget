/**
 * (#777) Clear all `pinned = true` flags on a single household so budget
 * amounts derive purely from the live Bills/Debts pipeline again.
 *
 * Background: the May 2026 auto-pin migration (task #115) pinned both the
 * month (`budget_months.pinned`) and many per-line rows (`budget_lines.pinned`),
 * and because the response builder treats the month flag as an override,
 * individual lines cannot be unpinned from the UI. This script wipes both
 * flags for one household and confirms the
 * `settings.preferences.budgetMay2026AmountsV1` gate is set so the
 * `reconcileMay2026Amounts` migration won't silently re-pin anything later.
 *
 * Scope: ONE household only. Other households are not touched. No
 * `budget_lines` rows are deleted; only the `pinned` boolean flips
 * true -> false. `plannedAmount`, `note`, and every other column are
 * preserved.
 *
 * Dry-run is the default. Pass `--apply` to actually write.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server exec tsx scripts/clear-budget-pinned-state.ts --household=<HH_ID>
 *   pnpm --filter @workspace/api-server exec tsx scripts/clear-budget-pinned-state.ts --household=<HH_ID> --apply
 *
 * Point DATABASE_URL at whichever environment you want to operate on.
 */

import { and, eq, sql } from "drizzle-orm";
import {
  db,
  budgetLinesTable,
  budgetMonthsTable,
  householdsTable,
  settingsTable,
} from "@workspace/db";

const APPLY = process.argv.includes("--apply");
const hhArg = process.argv.find((a) => a.startsWith("--household="));
const HOUSEHOLD_ID = hhArg ? hhArg.slice("--household=".length) : "";

if (!HOUSEHOLD_ID) {
  console.error(
    "[clear-budget-pinned-state] missing --household=<id>; refusing to run.",
  );
  process.exit(2);
}

async function run(): Promise<void> {
  const [hh] = await db
    .select()
    .from(householdsTable)
    .where(eq(householdsTable.id, HOUSEHOLD_ID));
  if (!hh) {
    console.error(
      `[clear-budget-pinned-state] household ${HOUSEHOLD_ID} not found.`,
    );
    process.exit(2);
  }
  const ownerId = hh.ownerUserId;

  console.log(
    `[clear-budget-pinned-state] mode=${APPLY ? "APPLY" : "DRY-RUN"} household=${HOUSEHOLD_ID} owner=${ownerId}`,
  );
  console.log(
    "[clear-budget-pinned-state] NOTE: no rows are deleted. Only the `pinned` flag flips true -> false; plannedAmount and all other columns are preserved.",
  );

  // ---- Dry-run report --------------------------------------------------
  const pinnedLines = await db
    .select({
      monthStart: budgetLinesTable.monthStart,
      cnt: sql<string>`count(*)::text`,
    })
    .from(budgetLinesTable)
    .where(
      and(
        eq(budgetLinesTable.householdId, HOUSEHOLD_ID),
        eq(budgetLinesTable.pinned, true),
      ),
    )
    .groupBy(budgetLinesTable.monthStart)
    .orderBy(budgetLinesTable.monthStart);
  const totalPinnedLines = pinnedLines.reduce(
    (a, r) => a + (parseInt(r.cnt, 10) || 0),
    0,
  );

  const pinnedMonths = await db
    .select({ monthStart: budgetMonthsTable.monthStart })
    .from(budgetMonthsTable)
    .where(
      and(
        eq(budgetMonthsTable.householdId, HOUSEHOLD_ID),
        eq(budgetMonthsTable.pinned, true),
      ),
    )
    .orderBy(budgetMonthsTable.monthStart);

  const [s] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.userId, ownerId));
  const prefs = (s?.preferences as Record<string, unknown> | null) ?? null;
  const gateFlag = prefs?.budgetMay2026AmountsV1 === true;

  console.log("[clear-budget-pinned-state] budget_lines pinned, by monthStart:");
  if (pinnedLines.length === 0) {
    console.log("  (none)");
  } else {
    for (const r of pinnedLines) {
      console.log(`  ${r.monthStart}  ${r.cnt}`);
    }
    console.log(`  TOTAL: ${totalPinnedLines}`);
  }
  console.log(
    `[clear-budget-pinned-state] budget_months pinned: ${pinnedMonths.length}${
      pinnedMonths.length > 0
        ? " (" + pinnedMonths.map((m) => m.monthStart).join(", ") + ")"
        : ""
    }`,
  );
  console.log(
    `[clear-budget-pinned-state] settings.preferences.budgetMay2026AmountsV1 = ${gateFlag} (gate ${gateFlag ? "ALREADY SET — reconcileMay2026Amounts will early-return" : "NOT SET — script will set it"})`,
  );

  if (!APPLY) {
    console.log(
      "[clear-budget-pinned-state] DRY-RUN complete. Re-run with --apply to write.",
    );
    return;
  }

  // ---- Apply -----------------------------------------------------------
  await db.transaction(async (tx) => {
    const linesRes = await tx
      .update(budgetLinesTable)
      .set({ pinned: false })
      .where(
        and(
          eq(budgetLinesTable.householdId, HOUSEHOLD_ID),
          eq(budgetLinesTable.pinned, true),
        ),
      )
      .returning({ id: budgetLinesTable.id });

    const monthsRes = await tx
      .update(budgetMonthsTable)
      .set({ pinned: false })
      .where(
        and(
          eq(budgetMonthsTable.householdId, HOUSEHOLD_ID),
          eq(budgetMonthsTable.pinned, true),
        ),
      )
      .returning({ monthStart: budgetMonthsTable.monthStart });

    let gateWritten = false;
    if (!gateFlag) {
      const nextPrefs = {
        ...(prefs ?? {}),
        budgetMay2026AmountsV1: true,
      };
      if (s) {
        await tx
          .update(settingsTable)
          .set({ preferences: nextPrefs })
          .where(eq(settingsTable.userId, ownerId));
      } else {
        await tx.insert(settingsTable).values({
          userId: ownerId,
          householdId: HOUSEHOLD_ID,
          preferences: nextPrefs,
        });
      }
      gateWritten = true;
    }

    console.log(
      `[clear-budget-pinned-state] APPLIED  budget_lines.pinned cleared: ${linesRes.length}  budget_months.pinned cleared: ${monthsRes.length}  gate flag written: ${gateWritten}`,
    );
  });

  // ---- Verify ----------------------------------------------------------
  const [{ linesLeft }] = await db
    .select({ linesLeft: sql<string>`count(*)::text` })
    .from(budgetLinesTable)
    .where(
      and(
        eq(budgetLinesTable.householdId, HOUSEHOLD_ID),
        eq(budgetLinesTable.pinned, true),
      ),
    );
  const [{ monthsLeft }] = await db
    .select({ monthsLeft: sql<string>`count(*)::text` })
    .from(budgetMonthsTable)
    .where(
      and(
        eq(budgetMonthsTable.householdId, HOUSEHOLD_ID),
        eq(budgetMonthsTable.pinned, true),
      ),
    );
  console.log(
    `[clear-budget-pinned-state] post-apply verify: pinned_lines_remaining=${linesLeft}  pinned_months_remaining=${monthsLeft}  (both must be 0)`,
  );
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[clear-budget-pinned-state] failed:", err);
    process.exit(1);
  });
