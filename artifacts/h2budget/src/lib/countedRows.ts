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
export type MaybeExpiredHold = { expiredHold?: boolean | null };

export function isCounted(row: MaybeExpiredHold): boolean {
  return row.expiredHold !== true;
}

/** The rows that count (`isCounted`), in their order. */
export function countedRows<T extends MaybeExpiredHold>(rows: readonly T[]): T[] {
  return rows.filter(isCounted);
}
