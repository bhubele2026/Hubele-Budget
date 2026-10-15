/**
 * ⭐ (F6 round 4) ONE WAY TO KNOW A LIST ROW COUNTS.
 *
 * The server marks an expired hold `expiredHold: true` on the rows it lists
 * (GET /transactions, the GET /forecast bundle): a row still pending more than
 * 7 days after its date that no posted row replaced, or the pending credit that
 * reversed an expired charge. It counts nowhere — the owner's rule (2026-10-15):
 * not in spending, weeks, categories, budgets, reports, allowances, the card,
 * banking or review. The row stays visible, with its "Expired hold · not
 * counted" label (`ExpiredHoldLabel`).
 *
 * Every browser sum over those rows asks `isCounted` first — a filter, never new
 * maths: what the row would have added is simply not added. A row without the
 * field (an older response, a manual row) counts, as before.
 */
export type MaybeExpiredHold = { expiredHold?: boolean | null; expiredPair?: boolean | null };

export function isCounted(row: MaybeExpiredHold): boolean {
  return row.expiredHold !== true;
}

/** The rows that count (`isCounted`), in their order. */
export function countedRows<T extends MaybeExpiredHold>(rows: readonly T[]): T[] {
  return rows.filter(isCounted);
}

/**
 * ⭐ (F6 round 5, review finding 3) DOES THE ROW COUNT AS SPENDING — or ask for
 * an answer? `isCounted`, and not `expiredPair`: a hold the bank snapshot
 * already held and its reversal. The bank balance counts that reversal (the
 * money came back), so the server sends the pair `expiredHold: false` — cash
 * walks and cash flows (`isCounted`: the Reconcile running balance, Cash flow,
 * Bills "Actual") count both, net 0, as the register and the Banking review's
 * money in / out do. But neither row is spending, and neither is asked about:
 * the server's spending, allowances, budgets and review leave them out, and so
 * does every browser spending sum and the Reconcile inbox (`isCountedSpend`).
 */
export function isCountedSpend(row: MaybeExpiredHold): boolean {
  return isCounted(row) && row.expiredPair !== true;
}

/** The rows that count as spending (`isCountedSpend`), in their order. */
export function countedSpendRows<T extends MaybeExpiredHold>(rows: readonly T[]): T[] {
  return rows.filter(isCountedSpend);
}
