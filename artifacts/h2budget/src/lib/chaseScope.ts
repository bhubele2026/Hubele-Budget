import {
  compareMonth,
  monthKeyFromISO,
  type MonthKey,
} from "@/components/account-page";

/**
 * Source values that belong on the Chase Transactions page when no Plaid
 * checking account is linked yet (or when the linked account's id hasn't
 * been backfilled onto rows yet, e.g. immediately after a re-link).
 *
 * Mirrors the `AMEX_SOURCES = ["amex", "plaid:amex"]` pattern in
 * `pages/amex.tsx`. We deliberately also accept `"manual"` here because
 * the fallback is the same surface manual entries have always shown up
 * on for users who never linked a bank.
 */
export const CHASE_FALLBACK_SOURCES = ["manual", "chase", "plaid:chase"] as const;

/**
 * True when a row should appear on the Chase page in the "no Plaid
 * checking linked" fallback. Rows whose `plaidAccountId` is set are
 * always considered to belong to a specific Plaid account and so are
 * filtered by id elsewhere — this helper only governs the source-based
 * fallback. We keep the predicate tolerant of unknown / empty source
 * values so legacy manual rows (which sometimes have an empty source)
 * still survive.
 */
export function isChaseFallbackSource(
  source: string | null | undefined,
): boolean {
  if (!source) return true;
  const s = source.toLowerCase();
  return (CHASE_FALLBACK_SOURCES as readonly string[]).includes(s);
}

/**
 * Collapse a transaction list down to one row per logical transaction.
 *
 * The Chase page (#443) was double-counting May 2026 activity because the
 * Plaid dedupe work in #429/#408 left the on-disk data with occasional
 * duplicate rows (e.g. the same `plaid_transaction_id` carried by two
 * survivor rows after a re-link). Counting those twice in `monthTotals`
 * inflates Money in / Money out, which then poisons Starting balance via
 * the snapshot-anchored `Ending − netChange(May)` math.
 *
 * Identity rules, in order:
 *  - If `plaidTransactionId` is present, dedupe on that value (Plaid's
 *    own stable id — guaranteed unique per real transaction).
 *  - Otherwise fall back to the row's own `id` (uuid), which is unique
 *    by construction and protects manual rows.
 *
 * Order is preserved: the first occurrence of each key wins so callers
 * still see the row they expect when iterating in input order.
 */
export function dedupeTransactionsByIdentity<T extends { id: string }>(
  txns: ReadonlyArray<T>,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const t of txns) {
    const ptx = (t as { plaidTransactionId?: string | null }).plaidTransactionId;
    const key = ptx ? `ptx:${ptx}` : `id:${t.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * Compute the Money in / Money out / Net change tile values for a
 * single calendar month, from a transaction list that has already been
 * scoped to one account.
 *
 * The function is the source of truth for the bubble math on the Chase
 * Transactions page. It re-applies the month filter itself (rather than
 * trusting the caller) so we cannot accidentally regress to counting
 * rows whose `occurredOn` falls outside `selectedMonth`.
 */
export function chaseMonthTotals<
  T extends { occurredOn: string; amount: string | number },
>(
  txns: ReadonlyArray<T>,
  selectedMonth: MonthKey,
): { moneyIn: number; moneyOut: number; netChange: number } {
  let moneyIn = 0;
  let moneyOut = 0;
  for (const t of txns) {
    const mk = monthKeyFromISO(t.occurredOn);
    if (compareMonth(mk, selectedMonth) !== 0) continue;
    const a = Number(t.amount) || 0;
    if (a >= 0) moneyIn += a;
    else moneyOut += a;
  }
  const netChange = moneyIn + moneyOut;
  return { moneyIn, moneyOut: Math.abs(moneyOut), netChange };
}
