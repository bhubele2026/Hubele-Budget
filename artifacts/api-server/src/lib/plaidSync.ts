import { and, eq } from "drizzle-orm";
import {
  db,
  plaidItemsTable,
  plaidAccountsTable,
  transactionsTable,
} from "@workspace/db";
import { plaid, institutionSlug, type PlaidTxn } from "./plaid";
import { loadUserRules, matchRule } from "./autoCategorize";

export type SyncResult = {
  itemId: string;
  institutionName: string | null;
  added: number;
  modified: number;
  removed: number;
  autoCategorized: number;
  error: string | null;
};

function plaidAmountToSigned(t: PlaidTxn): string {
  // Plaid: positive = money out (debit). We use negative = spend.
  const n = Number(t.amount ?? 0);
  return (-n).toFixed(2);
}

export async function syncPlaidItem(
  userId: string,
  itemRowId: string,
): Promise<SyncResult> {
  const [item] = await db
    .select()
    .from(plaidItemsTable)
    .where(
      and(
        eq(plaidItemsTable.id, itemRowId),
        eq(plaidItemsTable.userId, userId),
      ),
    );
  if (!item) {
    return {
      itemId: itemRowId,
      institutionName: null,
      added: 0,
      modified: 0,
      removed: 0,
      autoCategorized: 0,
      error: "Item not found",
    };
  }

  const slug = item.institutionSlug || institutionSlug(item.institutionName);
  const source = `plaid:${slug}`;
  const rules = await loadUserRules(userId);

  let cursor = item.cursor ?? undefined;
  let added: PlaidTxn[] = [];
  let modified: PlaidTxn[] = [];
  let removed: { transaction_id: string }[] = [];
  let hasMore = true;
  let autoCategorized = 0;

  try {
    while (hasMore) {
      const resp = await plaid().transactionsSync({
        access_token: item.accessToken,
        cursor,
        count: 500,
      });
      added = added.concat(resp.data.added);
      modified = modified.concat(resp.data.modified);
      removed = removed.concat(resp.data.removed as { transaction_id: string }[]);
      cursor = resp.data.next_cursor;
      hasMore = resp.data.has_more;
    }

    // Upsert added/modified
    for (const t of [...added, ...modified]) {
      const description = t.merchant_name || t.name || "(no description)";
      const categoryId = matchRule(description, rules);
      if (categoryId) autoCategorized++;
      const values = {
        userId,
        occurredOn: t.date,
        description,
        amount: plaidAmountToSigned(t),
        categoryId,
        source,
        plaidTransactionId: t.transaction_id,
        plaidAccountId: t.account_id,
        notes: t.pending ? "[pending]" : null,
      };
      await db
        .insert(transactionsTable)
        .values(values)
        .onConflictDoUpdate({
          target: transactionsTable.plaidTransactionId,
          set: {
            occurredOn: values.occurredOn,
            description: values.description,
            amount: values.amount,
            notes: values.notes,
          },
        });
    }

    // Remove
    for (const r of removed) {
      await db
        .delete(transactionsTable)
        .where(
          and(
            eq(transactionsTable.userId, userId),
            eq(transactionsTable.plaidTransactionId, r.transaction_id),
          ),
        );
    }

    await db
      .update(plaidItemsTable)
      .set({
        cursor,
        lastSyncedAt: new Date(),
        lastSyncError: null,
      })
      .where(eq(plaidItemsTable.id, itemRowId));

    return {
      itemId: item.itemId,
      institutionName: item.institutionName,
      added: added.length,
      modified: modified.length,
      removed: removed.length,
      autoCategorized,
      error: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db
      .update(plaidItemsTable)
      .set({ lastSyncError: msg })
      .where(eq(plaidItemsTable.id, itemRowId));
    return {
      itemId: item.itemId,
      institutionName: item.institutionName,
      added: 0,
      modified: 0,
      removed: 0,
      autoCategorized: 0,
      error: msg,
    };
  }
}

export async function syncAllForUser(userId: string): Promise<SyncResult[]> {
  const items = await db
    .select({ id: plaidItemsTable.id })
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.userId, userId));
  const out: SyncResult[] = [];
  for (const it of items) out.push(await syncPlaidItem(userId, it.id));
  return out;
}

export async function syncAllForAllUsers(): Promise<void> {
  const items = await db
    .select({ id: plaidItemsTable.id, userId: plaidItemsTable.userId })
    .from(plaidItemsTable);
  for (const it of items) {
    try {
      await syncPlaidItem(it.userId, it.id);
    } catch {
      // continue
    }
  }
}
