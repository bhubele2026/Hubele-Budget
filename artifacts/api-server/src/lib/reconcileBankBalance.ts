/**
 * ⭐ DOES OUR LEDGER EXPLAIN THE BANK'S BALANCE?
 *
 * The app holds two independent accounts of the same money: a snapshot anchor
 * plus every transaction we have since it, and — on a manual Sync — whatever
 * Plaid says the bank actually holds right now. Until 2026-08-25 nothing
 * compared them, so a row that never arrived simply made every screen read low
 * and said nothing about it.
 *
 * That is not a hypothetical. A deposit landed on a Friday, Plaid's cursor
 * advanced past it, and the app was $169.90 light on Home, Reports and the
 * Chase page for four days. Both halves were individually plausible; only the
 * comparison was missing.
 *
 * Pure arithmetic, no I/O — the caller supplies the two sides.
 */
export interface BankReconciliation {
  /** The anchor rolled forward through our rows: what our records predict. */
  predicted: number;
  /** bank − predicted. Positive: the bank holds money our rows cannot explain. */
  unexplained: number;
  /** True when the two sides differ by a cent or more. */
  drifted: boolean;
}

/** Below this, the difference is float noise rather than a missing row. */
export const RECONCILE_EPSILON = 0.01;

/**
 * How stale an anchor may be and still produce a meaningful signal. An ancient
 * anchor accumulates every historical gap at once: technically true, useless as
 * an alert, and the fastest way to teach someone to ignore a warning.
 */
export const RECONCILE_MAX_ANCHOR_AGE_DAYS = 45;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function reconcileBankBalance(args: {
  /** `bank_snapshot_balance` as it stood before this sync. */
  anchorBalance: number;
  /** Net of every ledger row on the account dated after the anchor day. */
  ledgerNetSinceAnchor: number;
  /** Plaid's live `available` for that same account. */
  bankAvailable: number;
}): BankReconciliation {
  const predicted = round2(args.anchorBalance + args.ledgerNetSinceAnchor);
  const unexplained = round2(args.bankAvailable - predicted);
  return {
    predicted,
    unexplained,
    drifted: Math.abs(unexplained) >= RECONCILE_EPSILON,
  };
}

/**
 * Is this anchor recent enough for the comparison to mean anything?
 * A future-dated anchor (clock skew) is also refused — it would compare against
 * rows that have not happened yet.
 */
export function anchorIsReconcilable(
  anchorAt: Date | string,
  now: Date = new Date(),
): boolean {
  const ageDays =
    (now.getTime() - new Date(anchorAt).getTime()) / 86_400_000;
  return ageDays >= 0 && ageDays <= RECONCILE_MAX_ANCHOR_AGE_DAYS;
}
