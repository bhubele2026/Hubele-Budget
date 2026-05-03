import {
  compareMonth,
  shiftMonth,
  type MonthKey,
} from "@/components/account-page";

/**
 * Compute the account ending balance at the end of `target` month, anchored
 * at `anchorMonth` with `anchorBalance`. The anchor balance is the known
 * balance at end-of-month for `anchorMonth` (typically the bank snapshot
 * date's month). We walk forward/backward from the anchor by adding/
 * subtracting per-month net change.
 *
 * Net changes are looked up by `${year}-${month}` keys (month is 0-indexed,
 * matching `MonthKey.month`).
 */
export function computeBalanceAtEndOf(args: {
  anchorBalance: number;
  anchorMonth: MonthKey;
  netChangeByMonth: Map<string, number>;
  target: MonthKey;
}): number {
  const { anchorBalance, anchorMonth, netChangeByMonth, target } = args;
  const cmp = compareMonth(target, anchorMonth);
  if (cmp === 0) return anchorBalance;
  let bal = anchorBalance;
  if (cmp < 0) {
    let cursor = anchorMonth;
    while (compareMonth(cursor, target) > 0) {
      const k = `${cursor.year}-${cursor.month}`;
      bal -= netChangeByMonth.get(k) ?? 0;
      cursor = shiftMonth(cursor, -1);
    }
  } else {
    let cursor = shiftMonth(anchorMonth, 1);
    while (compareMonth(cursor, target) <= 0) {
      const k = `${cursor.year}-${cursor.month}`;
      bal += netChangeByMonth.get(k) ?? 0;
      cursor = shiftMonth(cursor, 1);
    }
  }
  return bal;
}
