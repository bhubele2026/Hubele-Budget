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
 *   - (WP5d) Never files a row against its money's direction: a rule that
 *     would put money in under an expense category (a paycheck under
 *     Dining), or money out under an income one, is skipped and counted —
 *     the same guard the sync's insert-time fill applies.
 *
 * Run from the repo root:
 *   pnpm --filter @workspace/scripts exec tsx ./src/reapplyCategories.ts          # dry-run (just counts)
 *   pnpm --filter @workspace/scripts exec tsx ./src/reapplyCategories.ts --apply  # write the changes
 */
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import {
  db,
  pool,
  householdsTable,
  plaidAccountsTable,
  transactionsTable,
} from "@workspace/db";
import {
  categorize,
  directionGuard,
  loadRuleContext,
} from "../../artifacts/api-server/src/lib/autoCategorize";

function argValue(flag: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  // Optional date window (inclusive). Pass --from=YYYY-MM-DD --to=YYYY-MM-DD
  // to ONLY recover a specific span (e.g. just May–June). Omit to scan all.
  const from = argValue("--from");
  const to = argValue("--to");
  if (from || to) {
    console.log(`Window: ${from ?? "(start)"} → ${to ?? "(today)"}`);
  } else {
    console.log("Window: ALL dates (pass --from/--to to limit)");
  }

  const households = await db.select().from(householdsTable);
  if (households.length === 0) {
    console.log("No households found — nothing to do.");
    await pool.end();
    return;
  }

  let totalScanned = 0;
  let totalMatched = 0;
  let totalConflicts = 0;

  for (const h of households) {
    const ruleCtx = await loadRuleContext(h.id);
    const rules = ruleCtx.rules;
    const accountTypes = new Map(
      (
        await db
          .select({ accountId: plaidAccountsTable.accountId, type: plaidAccountsTable.type })
          .from(plaidAccountsTable)
          .where(eq(plaidAccountsTable.householdId, h.id))
      ).map((a) => [a.accountId, a.type]),
    );
    const rows = await db
      .select({
        id: transactionsTable.id,
        description: transactionsTable.description,
        amount: transactionsTable.amount,
        source: transactionsTable.source,
        plaidAccountId: transactionsTable.plaidAccountId,
        pfcPrimary: transactionsTable.pfcPrimary,
        pfcDetailed: transactionsTable.pfcDetailed,
        isTransfer: transactionsTable.isTransfer,
        debtId: transactionsTable.debtId,
        isExternalCardPayment: transactionsTable.isExternalCardPayment,
        reimbursable: transactionsTable.reimbursable,
      })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, h.id),
          isNull(transactionsTable.categoryId),
          ...(from ? [gte(transactionsTable.occurredOn, from)] : []),
          ...(to ? [lte(transactionsTable.occurredOn, to)] : []),
        ),
      );

    totalScanned += rows.length;
    let matched = 0;
    let conflicts = 0;

    for (const row of rows) {
      const result = categorize(
        { description: row.description ?? "", pfcPrimary: row.pfcPrimary, pfcDetailed: row.pfcDetailed },
        rules,
        directionGuard(ruleCtx, {
          amount: row.amount,
          source: row.source,
          accountType: row.plaidAccountId ? accountTypes.get(row.plaidAccountId) ?? null : null,
          isTransfer: row.isTransfer,
          debtId: row.debtId,
          isExternalCardPayment: row.isExternalCardPayment,
          reimbursable: row.reimbursable,
        }),
      );
      if (result.directionConflict) {
        conflicts++;
        continue;
      }
      const categoryId = result.categoryId;
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
    totalConflicts += conflicts;
    console.log(
      `Household ${h.id}: ${rows.length} uncategorized · ${matched} match a rule${
        apply ? " (applied)" : ""
      } · ${conflicts} skipped (the rule would file them against the money's direction) · ${rules.length} rules loaded`,
    );
  }
  if (totalConflicts > 0) {
    console.log(
      `${totalConflicts} rows were left uncategorized because the matching rule would file money in ` +
        `under an expense category (or money out under an income one). Review them by hand.`,
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
