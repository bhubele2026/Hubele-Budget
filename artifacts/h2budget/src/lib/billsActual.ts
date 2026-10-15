import { isCounted, type MaybeExpiredHold } from "./countedRows";

type ActualRow = MaybeExpiredHold & { occurredOn: string; amount: string | number; isTransfer?: boolean | null };

/**
 * (#70) The Bills page's "Actual · this month": real transactions in
 * [monthStart, nextMonthStart) — money in as income, money out as spend,
 * transfers left out. Moved verbatim out of `pages/bills.tsx` (F6 round 4) so a
 * test can pin it; one change: (finding 6) an expired hold is no real
 * transaction (`isCounted`), so it adds to neither side.
 */
export function actualMonthFlow(
  txns: readonly ActualRow[],
  monthStart: string,
  nextMonthStart: string,
): { income: number; spend: number; net: number } {
  let income = 0;
  let spend = 0;
  for (const t of txns) {
    if (t.occurredOn < monthStart || t.occurredOn >= nextMonthStart) continue;
    if (t.isTransfer) continue;
    if (!isCounted(t)) continue;
    const a = Number(t.amount);
    if (!Number.isFinite(a)) continue;
    if (a > 0) income += a;
    else spend += -a;
  }
  return { income, spend, net: income - spend };
}
