import type { Debt } from "@workspace/api-client-react";
import type { SimDebt } from "@workspace/avalanche-core";
// (Dashboard refinement) From the `pendingDebt` sub-path, not the package
// index: the landing's debt tile imports this module, and the index would bring
// the whole payoff simulator into the entry chunk with it.
import {
  effectiveDebtBalance as effectiveDebtBalanceCore,
  inPayoffPopulation,
  pendingPaymentTotalOf as pendingPaymentTotalOfCore,
} from "@workspace/avalanche-core/pendingDebt";
import { cardOwedView, debtForAccount, type CardLiabilityInput } from "./cardBalance";

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

/** Within half a cent counts as cleared, the Debts page's own threshold. */
const CLEARED_EPSILON = 0.005;

/**
 * ⭐ THE ONE "WHAT IS LEFT" TOTAL: every debt on the payoff plan, netted of its
 * pending payments ({@link effectiveDebtBalance}). The Avalanche page's "Total
 * debt" Stat and Totals row, the Reports Debt page's hero (`totalsForDebts`)
 * and the dashboard's debt tile all call this, so the three cannot disagree.
 *
 * (WP4) "On the payoff plan" is `inPayoffPopulation` — active, with an anchor
 * (`originalBalance > 0`) — the SAME rule the spine's "% paid" uses, so the
 * landing's percentage and its "$X left" always measure the same debts. GET
 * /debts anchors every debt it returns (max of its history and its balance),
 * so the only active debt this leaves out is one anchored at $0.00, which "%
 * paid" already left out.
 */
export function remainingDebtTotal(debts: readonly Debt[] | null | undefined): number {
  let total = 0;
  for (const d of debts ?? []) {
    if (!inPayoffPopulation(d)) continue;
    total += effectiveDebtBalance(d);
  }
  return total;
}

/**
 * The total above plus the names it covers, so a surface that quotes the
 * amount can always say what it is the total OF. Names are the debts on the
 * plan still carrying a balance (a cleared one adds nothing, so naming it would
 * overstate the scope), in the payload's order.
 */
export function remainingDebtScope(debts: readonly Debt[] | null | undefined): {
  total: number;
  names: string[];
} {
  const names: string[] = [];
  for (const d of debts ?? []) {
    if (!inPayoffPopulation(d)) continue;
    if (Math.abs(effectiveDebtBalance(d)) < CLEARED_EPSILON) continue;
    names.push(d.name.trim() || "Unnamed debt");
  }
  return { total: remainingDebtTotal(debts), names };
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** A linked card that is NOT on the payoff plan, as the debt tile names it. */
export interface OffPlanCard {
  /** The account's internal row id. */
  id: string;
  /** The Accounts row's own name: "American Express Platinum Card® ••1005". */
  name: string;
  /** The weekly payoff bills it weekly (`AmexWeeklyPayoffCard.cadence`). */
  weekly: boolean;
}

/**
 * ⭐ (WP4) THE CARDS THE "$X LEFT" DOES NOT COVER, so the tile can say so: a
 * linked card with no debt row, or an archived one (`cardOwedView` state
 * `off_plan` / `archived`). A card whose own current balance is $0.00 is left
 * out (it changes nothing about the total); one whose balance is unknown is
 * kept (never assumed to be zero). Inputs already on the landing: the linked
 * cards, `GET /debts`, Plaid's stored liability figures (the Accounts panel's
 * own read) and, for the weekly word, the weekly payoff's cards. Pure.
 */
export function offPlanCards(
  cards: readonly { id: string; accountId: string; name: string }[],
  debts: readonly Debt[] | null | undefined,
  opts: { liabilities?: readonly CardLiabilityInput[] | null; weeklyAccountIds?: ReadonlySet<string> } = {},
): OffPlanCard[] {
  const out: OffPlanCard[] = [];
  for (const c of cards) {
    const debt = debtForAccount(debts, c);
    const v = cardOwedView({ debt, liability: (opts.liabilities ?? []).find((l) => l.id === c.id) });
    if (v.onPlan) continue;
    const bal = v.creditorCurrent?.balance;
    if (bal != null && Math.abs(bal) < CLEARED_EPSILON) continue;
    out.push({ id: c.id, name: c.name, weekly: !!opts.weeklyAccountIds?.has(c.accountId) });
  }
  return out;
}

/**
 * "American Express Platinum Card® ••1005 is paid in full weekly, not on the
 * plan" — "paid in full weekly" only when the weekly payoff bills every named
 * card weekly — and the link's words.
 */
export function offPlanWords(cards: readonly OffPlanCard[]): { text: string; link: string } | null {
  if (cards.length === 0) return null;
  const many = cards.length > 1;
  const weekly = cards.every((c) => c.weekly);
  return {
    text: `${joinNames(cards.map((c) => c.name))} ${many ? "are" : "is"} ${weekly ? "paid in full weekly, " : ""}not on the plan`,
    link: many ? "Put them on the plan" : "Put it on the plan",
  };
}
