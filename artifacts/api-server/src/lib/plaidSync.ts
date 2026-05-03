import { and, eq } from "drizzle-orm";
import {
  db,
  plaidItemsTable,
  plaidAccountsTable,
  transactionsTable,
  forecastSettingsTable,
  forecastResolutionsTable,
  recurringItemsTable,
} from "@workspace/db";
import { plaid, institutionSlug, type PlaidTxn } from "./plaid";
import { loadUserRules, categorize } from "./autoCategorize";
import { expandItem, parseISO, addDays, fmtISO } from "./cashSignal";

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

  // Identify the user's chosen "checking" Plaid account (if any) so we can
  // auto-flag its transactions for the cash forecast and try to auto-match
  // them against planned recurring items.
  const [forecastSettings] = await db
    .select()
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, userId));
  let checkingPlaidAccountId: string | null = null;
  if (forecastSettings?.bankSnapshotAccountId) {
    const [acct] = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.id, forecastSettings.bankSnapshotAccountId));
    checkingPlaidAccountId = acct?.accountId ?? null;
  }

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
    const insertedCheckingTxns: { id: string; amount: number; date: string }[] = [];
    for (const t of [...added, ...modified]) {
      const description = t.merchant_name || t.name || "(no description)";
      // `personal_finance_category` is the modern Plaid taxonomy used to
      // detect transfers (TRANSFER_IN/OUT) and as a fallback signal when no
      // mapping_rule matches the description.
      const pfc = (t as unknown as {
        personal_finance_category?: { primary?: string; detailed?: string } | null;
      }).personal_finance_category;
      const cat = categorize(
        {
          description,
          pfcPrimary: pfc?.primary ?? null,
          pfcDetailed: pfc?.detailed ?? null,
        },
        rules,
      );
      if (cat.categoryId) autoCategorized++;
      const isChecking =
        checkingPlaidAccountId !== null && t.account_id === checkingPlaidAccountId;
      const values = {
        userId,
        occurredOn: t.date,
        description,
        amount: plaidAmountToSigned(t),
        categoryId: cat.categoryId,
        isTransfer: cat.isTransfer,
        source,
        plaidTransactionId: t.transaction_id,
        plaidAccountId: t.account_id,
        notes: t.pending ? "[pending]" : null,
        forecastFlag: isChecking && !cat.isTransfer,
      };
      const [row] = await db
        .insert(transactionsTable)
        .values(values)
        .onConflictDoUpdate({
          target: transactionsTable.plaidTransactionId,
          // Preserve any manual override of categoryId — only refresh fields
          // that come straight from Plaid.
          set: {
            occurredOn: values.occurredOn,
            description: values.description,
            amount: values.amount,
            notes: values.notes,
            isTransfer: values.isTransfer,
            ...(isChecking && !cat.isTransfer ? { forecastFlag: true } : {}),
          },
        })
        .returning({ id: transactionsTable.id });
      if (isChecking && row) {
        insertedCheckingTxns.push({
          id: row.id,
          amount: Number(values.amount),
          date: values.occurredOn,
        });
      }
    }

    // Auto-match: for each new checking txn, find a planned recurring event
    // within ±3 days with the same sign and (within $1) amount, and mark it matched.
    if (insertedCheckingTxns.length > 0) {
      const recurring = await db
        .select()
        .from(recurringItemsTable)
        .where(eq(recurringItemsTable.userId, userId));
      const minDate = insertedCheckingTxns.reduce((a, b) => (a < b.date ? a : b.date), insertedCheckingTxns[0].date);
      const maxDate = insertedCheckingTxns.reduce((a, b) => (a > b.date ? a : b.date), insertedCheckingTxns[0].date);
      const from = addDays(parseISO(minDate), -7);
      const to = addDays(parseISO(maxDate), 7);
      const events = recurring.flatMap((r) => expandItem(r, from, to));

      const existingResolutions = await db
        .select()
        .from(forecastResolutionsTable)
        .where(eq(forecastResolutionsTable.userId, userId));
      const usedPlanKeys = new Set(
        existingResolutions
          .filter((r) => r.recurringItemId && r.occurrenceDate)
          .map((r) => `${r.recurringItemId}|${r.occurrenceDate}`),
      );
      const usedTxnIds = new Set(
        existingResolutions
          .filter((r) => r.matchedTxnId)
          .map((r) => r.matchedTxnId as string),
      );

      for (const txn of insertedCheckingTxns) {
        if (usedTxnIds.has(txn.id)) continue;
        const txnSign = Math.sign(txn.amount) || 0;
        if (txnSign === 0) continue;
        let bestKey: string | null = null;
        let bestItemId: string | null = null;
        let bestDate: string | null = null;
        let bestScore = Infinity;
        const txnMs = parseISO(txn.date).getTime();
        for (const ev of events) {
          if (Math.sign(ev.amount) !== txnSign) continue;
          if (Math.abs(Math.abs(ev.amount) - Math.abs(txn.amount)) > 1) continue;
          const evMs = parseISO(ev.date).getTime();
          const days = Math.abs(evMs - txnMs) / 86_400_000;
          if (days > 3) continue;
          const key = `${ev.itemId}|${ev.date}`;
          if (usedPlanKeys.has(key)) continue;
          const score = days * 10 + Math.abs(Math.abs(ev.amount) - Math.abs(txn.amount));
          if (score < bestScore) {
            bestScore = score;
            bestKey = key;
            bestItemId = ev.itemId;
            bestDate = ev.date;
          }
        }
        if (bestKey && bestItemId && bestDate) {
          await db.insert(forecastResolutionsTable).values({
            userId,
            recurringItemId: bestItemId,
            occurrenceDate: bestDate,
            status: "matched",
            matchedTxnId: txn.id,
          });
          usedPlanKeys.add(bestKey);
          usedTxnIds.add(txn.id);
        }
      }
      void fmtISO; // silence unused warning if helper not needed elsewhere
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
