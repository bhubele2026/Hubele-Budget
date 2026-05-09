// (#476) Shared helper that computes the Amex end-of-month balance.
//
// Mirrors `chaseEndingBalance.ts` for the Amex page so that if/when a
// dashboard "Amex ending balance" tile is added, both surfaces compute
// from the same logic and can never drift across past, current, or
// future months.
//
// Encapsulates:
//  - Anchor month selection (the month containing the asOf timestamp,
//    falling back to the supplied `fallbackMonth` — typically today's
//    month — when no asOf is available).
//  - Mid-month snapshot reconstruction
//    (`endOfAnchorMonth = anchor + sum(post-anchor anchor-month txns)`).
//  - Per-month net change roll forward / backward.
//
// Anchor resolution itself (debt row vs. server-side `/api/amex/anchor`
// fallback) lives on the page because it depends on hooks and the
// Amex-specific debt-matching rules; this helper takes the already-
// resolved anchor as input.
import {
  compareMonth,
  monthKeyFromISO,
  monthKeyOf,
  type MonthKey,
} from "@/components/account-page";
import { computeBalanceAtEndOf } from "./accountBalance";

export type AmexTxnInput = {
  occurredOn: string;
  amount: string | number;
};

export type AmexAnchor = {
  balance: number;
  asOf: string | null;
};

/**
 * Build a `(target) => number | null` closure that returns the Amex
 * end-of-month balance at the end of any month. Returns `() => null`
 * when no anchor is available (e.g. no linked Amex debt and no saved
 * anchor on the server).
 *
 * Pre-computes `netChangeByMonth` and `anchorMonthTxns` once so the
 * Amex page can call it 12+ times for the trend chart without
 * re-walking the transaction list.
 */
export function makeAmexBalanceAtEndOf(args: {
  anchor: AmexAnchor | null;
  amexTransactions: ReadonlyArray<AmexTxnInput>;
  fallbackMonth?: MonthKey;
}): (target: MonthKey) => number | null {
  const { anchor, amexTransactions, fallbackMonth } = args;
  if (!anchor) return () => null;

  const anchorMonth = anchor.asOf
    ? monthKeyFromISO(anchor.asOf)
    : (fallbackMonth ?? monthKeyOf(new Date()));

  const netChangeByMonth = new Map<string, number>();
  for (const t of amexTransactions) {
    const mk = monthKeyFromISO(t.occurredOn);
    const k = `${mk.year}-${mk.month}`;
    netChangeByMonth.set(
      k,
      (netChangeByMonth.get(k) ?? 0) + (Number(t.amount) || 0),
    );
  }

  const anchorMonthTxns = amexTransactions.filter(
    (t) => compareMonth(monthKeyFromISO(t.occurredOn), anchorMonth) === 0,
  );

  return (target: MonthKey) =>
    computeBalanceAtEndOf({
      anchorBalance: anchor.balance,
      anchorMonth,
      netChangeByMonth,
      target,
      anchorAt: anchor.asOf,
      anchorMonthTxns,
    });
}

/**
 * Convenience one-shot: compute the Amex end-of-month balance for a
 * single target month identified by its `YYYY-MM-01` start string.
 * Intended for use by a future dashboard "Amex ending balance" tile so
 * it agrees with the Amex page's header for any month.
 */
export function computeAmexEndOfMonthBalance(args: {
  monthStart: string;
  anchor: AmexAnchor | null;
  amexTransactions: ReadonlyArray<AmexTxnInput>;
  fallbackMonth?: MonthKey;
}): number | null {
  const at = makeAmexBalanceAtEndOf({
    anchor: args.anchor,
    amexTransactions: args.amexTransactions,
    fallbackMonth: args.fallbackMonth,
  });
  return at(monthKeyFromISO(args.monthStart));
}
