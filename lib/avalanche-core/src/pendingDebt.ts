// ⭐ PENDING-AWARE DEBT BALANCE — moved verbatim from `index.ts` (which
// re-exports it), so a caller can import these without the rest of the
// package. See the long note above the re-export in `index.ts` for why the
// netting exists (Brad's call, 2026-08-23: net the pending payments everywhere).
// No dependency.

export type PendingAwareDebt = {
  balance: number | string;
  pendingPaymentTotal?: number | string | null;
};

/**
 * The portion of a debt's reported balance the user has already paid but the
 * creditor has not reported yet.
 */
export function pendingPaymentTotalOf(d: PendingAwareDebt): number {
  return d.pendingPaymentTotal != null ? Number(d.pendingPaymentTotal) || 0 : 0;
}

/**
 * (#421) Tagged checking-account payments to a debt show up immediately even
 * before the creditor reports the new balance via Plaid. We subtract any
 * pendingPaymentTotal from the reported balance so the avalanche math, the
 * totals, and the projected payoff dates reflect what the user has already
 * paid — clamped at zero so a tagging mistake can't push the balance below 0.
 */
export function effectiveDebtBalance(d: PendingAwareDebt): number {
  const reported = Number(d.balance) || 0;
  const pending = pendingPaymentTotalOf(d);
  return Math.max(0, reported - pending);
}
