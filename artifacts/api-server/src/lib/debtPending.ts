import { and, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { db, debtsTable, transactionsTable } from "@workspace/db";

/**
 * ⭐ THE SERVER'S ONE VIEW OF "PAID BUT NOT YET POSTED".
 *
 * ⚠️ THIS IS A MOVE, NOT NEW LOGIC. Every line below came out of
 * `routes/debts.ts`, where it was file-local and therefore reachable only by
 * `GET /debts`. That is precisely why the server disagreed with itself: the
 * Debts payload netted tagged-unposted payments, while `/api/spine`'s
 * `debt.payoffPct` and `/api/dashboard`'s `totalDebt` summed raw balances
 * straight out of SQL and had no way to see the pending side at all.
 *
 * ⚠️ NO NEW DATA PATH WAS INVENTED FOR C10. The pending side was always
 * visible to the server — it is just tagged transaction rows
 * (`transactions.debt_id`) compared against each debt's own
 * creditor-report timestamp. Extracting the existing reader is the whole
 * server-side change; nothing here queries anything `GET /debts` did not
 * already query.
 */

export type DebtRow = typeof debtsTable.$inferSelect;

export type PendingEntry = { total: number; count: number };

/**
 * (#421) The cutoff is the debt's last creditor-reported balance timestamp —
 * `plaidLastSyncedAt` for Plaid-sourced debts, `lastBalanceUpdate` for manual
 * ones. Anything tagged after that counts as pending; once Plaid (or a manual
 * edit) reports a fresher balance the cutoff advances and the same payments
 * fall out of the window automatically. No write-time bookkeeping required.
 */
export function pendingCutoffForDebt(d: DebtRow): Date | null {
  if (d.balanceSource === "plaid" && d.plaidAccountId) {
    return d.plaidLastSyncedAt ?? null;
  }
  return d.lastBalanceUpdate ?? null;
}

/**
 * Payments tagged to a debt that the creditor hasn't yet reflected in
 * `balance`, keyed by debt id.
 */
export async function loadPendingPayments(
  householdId: string,
  debts: DebtRow[],
): Promise<Map<string, PendingEntry>> {
  const out = new Map<string, PendingEntry>();
  if (debts.length === 0) return out;
  const ids = debts.map((d) => d.id);
  const rows = await db
    .select({
      debtId: transactionsTable.debtId,
      amount: transactionsTable.amount,
      occurredOn: transactionsTable.occurredOn,
      occurredAt: transactionsTable.occurredAt,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.householdId, householdId),
        isNotNull(transactionsTable.debtId),
        inArray(transactionsTable.debtId, ids),
        // payment-direction (positive amount): pays down the debt
        gt(transactionsTable.amount, "0"),
      ),
    );
  const cutoffByDebt = new Map<string, Date | null>();
  for (const d of debts) cutoffByDebt.set(d.id, pendingCutoffForDebt(d));
  for (const r of rows) {
    if (!r.debtId) continue;
    const cutoff = cutoffByDebt.get(r.debtId) ?? null;
    // Use the timestamp when present so a same-day Plaid refresh dated
    // earlier in the day correctly clears earlier payments. Fall back to
    // end-of-day for the date-only column so a tagged payment dated the
    // same day as the cutoff still counts as "after".
    const txnTs = r.occurredAt
      ? new Date(r.occurredAt)
      : new Date(`${r.occurredOn}T23:59:59.999Z`);
    if (cutoff && txnTs.getTime() <= cutoff.getTime()) continue;
    const amt = Number(r.amount);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    const cur = out.get(r.debtId) ?? { total: 0, count: 0 };
    cur.total += amt;
    cur.count += 1;
    out.set(r.debtId, cur);
  }
  return out;
}

/**
 * Attach the pending totals to raw debt rows in the shape
 * `@workspace/avalanche-core`'s `effectiveDebtBalance` / `payoffPct` expect.
 *
 * ⚠️ This is the ONLY way a server surface other than `GET /debts` is allowed
 * to obtain netted balances. It exists so that "net everywhere" is one call
 * (`await withPendingPayments(...)`) rather than an invitation for each route
 * to re-derive the pending side its own way.
 */
export async function withPendingPayments(
  householdId: string,
  debts: DebtRow[],
): Promise<Array<DebtRow & { pendingPaymentTotal: string | null }>> {
  const pendingByDebt = await loadPendingPayments(householdId, debts);
  return debts.map((d) => {
    const pending = pendingByDebt.get(d.id) ?? null;
    return {
      ...d,
      pendingPaymentTotal:
        pending && pending.total > 0 ? pending.total.toFixed(2) : null,
    };
  });
}
