import type { Debt } from "@workspace/api-client-react";

/**
 * ⭐ THE ONE DEBT-BALANCE BASIS FOR THE WHOLE APP.
 *
 * This function was file-local inside `pages/avalanche.tsx`, which is exactly
 * why the app could disagree with itself: the Avalanche page netted tagged-
 * but-unposted payments out of every balance it showed, and the Debts page —
 * reading the same `GET /api/debts` payload — rendered the raw posted number.
 * The same card read two different amounts on two screens, and because the
 * netted balance also feeds the payoff simulation, the two pages projected
 * different payoff months for the same debt.
 *
 * Brad's call (2026-08-23): **net the pending payments everywhere.** Moving the
 * function here — body unchanged — is what makes "everywhere" enforceable
 * instead of aspirational. Import it; never re-derive a balance inline.
 *
 * ⚠️ Nothing here is new math. `effectiveDebtBalance` is the #421 helper
 * verbatim; `pendingPaymentTotalOf` is the identical field-parse that used to
 * be written out twice (once inside the helper, once inline in the Avalanche
 * page's "pending" hint), factored so a future edit cannot change one copy and
 * miss the other.
 */

/**
 * The portion of a debt's reported balance the user has already paid but the
 * creditor has not reported yet — server-computed, rides on the Debt payload.
 */
export function pendingPaymentTotalOf(d: Debt): number {
  return d.pendingPaymentTotal != null ? Number(d.pendingPaymentTotal) || 0 : 0;
}

/** How many tagged payments make up {@link pendingPaymentTotalOf}. */
export function pendingPaymentCountOf(d: Debt): number {
  return d.pendingPaymentCount ?? 0;
}

/**
 * (#421) Tagged checking-account payments to a debt show up immediately even
 * before the creditor reports the new balance via Plaid. We subtract any
 * pendingPaymentTotal from the reported balance so the avalanche math, the
 * totals, and the projected payoff dates reflect what the user has already
 * paid — clamped at zero so a tagging mistake can't push the balance below 0.
 */
export function effectiveDebtBalance(d: Debt): number {
  const reported = Number(d.balance) || 0;
  const pending = pendingPaymentTotalOf(d);
  return Math.max(0, reported - pending);
}
