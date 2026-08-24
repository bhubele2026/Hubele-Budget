import type { Debt } from "@workspace/api-client-react";
import type { SimDebt } from "@workspace/avalanche-core";
import {
  effectiveDebtBalance as effectiveDebtBalanceCore,
  pendingPaymentTotalOf as pendingPaymentTotalOfCore,
} from "@workspace/avalanche-core";

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
 * ⚠️ (C10) THE MATH ITSELF NOW LIVES IN `@workspace/avalanche-core`, and this
 * module is a thin, `Debt`-typed façade over it. It moved because the SERVER
 * has the same disagreement: `/api/spine`'s `debt.payoffPct` (the landing's
 * "% paid" and the Avalanche hero) and `/api/dashboard`'s `totalDebt` (the
 * Reports "Total Debt" tile) were summing raw balances in SQL while these
 * pages netted. Client and server now share ONE implementation instead of two
 * that agree only until someone edits one of them.
 *
 * ⚠️ Nothing here is new math. Every re-export below is the #421 helper
 * verbatim, one indirection further away.
 */

/**
 * The portion of a debt's reported balance the user has already paid but the
 * creditor has not reported yet — server-computed, rides on the Debt payload.
 */
export function pendingPaymentTotalOf(d: Debt): number {
  return pendingPaymentTotalOfCore(d);
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
  return effectiveDebtBalanceCore(d);
}

/**
 * ⭐ THE ONE `Debt` → `SimDebt` MAPPER.
 *
 * ⚠️ This existed as THREE hand-copied functions — `pages/avalanche.tsx`,
 * `pages/debts.tsx`, and `lib/reportsAnalytics.ts` — identical but for the one
 * line that matters: the first two netted, and the Reports one did not. That
 * is why the Reports Debt page projected a different debt-free date than the
 * Avalanche page for the same household, off the same `/debts` payload. One
 * copy cannot drift from itself.
 *
 * Every payoff simulation in the app enters through here, so the sim, the
 * per-debt bars, the countdowns and the projected dates all share a basis.
 */
export function debtToSim(d: Debt): SimDebt {
  return {
    id: d.id,
    name: d.name,
    apr: Number(d.apr),
    balance: effectiveDebtBalance(d),
    minPayment: Number(d.minPayment),
    status: d.status,
  };
}
