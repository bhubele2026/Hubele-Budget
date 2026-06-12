/**
 * RECOVERY TOOL — re-apply the household's mapping rules to every
 * UN-categorized transaction.
 *
 * Built after a card re-sync wiped categorizations. Your mapping rules
 * (everything the app "remembered" when you categorized) survived, so this
 * walks every transaction whose category is now blank and re-applies the
 * matching rule's category.
 *
 * SAFE / non-destructive:
 *   - Only touches rows where category_id IS NULL. Never overwrites a
 *     category that's still set.
 *   - Dry-run by default: prints how many WOULD be recovered and writes
 *     nothing. Add --apply to actually write.
 *
 * Run from the repo root:
 *   pnpm --filter @workspace/scripts exec tsx ./src/reapplyCategories.ts          # dry-run (just counts)
 *   pnpm --filter @workspace/scripts exec tsx ./src/reapplyCategories.ts --apply  # write the changes
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  pool,
  householdsTable,
  transactionsTable,
} from "@workspace/db";
import {
  loadUserRules,
  matchRule,
} from "../../artifacts/api-server/src/lib/autoCategorize";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const households = await db.select().from(householdsTable);
  if (households.length === 0) {
    console.log("No households found — nothing to do.");
    await pool.end();
    return;
  }

  let totalScanned = 0;
  let totalMatched = 0;

  for (const h of households) {
    const rules = await loadUserRules(h.id);
    const rows = await db
      .select({
        id: transactionsTable.id,
        description: transactionsTable.description,
      })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, h.id),
          isNull(transactionsTable.categoryId),
        ),
      );

    totalScanned += rows.length;
    let matched = 0;

    for (const row of rows) {
      const categoryId = matchRule(row.description ?? "", rules);
      if (!categoryId) continue;
      matched++;
      if (apply) {
        await db
          .update(transactionsTable)
          .set({ categoryId })
          .where(eq(transactionsTable.id, row.id));
      }
    }

    totalMatched += matched;
    console.log(
      `Household ${h.id}: ${rows.length} uncategorized · ${matched} match a rule${
        apply ? " (applied)" : ""
      } · ${rules.length} rules loaded`,
    );
  }

  console.log(
    `\n${apply ? "APPLIED" : "DRY-RUN"}: ${totalMatched} of ${totalScanned} ` +
      `uncategorized transactions matched one of your mapping rules.`,
  );
  if (!apply && totalMatched > 0) {
    console.log("Re-run with  --apply  to write these categories back.");
  }
  if (totalMatched < totalScanned) {
    console.log(
      `${totalScanned - totalMatched} transactions had no matching rule — ` +
        `those were likely categorized by hand and need either a DB restore ` +
        `or a quick manual pass.`,
    );
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
