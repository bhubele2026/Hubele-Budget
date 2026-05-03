export type RowLike = {
  id: string;
  occurredOn: string;
  amount: string | number;
};

/**
 * Compute a running balance for a list of transactions, anchored to a
 * known balance value. Walks newest → oldest so the most recent row's
 * displayed running balance equals `anchorBalance`. Each older row's
 * running balance equals the balance after that transaction posted.
 *
 * Input rows are expected to already be sorted descending by date
 * (newest first), the same way `useListTransactions()` returns them.
 * Returns a Map keyed by row id → running balance value.
 */
export function computeRunningBalances(
  rows: RowLike[],
  anchorBalance: number,
): Map<string, number> {
  const out = new Map<string, number>();
  let bal = Math.round(anchorBalance * 100) / 100;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    out.set(r.id, bal);
    const amt = Number(r.amount) || 0;
    bal = Math.round((bal - amt) * 100) / 100;
  }
  return out;
}
