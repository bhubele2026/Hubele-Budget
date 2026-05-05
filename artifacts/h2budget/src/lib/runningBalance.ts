export type RowLike = {
  id: string;
  occurredOn: string;
  amount: string | number;
  occurredAt?: string | null;
};

/**
 * Canonical "newest first" comparator for transaction rows on the
 * Chase / Amex day-list pages. Sorts by:
 *   1. `occurredOn` (calendar date) descending
 *   2. `occurredAt` (precise timestamp) descending — nulls sort last
 *      so rows that have a real Plaid posted-time appear above
 *      manually-entered rows on the same day
 *   3. `id` descending — final, deterministic tiebreaker
 *
 * Both the running-balance computation and the per-day row rendering
 * MUST use this same order, otherwise within-day balances appear
 * non-monotonic in the displayed list (a register-style
 * reconciliation breaks the moment two same-day rows render in a
 * different order than the order their balances were computed in).
 */
export function compareNewestFirst(a: RowLike, b: RowLike): number {
  if (a.occurredOn !== b.occurredOn) {
    return a.occurredOn < b.occurredOn ? 1 : -1;
  }
  const aAt = a.occurredAt ?? null;
  const bAt = b.occurredAt ?? null;
  if (aAt !== bAt) {
    if (aAt === null) return 1;
    if (bAt === null) return -1;
    return aAt < bAt ? 1 : -1;
  }
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/** Returns a new array sorted newest-first via {@link compareNewestFirst}. */
export function sortNewestFirst<T extends RowLike>(rows: readonly T[]): T[] {
  return [...rows].sort(compareNewestFirst);
}

/**
 * Compute a running balance for a list of transactions, anchored to a
 * known balance value. Walks newest → oldest so the most recent row's
 * displayed running balance equals `anchorBalance`. Each older row's
 * running balance equals the balance after that transaction posted.
 *
 * Input rows are expected to already be sorted descending by date
 * (newest first) — typically via {@link sortNewestFirst}. Returns a
 * Map keyed by row id → running balance value.
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
