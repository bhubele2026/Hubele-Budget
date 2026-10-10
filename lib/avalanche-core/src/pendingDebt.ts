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

/**
 * ⭐ (WP4b) THE DEBTS ON THE PAYOFF PLAN: every ACTIVE debt — one population for
 * every figure ("$X left" and the names it covers, the Avalanche rows and their
 * Totals, "% paid", the milestones), so no figure drops money another counts.
 * An archived debt (paid off, or taken off the plan) is out of all of them. A
 * missing status reads as active, as the plan's other filters read it (the
 * server always sends one).
 *
 * History: WP4 also required an anchor (`originalBalance > 0`). The anchor is
 * written only while it is null, so a card put on the plan while it read $0.00
 * kept "0.00" after Plaid raised its balance — and dropped out of "$X left"
 * while the Accounts row, the Avalanche table and Reports still counted it.
 * (Before WP4 the filter was `status !== "paid_off"`, which nothing writes, so
 * every archived debt counted.)
 */
export function inPayoffPopulation(d: { status?: string | null }): boolean {
  return (d.status ?? "active") === "active";
}

/**
 * ⭐ (WP4b) WHAT A DEBT'S "% PAID" IS MEASURED AGAINST: the larger of its anchor
 * (`originalBalance`) and what it owes now, netted ({@link effectiveDebtBalance}).
 * A debt that owes more than its anchor — put on the plan at $0.00, or charged
 * back up past it — is 0% paid of what it owes now: in the figure, never dropped
 * and never negative. 0 for a debt that owes nothing and has no anchor.
 * Stored anchors are never rewritten; this is only how they are read.
 */
export function payoffBasisOf(d: PendingAwareDebt & { originalBalance?: number | string | null }): number {
  return Math.max(Math.max(0, Number(d.originalBalance ?? 0) || 0), effectiveDebtBalance(d));
}
