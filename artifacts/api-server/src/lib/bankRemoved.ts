// ⭐ (PR-I, owner decision 14) THE BANK DECIDES WHETHER MONEY MOVED.
//
// Plaid can remove a transaction the household already reviewed, filed or
// flagged. Sync still deletes a removed row no one touched. A row someone worked
// on stays, marked by a `forecast_resolutions` row — status `bank_removed`,
// `recurring_item_id` and `occurrence_date` NULL, `matched_txn_id` = the row. No
// schema change: both columns are nullable.
//
//   - The row counts nowhere: `classifyCashRows` gives it `removed_by_bank` (0),
//     and Spending, Amex owed, Budget, debt pending payments, the Reports hub
//     totals and the avalanche actuals read `notBankRemovedSql()`.
//   - It stays visible: the Chase ledger lists it labelled "Removed by bank",
//     and GET /transactions lists it flagged when asked (`includeBankRemoved`).
//   - Plaid listing the id again (the cursor's `added`/`modified`, or the gap
//     backfill's /transactions/get) deletes the marker, and the row counts again.
//   - (round 2) A bill answer on the row closes nothing: `bankRemovedPayments.ts`.
//
// ⚠️ THE MARKER IS NOT A RESOLUTION. It resolves no bill, matches no row and
// never means "paid". Every reader of `forecast_resolutions` filters it out
// (`isResolutionRow()`) or cannot reach it (it has no plan key), and nothing that
// deletes resolutions by `matched_txn_id` may take it along: that would silently
// put the removed row back into every total.
//
// The review work on a replaced pending row carries separately: `reviewCarry.ts`.

import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db, forecastResolutionsTable, transactionsTable } from "@workspace/db";
import { BANK_REMOVED_STATUS } from "@workspace/avalanche-core";

export { BANK_REMOVED_STATUS };

/** `db` or a transaction on it, for reads. */
type Reader = Pick<typeof db, "select">;

/** SQL over `forecast_resolutions`: a real resolution, not a bank-removed marker. */
export function isResolutionRow(): SQL {
  return ne(forecastResolutionsTable.status, BANK_REMOVED_STATUS);
}

/**
 * SQL: the transaction `txnId` names carries a bank-removed marker. Pass the
 * aliased id column when the transactions table is aliased.
 */
export function bankRemovedSql(txnId: AnyPgColumn = transactionsTable.id): SQL {
  return sql`exists (select 1 from ${forecastResolutionsTable} where ${forecastResolutionsTable.matchedTxnId} = ${txnId} and ${forecastResolutionsTable.status} = ${BANK_REMOVED_STATUS})`;
}

/** SQL: the transaction `txnId` names carries no bank-removed marker — the row counts. */
export function notBankRemovedSql(txnId: AnyPgColumn = transactionsTable.id): SQL {
  return sql`not ${bankRemovedSql(txnId)}`;
}

/** The household's transaction ids that carry a bank-removed marker. */
export async function loadBankRemovedIds(householdId: string, reader: Reader = db): Promise<Set<string>> {
  const rows = await reader
    .select({ txnId: forecastResolutionsTable.matchedTxnId })
    .from(forecastResolutionsTable)
    .where(
      and(
        eq(forecastResolutionsTable.householdId, householdId),
        eq(forecastResolutionsTable.status, BANK_REMOVED_STATUS),
      ),
    );
  return new Set(rows.map((r) => r.txnId).filter((id): id is string => !!id));
}

const CHUNK = 1000;
function chunked<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/**
 * Marks rows the bank removed that sync kept because someone worked on them.
 * At most one marker per row. Returns how many markers were written.
 *
 * (round 2, review NIT) One `INSERT … SELECT … WHERE NOT EXISTS` statement per
 * chunk: a read followed by an insert could let a second marker in between.
 * With no unique index (no DDL) a truly simultaneous second sync still could;
 * every reader treats the markers as a set, so a duplicate changes nothing.
 */
export async function markBankRemoved(
  householdId: string,
  ownerUserId: string,
  txnIds: readonly string[],
): Promise<number> {
  const ids = [...new Set(txnIds)];
  let written = 0;
  for (const part of chunked(ids)) {
    const result = await db.execute(sql`
      insert into ${forecastResolutionsTable} (user_id, household_id, status, matched_txn_id)
      select ${ownerUserId}, ${householdId}::uuid, ${BANK_REMOVED_STATUS}, t.id
      from unnest(array[${sql.join(
        part.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[]) as t(id)
      where not exists (
        select 1 from ${forecastResolutionsTable} existing
        where existing.matched_txn_id = t.id and existing.status = ${BANK_REMOVED_STATUS}
      )
    `);
    written += (result as { rowCount?: number | null }).rowCount ?? 0;
  }
  return written;
}

/** Deletes the markers on the household's rows carrying one of `plaidTransactionIds`: Plaid lists them again. */
export async function clearBankRemovedForPlaidIds(
  householdId: string,
  plaidTransactionIds: readonly string[],
): Promise<number> {
  if (plaidTransactionIds.length === 0) return 0;
  // Nearly always none: skip the per-id deletes.
  if ((await loadBankRemovedIds(householdId)).size === 0) return 0;
  let cleared = 0;
  for (const part of chunked([...new Set(plaidTransactionIds)])) {
    const gone = await db
      .delete(forecastResolutionsTable)
      .where(
        and(
          eq(forecastResolutionsTable.householdId, householdId),
          eq(forecastResolutionsTable.status, BANK_REMOVED_STATUS),
          inArray(
            forecastResolutionsTable.matchedTxnId,
            db
              .select({ id: transactionsTable.id })
              .from(transactionsTable)
              .where(
                and(
                  eq(transactionsTable.householdId, householdId),
                  inArray(transactionsTable.plaidTransactionId, part),
                ),
              ),
          ),
        ),
      )
      .returning({ id: forecastResolutionsTable.id });
    cleared += gone.length;
  }
  return cleared;
}
