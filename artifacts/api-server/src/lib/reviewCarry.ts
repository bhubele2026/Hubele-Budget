// ⭐ (PR-I, owner decision 14) REVIEWED DOES NOT FREEZE BANK STATUS — AND THE
// REVIEW WORK IS NOT LOST WHEN THE BANK RE-ISSUES A ROW.
//
// A pending→posted re-key (`pending_transaction_id`) already keeps the review
// work on the same row. When Plaid instead posts the charge under a NEW id —
// no link, and an amount or date the re-mint cannot adopt (a tip, a hold that
// posts higher) — sync inserts the posted row bare: unreviewed, the rules'
// category, no allowance flags. The pending row someone worked on stays behind,
// marked `bank_removed` once Plaid removes it (`bankRemoved.ts`).
//
// `carryReviewToReplacements` gives that posted row what the household put on
// the pending row it replaced. PR-D already reads the filing this way at read
// time (`effectiveFiling`); this writes it, with `reviewed`, so the Chase and Amex
// pages show the work too.
//
// ⚠️ (round 2, review HIGH-1) ONLY WHEN THE BANK NO LONGER HAS THE PENDING ROW.
// The replacement is found by a look-alike rule (same account, 0–7 days later,
// up to 1.3× + $1, a similar name). On its own that cannot tell a posting from
// a SECOND purchase at the same shop, and a carry is written for good: a
// separate $5.75 coffee would take a still-pending $5.00 coffee's review and
// filing and leave the To review list without a word. So the carry needs the
// bank's word that the pending row is gone as well — its `bank_removed` marker
// (the cursor sync marks before it carries), or, on the gap backfill, its
// absence from a complete `/transactions/get` listing of its window.

import { and, eq, inArray } from "drizzle-orm";
import { db, budgetCategoriesTable, transactionsTable } from "@workspace/db";
import { loadBankRemovedIds } from "./bankRemoved";
import { effectiveFiling, uncategorizedCategoryIds } from "./pendingFiling";
import { findSupersededPendingForRange } from "./supersededPending";

/** The pending row a posted row replaced, as the "gone at the bank" test reads it. */
export interface ReplacedPendingRow {
  id: string;
  plaidTransactionId: string | null;
  occurredOn: string;
  /** Carries a `bank_removed` marker. */
  bankRemoved: boolean;
}

export interface CarryOptions {
  /**
   * Whether the bank no longer has the replaced pending row. Default: it carries
   * a `bank_removed` marker. The gap backfill adds "absent from a complete
   * listing of its window".
   */
  pendingGone?: (pending: ReplacedPendingRow) => boolean;
}

/**
 * ⭐ CARRY REVIEW WORK TO A REPLACEMENT THAT ARRIVED UNDER A NEW ID.
 *
 * `insertedIds`: rows the calling sync INSERTED. Each that is posted, replaced a
 * pending row — `findSupersededPendingForRange`, the pairing the cash rule,
 * Spending and Budget already read — AND whose pending row the bank no longer has
 * (`pendingGone`), takes what the household put on that pending row:
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
  opts: CarryOptions = {},
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

    const pendingRows = await tx
      .select({
        id: transactionsTable.id,
        plaidTransactionId: transactionsTable.plaidTransactionId,
        occurredOn: transactionsTable.occurredOn,
        reviewed: transactionsTable.reviewed,
      })
      .from(transactionsTable)
      .where(and(eq(transactionsTable.householdId, householdId), inArray(transactionsTable.id, replacedIds)));
    const bankRemoved = await loadBankRemovedIds(householdId, tx);
    const pendingGone = opts.pendingGone ?? ((p: ReplacedPendingRow) => p.bankRemoved);
    const pendingById = new Map(
      pendingRows.map((p) => [p.id, { ...p, bankRemoved: bankRemoved.has(p.id) }] as const),
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
      // (round 2, HIGH-1) The bank must no longer have the pending row.
      const pending = pendingById.get(replaced.id);
      if (!pending || !pendingGone(pending)) continue;
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
      if (!row.reviewed && pending.reviewed) patch.reviewed = true;
      if (Object.keys(patch).length === 0) continue;
      await tx.update(transactionsTable).set(patch).where(eq(transactionsTable.id, row.id));
      carried += 1;
    }
    return carried;
  });
}
