// (PR7b) A pending charge its posted row replaced is not spending twice.
//
// PR4c's `pairPendingWithPosted` decides which pending rows a posted row
// replaced when the sync never linked them. The cash ledger drops those rows;
// this module gives the spending readers (`buildSpendingFacts`,
// `buildBehaviorFacts`, the Amex weekly payoff) the same answer, so a pending
// $45.00 and its posted $47.40 count $47.40, not $92.40.

import { and, eq, exists, gte, isNotNull, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, transactionsTable } from "@workspace/db";
import {
  pairPendingWithPosted,
  SUPERSEDE_MAX_DAYS,
  type SupersedeRow,
} from "@workspace/avalanche-core";

/**
 * ⭐ THE IDS OF EVERY PENDING ROW A POSTED ROW REPLACED, across the household's
 * whole ledger.
 *
 * ⚠️ WHY NOT JUST THE WINDOW'S ROWS (or the window plus 7 days)? Pairing is one to
 * one and posted rows pick in date order, each taking the OLDEST qualifying
 * pending row. So which pending row a posted row replaces can depend on rows
 * outside any window:
 *   - a posted row inside the window can replace a pending row dated up to
 *     SUPERSEDE_MAX_DAYS before it — and if it does, a second pending row inside
 *     the window is a real, separate charge that must still count;
 *   - a posted row dated before the window can take a pending row that would
 *     otherwise be available to one inside it, and so on back, 7 days at a time.
 * Pairing over the window alone (or the window plus a margin) would give a
 * window-dependent answer, and adjacent weeks would stop adding up to the
 * fortnight.
 *
 * Instead the query reads only the rows that CAN pair, from the whole ledger:
 * every pending row with a Plaid account, and every posted row with a Plaid
 * account dated on or up to SUPERSEDE_MAX_DAYS after a pending row on the same
 * account. A posted row outside that set qualifies for no pending row
 * (`canSupersede` requires both), so it takes nothing and moves no other pair:
 * the result is exactly what pairing the entire ledger would give. Pending rows
 * are few (the sync deletes the ones nobody touched), so the set is small.
 *
 * A replaced pending row is dropped from every spending figure. The charge
 * counts once, on its posted row, with the posted row's date, amount and
 * classification.
 */
export async function loadSupersededPendingIds(householdId: string): Promise<Set<string>> {
  const pendingSide = alias(transactionsTable, "pending_side");
  const rows = await db
    .select({
      id: transactionsTable.id,
      plaidAccountId: transactionsTable.plaidAccountId,
      pending: transactionsTable.pending,
      occurredOn: transactionsTable.occurredOn,
      amount: transactionsTable.amount,
      description: transactionsTable.description,
      createdAt: transactionsTable.createdAt,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        isNotNull(transactionsTable.plaidAccountId),
        or(
          eq(transactionsTable.pending, true),
          exists(
            db
              .select({ one: sql`1` })
              .from(pendingSide)
              .where(
                and(
                  eq(pendingSide.householdId, householdId),
                  eq(pendingSide.plaidAccountId, transactionsTable.plaidAccountId),
                  eq(pendingSide.pending, true),
                  lte(pendingSide.occurredOn, transactionsTable.occurredOn),
                  gte(
                    pendingSide.occurredOn,
                    sql`(${transactionsTable.occurredOn} - ${SUPERSEDE_MAX_DAYS}::int)`,
                  ),
                ),
              ),
          ),
        ),
      ),
    );

  const pairs = pairPendingWithPosted(rows.map(toSupersedeRow));
  return new Set([...pairs.values()].map((p) => p.id));
}

function toSupersedeRow(r: {
  id: string;
  plaidAccountId: string | null;
  pending: boolean;
  occurredOn: string;
  amount: string;
  description: string;
  createdAt: Date;
}): SupersedeRow {
  return {
    id: r.id,
    plaidAccountId: r.plaidAccountId,
    pending: r.pending,
    occurredOn: r.occurredOn,
    amount: Number(r.amount) || 0,
    description: r.description,
    createdAt: r.createdAt,
  };
}
