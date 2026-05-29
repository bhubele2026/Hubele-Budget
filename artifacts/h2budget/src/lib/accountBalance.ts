import {
  compareMonth,
  shiftMonth,
  type MonthKey,
} from "@/components/account-page";

export type AnchorMonthTxn = {
  occurredOn: string;
  amount: string | number;
};

/**
 * Compute the account ending balance at the end of `target` month, anchored
 * at `anchorMonth` with `anchorBalance`.
 *
 * The anchor balance can be either:
 *  - end-of-month (legacy behavior, when `anchorAt` / `anchorMonthTxns` are
 *    omitted), or
 *  - a mid-month point-in-time snapshot (e.g. a Plaid balance fetched on
 *    Apr 15). In that case, end-of-anchor-month is reconstructed as
 *    `anchorBalance + sum(amount for tx in anchorMonth where occurredOn
 *    is strictly after the anchor date)`. Transactions on the same calendar
 *    day as the anchor are assumed to already be reflected in the snapshot.
 *
 * After establishing end-of-anchor-month, the function walks forward
 * (adding) or backward (subtracting) one whole month's net change at a
 * time, looked up from `netChangeByMonth` keyed by `${year}-${month}`
 * (month is 0-indexed, matching `MonthKey.month`).
 */
export function computeBalanceAtEndOf(args: {
  anchorBalance: number;
  anchorMonth: MonthKey;
  netChangeByMonth: Map<string, number>;
  target: MonthKey;
  anchorAt?: string | null;
  anchorMonthTxns?: ReadonlyArray<AnchorMonthTxn>;
}): number {
  const {
    anchorBalance,
    anchorMonth,
    netChangeByMonth,
    target,
    anchorAt,
    anchorMonthTxns,
  } = args;

  // Reconstruct end-of-anchor-month from a mid-month snapshot when we have
  // both the anchor date and the anchor-month transactions.
  let endOfAnchor = anchorBalance;
  if (anchorAt && anchorMonthTxns && anchorMonthTxns.length > 0) {
    const anchorDay = anchorAt.slice(0, 10);
    let postAnchor = 0;
    for (const t of anchorMonthTxns) {
      const day = t.occurredOn.slice(0, 10);
      if (day > anchorDay) {
        postAnchor += Number(t.amount) || 0;
      }
    }
    endOfAnchor = anchorBalance + postAnchor;
  }

  const cmp = compareMonth(target, anchorMonth);
  if (cmp === 0) return endOfAnchor;
  let bal = endOfAnchor;
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

/**
 * Date-bucketed sibling of {@link computeBalanceAtEndOf}: compute the
 * account balance as of the end of a single calendar day (`targetDay`,
 * `YYYY-MM-DD`), anchored at `anchorDay` with `anchorBalance`.
 *
 * Same anchor convention as the month version: `anchorBalance` is the
 * point-in-time balance as of `anchorDay`, and transactions that occur
 * on `anchorDay` itself are assumed to already be reflected in it. So:
 *  - For a target on/after the anchor we ADD every transaction strictly
 *    after the anchor day up through (and including) the target day.
 *  - For a target before the anchor we SUBTRACT every transaction
 *    strictly after the target day up through (and including) the
 *    anchor day, walking the balance backward.
 *
 * Days are compared as `YYYY-MM-DD` strings, which sort lexicographically
 * in chronological order, so no Date parsing is required.
 */
export function computeBalanceAtEndOfDate(args: {
  anchorBalance: number;
  anchorDay: string;
  targetDay: string;
  txns: ReadonlyArray<AnchorMonthTxn>;
}): number {
  const { anchorBalance, anchorDay, targetDay, txns } = args;
  let bal = anchorBalance;
  if (targetDay >= anchorDay) {
    for (const t of txns) {
      const day = t.occurredOn.slice(0, 10);
      if (day > anchorDay && day <= targetDay) bal += Number(t.amount) || 0;
    }
  } else {
    for (const t of txns) {
      const day = t.occurredOn.slice(0, 10);
      if (day > targetDay && day <= anchorDay) bal -= Number(t.amount) || 0;
    }
  }
  return bal;
}
