import { and, eq } from "drizzle-orm";
import {
  db,
  debtsTable,
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
import { refreshAmexAnchor } from "./amexAnchor";

export type SyncResult = {
  itemId: string;
  institutionName: string | null;
  added: number;
  modified: number;
  removed: number;
  autoCategorized: number;
  error: string | null;
  // True when Plaid responded with PRODUCT_NOT_READY (a freshly linked item
  // whose historical batch is still being staged). Treated as a transient,
  // non-destructive state by the frontend.
  stillPreparing?: boolean;
};

type PlaidErrorBody = {
  error_code?: string;
  error_message?: string;
  error_type?: string;
};

/**
 * Pull Plaid's structured error_code / error_message out of an axios-shaped
 * error. The Plaid SDK throws axios errors whose `response.data` carries the
 * structured details we want to surface to users — falling back to the raw
 * `e.message` (e.g. "Request failed with status code 400") strips that info.
 */
export function extractPlaidError(e: unknown): {
  code: string | null;
  message: string;
} {
  const ax = e as { response?: { data?: PlaidErrorBody } };
  const body = ax?.response?.data;
  const code = body?.error_code ?? null;
  const plaidMsg = body?.error_message;
  if (plaidMsg) return { code, message: plaidMsg };
  if (e instanceof Error) return { code, message: e.message };
  return { code, message: String(e) };
}

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

  // Build a map from Plaid's external account_id to the user's debt.id, so any
  // transactions hitting a debt-linked Plaid account are auto-tagged with
  // debtId. This is the "Plaid-imported payments" case the dashboard's
  // paid-off totals previously missed.
  const linkedDebts = await db
    .select({
      debtId: debtsTable.id,
      plaidAccountRowId: debtsTable.plaidAccountId,
    })
    .from(debtsTable)
    .where(eq(debtsTable.userId, userId));
  const linkedAcctRowIds = linkedDebts
    .map((d) => d.plaidAccountRowId)
    .filter((v): v is string => !!v);
  const debtAccountRows = linkedAcctRowIds.length
    ? await db
        .select({
          rowId: plaidAccountsTable.id,
          externalId: plaidAccountsTable.accountId,
        })
        .from(plaidAccountsTable)
        .where(eq(plaidAccountsTable.userId, userId))
    : [];
  const externalByRowId = new Map(
    debtAccountRows.map((r) => [r.rowId, r.externalId]),
  );
  const debtIdByPlaidAccount = new Map<string, string>();
  for (const d of linkedDebts) {
    if (!d.plaidAccountRowId) continue;
    const ext = externalByRowId.get(d.plaidAccountRowId);
    if (ext) debtIdByPlaidAccount.set(ext, d.debtId);
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
      // Plaid `datetime` / `authorized_datetime` are ISO 8601 strings that
      // some institutions populate with a real time. The docs warn they
      // "may contain default time values (such as 00:00:00)" — treat
      // explicit-midnight as "no real time" so the hourly spending clock
      // doesn't get an artificial midnight spike.
      const pickRealTime = (raw: string | null | undefined): string | null => {
        if (!raw) return null;
        const parsed = new Date(raw);
        if (Number.isNaN(parsed.getTime())) return null;
        if (
          parsed.getUTCHours() === 0 &&
          parsed.getUTCMinutes() === 0 &&
          parsed.getUTCSeconds() === 0
        ) {
          return null;
        }
        return parsed.toISOString();
      };
      // Try `datetime` first, then `authorized_datetime` — either may be a
      // midnight sentinel ("default" per Plaid docs) while the other has a
      // real time, so we evaluate them independently rather than short-
      // circuiting on the first non-null value.
      const occurredAt =
        pickRealTime(t.datetime) ?? pickRealTime(t.authorized_datetime);
      const signedAmount = plaidAmountToSigned(t);
      // Only attribute a transaction to a debt when it is actually a
      // balance-reducing PAYMENT on the linked liability account, never a
      // purchase. Plaid uses positive=debit/charge on liability accounts; our
      // convention flips the sign (`amount = -Plaid.amount`), so payments
      // appear as POSITIVE amounts in our app and purchases as negative.
      // Tagging purchases would make the dashboard double-count debt growth
      // as "paid off" and worsen the original bug.
      const linkedDebtId = debtIdByPlaidAccount.get(t.account_id) ?? null;
      const debtId =
        linkedDebtId && Number(signedAmount) > 0 ? linkedDebtId : null;
      const values = {
        userId,
        occurredOn: t.date,
        occurredAt,
        description,
        amount: signedAmount,
        categoryId: cat.categoryId,
        isTransfer: cat.isTransfer,
        source,
        plaidTransactionId: t.transaction_id,
        plaidAccountId: t.account_id,
        debtId,
        notes: t.pending ? "[pending]" : null,
        forecastFlag: isChecking && !cat.isTransfer,
      };
      const [row] = await db
        .insert(transactionsTable)
        .values(values)
        .onConflictDoUpdate({
          target: transactionsTable.plaidTransactionId,
          // Preserve any manual override of categoryId — only refresh fields
          // that come straight from Plaid. For debtId we ONLY write when our
          // auto-detect computed a non-null link (positive payment on a
          // debt-linked account). When auto-detect yields null we leave the
          // existing debtId untouched, so manual /transactions PATCH overrides
          // (e.g. linking a checking-side payment to a debt) are not wiped on
          // the next Plaid sync.
          set: {
            occurredOn: values.occurredOn,
            occurredAt: values.occurredAt,
            description: values.description,
            amount: values.amount,
            notes: values.notes,
            isTransfer: values.isTransfer,
            ...(debtId ? { debtId } : {}),
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
        // The bank successfully returned a /transactions/sync result, so
        // it is no longer "still preparing". Clear the badge so Settings
        // shows this item as healthy again on the next list refresh.
        stillPreparingSince: null,
      })
      .where(eq(plaidItemsTable.id, itemRowId));

    // If this item is American Express, refresh the persisted Amex anchor so
    // GET /amex/anchor's `asOf` timestamp advances and the linked debt's
    // balance moves forward (unless the user has manually overridden it via
    // the debts UI since the last auto-update).
    if (slug === "amex") {
      try {
        await refreshAmexAnchor(userId, db, { adopt: false });
      } catch {
        // Anchor refresh is best-effort; never break the sync result.
      }
    }

    // Auto-refresh bank snapshot balance if a Plaid checking account is
    // configured (#45). Keeps the forecast anchor fresh on every sync.
    let balanceRefreshError: string | null = null;
    if (checkingPlaidAccountId && forecastSettings?.bankSnapshotAccountId) {
      try {
        const resp = await plaid().accountsBalanceGet({
          access_token: item.accessToken,
          options: { account_ids: [checkingPlaidAccountId] },
        });
        const acct = resp.data.accounts.find(
          (a) => a.account_id === checkingPlaidAccountId,
        );
        const live = acct?.balances.available ?? acct?.balances.current;
        if (live != null) {
          await db
            .update(forecastSettingsTable)
            .set({
              bankSnapshotBalance: Number(live).toFixed(2),
              bankSnapshotAt: new Date(),
              bankSnapshotSource: "plaid",
            })
            .where(eq(forecastSettingsTable.userId, userId));
        }
      } catch (e) {
        // Don't break the sync — but capture Plaid's real reason so the
        // user sees "balance refresh failed: <real plaid message>" rather
        // than a silent failure.
        const { code, message } = extractPlaidError(e);
        // PRODUCT_NOT_READY on balance is just as transient as on
        // /transactions/sync — surface as still-preparing, never as a
        // hard error chip.
        if (code !== "PRODUCT_NOT_READY") {
          balanceRefreshError = `Balance refresh failed: ${message}`;
        }
      }
    }

    if (balanceRefreshError) {
      await db
        .update(plaidItemsTable)
        .set({ lastSyncError: balanceRefreshError })
        .where(eq(plaidItemsTable.id, itemRowId));
    }

    return {
      itemId: item.itemId,
      institutionName: item.institutionName,
      added: added.length,
      modified: modified.length,
      removed: removed.length,
      autoCategorized,
      error: balanceRefreshError,
    };
  } catch (e) {
    const { code, message } = extractPlaidError(e);
    // PRODUCT_NOT_READY is Plaid still staging the historical batch for a
    // freshly linked item. It is transient and recovers on its own (or on
    // the very next Sync click). Don't write it into last_sync_error and
    // don't surface a destructive `error` to the client; instead flag it as
    // "still preparing" so the UI can render an encouraging neutral toast.
    if (code === "PRODUCT_NOT_READY") {
      // Stamp a "still preparing since" timestamp so the Settings page can
      // surface a per-item badge until the next successful sync clears it.
      // We deliberately do NOT touch lastSyncError — PRODUCT_NOT_READY is
      // transient and would clobber a real, actionable error from a prior run.
      await db
        .update(plaidItemsTable)
        .set({ stillPreparingSince: new Date() })
        .where(eq(plaidItemsTable.id, itemRowId));
      return {
        itemId: item.itemId,
        institutionName: item.institutionName,
        added: 0,
        modified: 0,
        removed: 0,
        autoCategorized: 0,
        error: null,
        stillPreparing: true,
      };
    }
    await db
      .update(plaidItemsTable)
      .set({ lastSyncError: message })
      .where(eq(plaidItemsTable.id, itemRowId));
    return {
      itemId: item.itemId,
      institutionName: item.institutionName,
      added: 0,
      modified: 0,
      removed: 0,
      autoCategorized: 0,
      error: message,
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
