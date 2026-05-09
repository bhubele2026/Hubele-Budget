// (#475) Shared helper that computes the Chase end-of-month balance.
//
// Used by both the Chase Transactions page (its "Ending balance" header
// tile + the rolling balance / trend chart) and the dashboard's
// "Chase ending balance" tile, so the two surfaces always agree for
// any month — past, current, or future.
//
// Encapsulates:
//  - Anchor selection (caller supplies the effective snapshot from
//    `deriveEffectiveSnapshot` so per-account snapshot selection is
//    identical to the Chase page).
//  - Mid-month snapshot reconstruction
//    (`endOfAnchorMonth = snapshot + sum(post-snapshot anchor-month txns)`).
//  - Per-account transaction scoping + dedupe (mirrors the Chase
//    Transactions page).
import {
  compareMonth,
  monthKeyFromISO,
  type MonthKey,
} from "@/components/account-page";
import { computeBalanceAtEndOf } from "./accountBalance";
import {
  dedupeTransactionsByIdentity,
  isChaseFallbackSource,
} from "./chaseScope";
import type { EffectiveSnapshotEntry } from "./effectiveSnapshot";

export type ChaseTxnInput = {
  id: string;
  occurredOn: string;
  amount: string | number;
  plaidAccountId?: string | null;
  plaidTransactionId?: string | null;
  source?: string | null;
};

/**
 * Scope a raw transaction list down to the rows that belong on the
 * Chase Transactions page for the given Plaid checking account. When
 * no Plaid checking account is linked, falls back to the same
 * source-based predicate the Chase page uses (`isChaseFallbackSource`)
 * so the dashboard tile and the Chase page see the exact same set of
 * activity.
 *
 * (#462) `chasePlaidAccountId` accepts either a single id or a
 * `ReadonlySet<string>` of equivalent ids. The set form lets the page
 * collapse duplicate `plaid_accounts` rows for the same physical
 * account by (institutionName, mask) before scoping — matches the
 * Amex page's `amexDebt` collapse so a transaction that briefly
 * lands on a duplicate row id during a re-link still counts toward
 * the real account.
 */
export function scopeChaseTransactions<T extends ChaseTxnInput>(
  txns: ReadonlyArray<T>,
  chasePlaidAccountId: string | ReadonlySet<string> | null,
): T[] {
  let scoped: T[];
  if (chasePlaidAccountId === null) {
    scoped = txns.filter(
      (t) => !t.plaidAccountId && isChaseFallbackSource(t.source ?? null),
    );
  } else if (typeof chasePlaidAccountId === "string") {
    scoped = txns.filter((t) => t.plaidAccountId === chasePlaidAccountId);
  } else {
    const set = chasePlaidAccountId;
    if (set.size === 0) {
      scoped = txns.filter(
        (t) => !t.plaidAccountId && isChaseFallbackSource(t.source ?? null),
      );
    } else {
      scoped = txns.filter(
        (t) => !!t.plaidAccountId && set.has(t.plaidAccountId),
      );
    }
  }
  return dedupeTransactionsByIdentity(scoped);
}

/**
 * Build a `(target) => number | null` closure that returns the Chase
 * end-of-month balance at the end of any month. Returns `() => null`
 * when no effective snapshot is available (e.g. Manual account, or
 * Plaid account that has never been refreshed).
 *
 * Pre-computes `netChangeByMonth` and `anchorMonthTxns` once so the
 * Chase page can call it 12+ times for the trend chart without
 * re-walking the transaction list.
 */
export function makeChaseBalanceAtEndOf(args: {
  effectiveSnapshot: EffectiveSnapshotEntry | null;
  chaseTransactions: ReadonlyArray<ChaseTxnInput>;
}): (target: MonthKey) => number | null {
  const { effectiveSnapshot, chaseTransactions } = args;
  if (!effectiveSnapshot) return () => null;

  const anchorBalance = Number(effectiveSnapshot.balance) || 0;
  const anchorMonth = monthKeyFromISO(effectiveSnapshot.at);

  const netChangeByMonth = new Map<string, number>();
  for (const t of chaseTransactions) {
    const mk = monthKeyFromISO(t.occurredOn);
    const k = `${mk.year}-${mk.month}`;
    netChangeByMonth.set(
      k,
      (netChangeByMonth.get(k) ?? 0) + (Number(t.amount) || 0),
    );
  }

  const anchorMonthTxns = chaseTransactions.filter(
    (t) => compareMonth(monthKeyFromISO(t.occurredOn), anchorMonth) === 0,
  );

  return (target: MonthKey) =>
    computeBalanceAtEndOf({
      anchorBalance,
      anchorMonth,
      netChangeByMonth,
      target,
      anchorAt: effectiveSnapshot.at,
      anchorMonthTxns,
    });
}

/**
 * Convenience one-shot: compute the Chase end-of-month balance for a
 * single target month identified by its `YYYY-MM-01` start string.
 * Used by the dashboard's "Chase ending balance" tile.
 */
export function computeChaseEndOfMonthBalance(args: {
  monthStart: string;
  effectiveSnapshot: EffectiveSnapshotEntry | null;
  chaseTransactions: ReadonlyArray<ChaseTxnInput>;
}): number | null {
  const { monthStart, effectiveSnapshot, chaseTransactions } = args;
  const at = makeChaseBalanceAtEndOf({ effectiveSnapshot, chaseTransactions });
  return at(monthKeyFromISO(monthStart));
}
