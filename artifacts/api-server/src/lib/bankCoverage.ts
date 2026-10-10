import { and, eq, inArray, sql } from "drizzle-orm";
import { db, transactionsTable } from "@workspace/db";

/**
 * ⭐ "DATA THROUGH" — the newest bank transaction H2 holds for each Plaid item.
 *
 * The newest `occurredOn` across every Plaid-attached (account-mapped) row,
 * one grouped query fanned out by external `account_id` and rolled back up by
 * item. (#408) It powers the post-link "No new transactions since <date>"
 * copy, and (WP3) every "data through" label: `GET /plaid/items`
 * (`lastBankTxOn`) and Settings › Automation (`CategorizationBank.lastDataOn`).
 *
 * ⚠️ A DATA date, not a sync date. Settings used to print the household day of
 * `lastSyncedAt` as "data through", so a sync that brought nothing new moved
 * the label anyway. Extracted verbatim from `routes/plaid.ts` (GET
 * /plaid/items) so both screens read one rule.
 *
 * `accts` are the household's `plaid_accounts` rows (`accountId` external,
 * `itemId` the internal item row id). Returns item row id → YYYY-MM-DD; an
 * item with no rows is absent.
 */
export async function lastBankTxOnByItem(
  householdId: string,
  accts: ReadonlyArray<{ accountId: string; itemId: string }>,
): Promise<Map<string, string>> {
  const externalIds = accts.map((a) => a.accountId);
  const lastByItem = new Map<string, string>();
  if (externalIds.length === 0) return lastByItem;
  const rows = await db
    .select({
      plaidAccountId: transactionsTable.plaidAccountId,
      maxDate: sql<string>`max(${transactionsTable.occurredOn})::text`,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        inArray(transactionsTable.plaidAccountId, externalIds),
      ),
    )
    .groupBy(transactionsTable.plaidAccountId);
  const itemByExternal = new Map(accts.map((a) => [a.accountId, a.itemId]));
  for (const r of rows) {
    if (!r.plaidAccountId || !r.maxDate) continue;
    const itemRowId = itemByExternal.get(r.plaidAccountId);
    if (!itemRowId) continue;
    const prev = lastByItem.get(itemRowId);
    if (!prev || r.maxDate > prev) lastByItem.set(itemRowId, r.maxDate);
  }
  return lastByItem;
}
