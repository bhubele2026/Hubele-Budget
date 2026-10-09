import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { db, debtsTable, plaidAccountsTable, transactionsTable } from "@workspace/db";
import { classifyLiabilityRow } from "@workspace/avalanche-core";
import { householdDayOf } from "./householdClock";

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
 *
 * ⭐ (WP2) THE RULE, IN ONE SENTENCE: a row tagged to a debt is "paid, not
 * posted" when it pays the debt down (a positive amount — and, for a row from a
 * bank or card feed, one `classifyLiabilityRow` calls a payment), it is not the
 * bank half of a confirmed payment claim, and it is dated AFTER the household
 * day of the debt's balance as-of (`balanceAsOfForDebt`).
 *
 * Why each clause (Brad's Amex Platinum read $1,227.27 "Owed" beside a
 * $3,842.98 balance — the same $2,615.71 subtracted twice):
 *   - THE DAY, NOT THE INSTANT. A creditor row usually has no time, and the old
 *     reader stamped it 23:59:59Z — after any fetch that day — so a payment the
 *     balance already held stayed "pending" until the next day's refresh (from
 *     7pm Central, the next UTC day, it was always after). A payment dated on or
 *     before the as-of day is taken to be IN the balance; a payment dated after
 *     it cannot be.
 *   - THE SHAPE. The sync tagged every positive card row to the card's debt —
 *     refunds and statement credits included — and each of those netted the
 *     balance as if it were a payment. A feed row now counts only when it reads
 *     as a payment (the card-payment flag, Plaid's LOAN_PAYMENTS / TRANSFER_IN,
 *     the card-payment patterns, "payment" / "thank you" / "autopay"). Rows the
 *     household typed in keep counting: tagging one is their own statement that
 *     it paid the debt. Mis-tagged history is left as stored and excluded here.
 *   - THE CLAIM. A payment logged in the app that a bank row confirmed is one
 *     payment: the bank row that confirmed it never counts again.
 */

export type DebtRow = typeof debtsTable.$inferSelect;

export type PendingEntry = { total: number; count: number };

function later(a: Date | null | undefined, b: Date | null | undefined): Date | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * (WP2) WHEN THE DEBT'S BALANCE WAS READ — the instant the pending rule cuts at,
 * served as `Debt.liabilityAsOf`.
 *   - A Plaid-sourced linked debt: the later of the card's liability fetch
 *     (`plaid_accounts.liability_last_fetched_at`, when Plaid's balance was
 *     cached) and the debt's last successful Plaid refresh
 *     (`plaidLastSyncedAt`). The balance it carries is no older than either.
 *   - Any other debt: `lastBalanceUpdate`, when its balance was last written.
 * Null when the balance was never read; then every payment-shaped row counts.
 *
 * (#421) Once the creditor reports a fresher balance the as-of advances and the
 * same payments fall out of the window automatically. No write-time
 * bookkeeping required.
 */
export function balanceAsOfForDebt(d: DebtRow, liabilityFetchedAt: Date | null | undefined): Date | null {
  if (d.balanceSource === "plaid" && d.plaidAccountId) {
    return later(liabilityFetchedAt, d.plaidLastSyncedAt);
  }
  return d.lastBalanceUpdate ?? null;
}

/** A tagged row, as the pending rule reads it. */
export type PendingRowInput = {
  debtId: string;
  amount: number | string;
  occurredOn: string;
  source: string | null;
  plaidTransactionId: string | null;
  description: string | null;
  pfcPrimary: string | null;
  pfcDetailed: string | null;
  isExternalCardPayment: boolean | null;
  /** This row is the bank row that confirmed a payment claim (`confirmed_by_txn_id`). */
  confirmsClaim: boolean;
};

/** A row the household typed in. Everything else came from a feed (Plaid, a workbook, a bank file). */
function isManualRow(r: Pick<PendingRowInput, "source" | "plaidTransactionId">): boolean {
  return !r.plaidTransactionId && (r.source ?? "manual").toLowerCase() === "manual";
}

/**
 * ⭐ THE RULE ITSELF, with no I/O (see the file header). `asOfDayByDebt` maps
 * each debt to the household day of its balance as-of, or null when the balance
 * was never read. Totals are summed in input order, unrounded.
 */
export function pendingFromRows(
  rows: readonly PendingRowInput[],
  asOfDayByDebt: ReadonlyMap<string, string | null>,
): Map<string, PendingEntry> {
  const out = new Map<string, PendingEntry>();
  for (const r of rows) {
    if (!asOfDayByDebt.has(r.debtId)) continue;
    const amt = Number(r.amount);
    // Payment direction (positive): pays the debt down.
    if (!Number.isFinite(amt) || amt <= 0) continue;
    if (r.confirmsClaim) continue;
    if (!isManualRow(r) && classifyLiabilityRow(r)?.kind !== "payment") continue;
    const asOfDay = asOfDayByDebt.get(r.debtId) ?? null;
    if (asOfDay && r.occurredOn.slice(0, 10) <= asOfDay) continue;
    const cur = out.get(r.debtId) ?? { total: 0, count: 0 };
    cur.total += amt;
    cur.count += 1;
    out.set(r.debtId, cur);
  }
  return out;
}

/**
 * (WP2) Which debt a row synced from a debt-linked card or loan account is
 * tagged to: the linked debt, only when the row is a PAYMENT by
 * `classifyLiabilityRow` — the same shape rule the pending reader applies. A
 * refund, a statement credit or a purchase on the card stays untagged (the sync
 * used to tag every positive row). Rows tagged before this keep their stored
 * tag; the pending reader excludes them by the same rule.
 */
export function debtIdForSyncedRow(
  linkedDebtId: string | null,
  row: { source: string | null; amount: number | string; description: string | null; pfcPrimary: string | null; pfcDetailed: string | null },
): string | null {
  if (!linkedDebtId) return null;
  return classifyLiabilityRow(row)?.kind === "payment" ? linkedDebtId : null;
}

/** Each debt's balance as-of (`balanceAsOfForDebt`), reading its card's liability fetch time. */
export async function loadBalanceAsOf(
  householdId: string,
  debts: DebtRow[],
): Promise<Map<string, Date | null>> {
  const acctIds = [...new Set(debts.map((d) => d.plaidAccountId).filter((v): v is string => !!v))];
  const fetchedAt = new Map<string, Date | null>();
  if (acctIds.length > 0) {
    const accts = await db
      .select({ id: plaidAccountsTable.id, fetchedAt: plaidAccountsTable.liabilityLastFetchedAt })
      .from(plaidAccountsTable)
      .where(and(eq(plaidAccountsTable.householdId, householdId), inArray(plaidAccountsTable.id, acctIds)));
    for (const a of accts) fetchedAt.set(a.id, a.fetchedAt ?? null);
  }
  return new Map(
    debts.map((d) => [d.id, balanceAsOfForDebt(d, d.plaidAccountId ? fetchedAt.get(d.plaidAccountId) : null)] as const),
  );
}

/**
 * Payments tagged to a debt that the creditor hasn't yet reflected in
 * `balance`, keyed by debt id. The rule is `pendingFromRows`.
 */
export async function loadPendingPayments(
  householdId: string,
  debts: DebtRow[],
): Promise<Map<string, PendingEntry>> {
  if (debts.length === 0) return new Map();
  const ids = debts.map((d) => d.id);
  const t = transactionsTable;
  const [rows, asOf] = await Promise.all([
    db
      .select({
        debtId: t.debtId,
        amount: t.amount,
        occurredOn: t.occurredOn,
        source: t.source,
        plaidTransactionId: t.plaidTransactionId,
        description: t.description,
        pfcPrimary: t.pfcPrimary,
        pfcDetailed: t.pfcDetailed,
        isExternalCardPayment: t.isExternalCardPayment,
        // The bank row a payment claim was confirmed by (one claim per row, a
        // unique index): `c` is a second scan of the same table.
        confirmsClaim: sql<boolean>`exists (select 1 from ${t} as c where c.confirmed_by_txn_id = ${t.id})`,
      })
      .from(t)
      .where(
        and(
          eq(t.householdId, householdId),
          isNotNull(t.debtId),
          inArray(t.debtId, ids),
          // payment-direction (positive amount): pays down the debt
          gt(t.amount, "0"),
        ),
      ),
    loadBalanceAsOf(householdId, debts),
  ]);
  const asOfDay = new Map<string, string | null>();
  for (const [id, at] of asOf) asOfDay.set(id, at ? householdDayOf(at) : null);
  return pendingFromRows(
    rows
      .filter((r): r is typeof r & { debtId: string } => !!r.debtId)
      .map((r) => ({ ...r, confirmsClaim: r.confirmsClaim === true })),
    asOfDay,
  );
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
