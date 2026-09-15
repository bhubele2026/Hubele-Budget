// ⭐ (PR-I, owner decision 14) REVIEWED DOES NOT FREEZE BANK STATUS — AND THE
// REVIEW WORK IS NOT LOST WHEN THE BANK RE-ISSUES A ROW.
//
// A pending→posted re-key (`pending_transaction_id`) already keeps the review
// work on the same row. When Plaid instead posts the charge under a NEW id —
// no link, and an amount or date the re-mint cannot adopt (a tip, a hold that
// posts higher) — sync inserts the posted row bare: unreviewed, the rules'
// category, no allowance flags. The pending row someone worked on stays behind
// (and is marked `bank_removed` once Plaid removes it: `bankRemoved.ts`).
//
// `carryReviewToReplacements` gives that posted row what the household put on
// the pending row it replaced. PR-D already reads the filing this way at read
// time (`effectiveFiling`); this writes it, with `reviewed`, so the Chase and Amex
// pages show the work too.

import { and, eq, inArray } from "drizzle-orm";
import { db, budgetCategoriesTable, transactionsTable } from "@workspace/db";
import { effectiveFiling, uncategorizedCategoryIds } from "./pendingFiling";
import { findSupersededPendingForRange } from "./supersededPending";

/**
 * ⭐ CARRY REVIEW WORK TO A REPLACEMENT THAT ARRIVED UNDER A NEW ID.
 *
 * `insertedIds`: rows the calling sync INSERTED. Each that is posted and replaced
 * a pending row — `findSupersededPendingForRange`, the pairing the cash rule,
 * Spending and Budget already read — takes what the household put on that
 * pending row:
 *   - `reviewed`, when the pending row was reviewed;
 *   - the filing `effectiveFiling` gives it at read time (PR-D): the category (a
 *     hand filing beats the rules' category), the allowance flags and slice,
 *     reimbursable, the debt tag, a person-set transfer flag;
 *   - `isTransferUserOverridden`, only alongside a category or transfer flag
 *     taken from a pending row whose own flag a person set — dedupe's merge
 *     carries it the same way — so the carried hand filing still reads as one.
 *
 * ⚠️ ONLY ONTO A ROW THE SAME SYNC INSERTED. Its values are the ones sync gave it,
 * so there is no choice of the household's on it to overwrite, and a later sync
 * never carries again: a posted row the household un-reviews stays un-reviewed.
 * Returns how many rows took something.
 */
export async function carryReviewToReplacements(
  householdId: string,
  insertedIds: readonly string[],
): Promise<number> {
  const ids = [...new Set(insertedIds)];
  if (ids.length === 0) return 0;
  return db.transaction(async (tx) => {
    const posted = await tx
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, householdId),
          inArray(transactionsTable.id, ids),
          eq(transactionsTable.pending, false),
        ),
      )
      .for("update");
    if (posted.length === 0) return 0;
    const days = posted.map((p) => p.occurredOn).sort();
    const supersede = await findSupersededPendingForRange(householdId, days[0]!, days[days.length - 1]!, tx);
    const replacedIds = posted
      .map((p) => supersede.replacedBy.get(p.id)?.id)
      .filter((id): id is string => !!id);
    if (replacedIds.length === 0) return 0;

    const reviewedPending = new Set(
      (
        await tx
          .select({ id: transactionsTable.id })
          .from(transactionsTable)
          .where(
            and(
              eq(transactionsTable.householdId, householdId),
              inArray(transactionsTable.id, replacedIds),
              eq(transactionsTable.reviewed, true),
            ),
          )
      ).map((r) => r.id),
    );
    const categories = await tx
      .select({ id: budgetCategoriesTable.id, name: budgetCategoriesTable.name })
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.householdId, householdId));
    const ctx = { uncategorizedIds: uncategorizedCategoryIds(categories) };

    let carried = 0;
    for (const row of posted) {
      const replaced = supersede.replacedBy.get(row.id);
      if (!replaced) continue;
      const next = effectiveFiling({ ...row, description: row.description ?? "" }, replaced, ctx);
      const patch: Partial<typeof transactionsTable.$inferInsert> = {};
      if (next.categoryId !== row.categoryId) patch.categoryId = next.categoryId;
      if (next.weeklyAllowance !== row.weeklyAllowance) patch.weeklyAllowance = next.weeklyAllowance;
      if (next.monthlyAllowance !== row.monthlyAllowance) patch.monthlyAllowance = next.monthlyAllowance;
      if (next.unplannedAllowance !== row.unplannedAllowance) patch.unplannedAllowance = next.unplannedAllowance;
      if (next.weeklyBucket !== row.weeklyBucket) patch.weeklyBucket = next.weeklyBucket;
      if (next.reimbursable !== row.reimbursable) patch.reimbursable = next.reimbursable;
      if (next.debtId !== row.debtId) patch.debtId = next.debtId;
      if (next.isTransfer !== row.isTransfer) patch.isTransfer = next.isTransfer;
      if (
        (patch.categoryId !== undefined || patch.isTransfer !== undefined) &&
        !row.isTransferUserOverridden &&
        replaced.filing.isTransferUserOverridden
      ) {
        patch.isTransferUserOverridden = true;
      }
      if (!row.reviewed && reviewedPending.has(replaced.id)) patch.reviewed = true;
      if (Object.keys(patch).length === 0) continue;
      await tx.update(transactionsTable).set(patch).where(eq(transactionsTable.id, row.id));
      carried += 1;
    }
    return carried;
  });
}
