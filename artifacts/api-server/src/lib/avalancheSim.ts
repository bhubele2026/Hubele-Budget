// Minimal server-side avalanche payoff helpers. Used by the Bills /
// Forecast / cash-signal endpoints to know how many months the user's
// "Avalanche extra payment" continues before all debts are predicted
// paid off. The simulation math itself now lives in the shared, isomorphic
// @workspace/avalanche-core engine (the same one the client uses), so the
// rounding, target-selection rule, and MAX_MONTHS guard cannot drift apart.
// This module keeps only the DB-coupled glue (DebtRow → sim input shape).

import { debtsTable } from "@workspace/db";
import {
  simulate,
  simulateMinimumsOnly,
  round2,
  CENTS,
  targetIndex,
  type SimDebt,
  type Strategy,
} from "@workspace/avalanche-core";

type DebtRow = typeof debtsTable.$inferSelect;

export type SimInputDebt = {
  id: string;
  apr: number;
  balance: number;
  minPayment: number;
};

const AVALANCHE: Strategy = "avalanche";

/**
 * Run the avalanche simulation for `debts` with `extraPerMonth` of extra
 * applied to the highest-APR live debt each month. Returns the number of
 * months until ALL debts are paid off, or `null` when the simulation
 * doesn't converge within MAX_MONTHS (e.g. underwater debts).
 *
 * `null` callers should treat as "still active forever in our horizon".
 */
export function monthsUntilAvalanchePayoff(
  debts: SimInputDebt[],
  extraPerMonth: number,
): number | null {
  // Same pre-filter the server has always applied: a debt only participates
  // if it has a live balance AND a positive minimum payment.
  const work: SimDebt[] = debts
    .filter((d) => d.balance > CENTS && d.minPayment > 0)
    .map((d) => ({
      id: d.id,
      name: d.id,
      apr: d.apr,
      balance: d.balance,
      minPayment: d.minPayment,
    }));
  if (work.length === 0) return 0;

  const sim = simulate({
    debts: work,
    extraPerMonth,
    strategy: AVALANCHE,
  });
  if (sim.ranOutOfTime) return null;
  return sim.monthsToFreedom;
}

/**
 * (#826) Resolve the debt the avalanche is currently attacking — the
 * highest-APR active debt with a positive balance (ties broken by
 * smaller balance), using the same `targetIndex` rule the simulator
 * applies each month. Returns null when no active debt has a balance.
 */
export function resolveAvalancheTargetDebt(
  debts: DebtRow[],
): { id: string; name: string; apr: number; balance: number } | null {
  const active = debts.filter(
    (d) => (d.status ?? "active") === "active" && Number(d.balance) > CENTS,
  );
  if (active.length === 0) return null;
  const idx = targetIndex(
    active.map((d) => ({
      balance: Number(d.balance) || 0,
      apr: Number(d.apr) || 0,
    })),
    AVALANCHE,
  );
  if (idx === -1) return null;
  const d = active[idx];
  return {
    id: d.id,
    name: d.name,
    apr: Number(d.apr) || 0,
    balance: Number(d.balance) || 0,
  };
}

/**
 * (Fable 5 narrative enrichment) Deterministic payoff facts derived from the
 * shared @workspace/avalanche-core engine — the SAME math the client and the
 * rest of the server use. Feeds the Avalanche narrative prompt with "how long
 * until debt-free" + "interest/months saved vs minimums-only" so the model can
 * narrate (never compute) the payoff picture.
 *
 * Pure computation, never throws: unconvergent (underwater) sims yield null
 * months / date and 0 savings rather than an error.
 */
export interface AvalanchePayoffFacts {
  strategy: Strategy;
  totalDebt: number;
  // null when the plan never pays off within the sim horizon (underwater).
  monthsToFreedom: number | null;
  debtFreeDate: string | null; // ISO YYYY-MM-DD, or null
  totalInterestProjected: number;
  // Minimums-only baseline (no extra, no freed-minimum cascade).
  minOnlyMonthsToFreedom: number | null;
  minOnlyTotalInterest: number | null;
  // Plan vs minimums-only. 0 / null when either side doesn't converge.
  interestSavedVsMin: number;
  monthsSavedVsMin: number | null;
  ranOutOfTime: boolean;
  underwater: boolean;
}

/** ISO YYYY-MM-DD from a Date, using local calendar fields (dates are 1st-of-month). */
function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Compute payoff facts for the household's active debts under `strategy` with
 * `extraPerMonth` of avalanche extra applied. Reuses `simulate` +
 * `simulateMinimumsOnly` from the shared engine — no bespoke math here.
 */
export function computeAvalanchePayoffFacts(
  debts: DebtRow[],
  strategy: Strategy,
  extraPerMonth: number,
): AvalanchePayoffFacts {
  // Same participation filter the sim itself applies (live balance + positive
  // minimum), so totalDebt matches the balances that actually drive payoff.
  const work: SimDebt[] = debts
    .filter(
      (d) =>
        (d.status ?? "active") === "active" &&
        Number(d.balance) > CENTS &&
        Number(d.minPayment) > 0,
    )
    .map((d) => ({
      id: d.id,
      name: d.name,
      apr: Number(d.apr) || 0,
      balance: Number(d.balance) || 0,
      minPayment: Number(d.minPayment) || 0,
    }));

  const totalDebt = round2(work.reduce((s, d) => s + d.balance, 0));

  if (work.length === 0) {
    return {
      strategy,
      totalDebt: 0,
      monthsToFreedom: 0,
      debtFreeDate: null,
      totalInterestProjected: 0,
      minOnlyMonthsToFreedom: 0,
      minOnlyTotalInterest: 0,
      interestSavedVsMin: 0,
      monthsSavedVsMin: 0,
      ranOutOfTime: false,
      underwater: false,
    };
  }

  const sim = simulate({ debts: work, extraPerMonth, strategy });
  const minOnly = simulateMinimumsOnly({ debts: work, strategy });

  const monthsToFreedom = sim.ranOutOfTime ? null : sim.monthsToFreedom;
  const minOnlyMonthsToFreedom = minOnly.ranOutOfTime
    ? null
    : minOnly.monthsToFreedom;

  const interestSavedVsMin =
    !sim.ranOutOfTime && !minOnly.ranOutOfTime
      ? Math.max(0, round2(minOnly.totalInterestPaid - sim.totalInterestPaid))
      : 0;
  const monthsSavedVsMin =
    monthsToFreedom != null && minOnlyMonthsToFreedom != null
      ? Math.max(0, minOnlyMonthsToFreedom - monthsToFreedom)
      : null;

  return {
    strategy,
    totalDebt,
    monthsToFreedom,
    debtFreeDate: sim.debtFreeDate ? toISODate(sim.debtFreeDate) : null,
    totalInterestProjected: round2(sim.totalInterestPaid),
    minOnlyMonthsToFreedom,
    minOnlyTotalInterest: minOnly.ranOutOfTime
      ? null
      : round2(minOnly.totalInterestPaid),
    interestSavedVsMin,
    monthsSavedVsMin,
    ranOutOfTime: sim.ranOutOfTime,
    underwater: sim.underwater.length > 0,
  };
}

/** Convert DB debt rows to the simulator input shape, filtering inactive. */
export function activeSimDebts(debts: DebtRow[]): SimInputDebt[] {
  const out: SimInputDebt[] = [];
  for (const d of debts) {
    if ((d.status ?? "active") !== "active") continue;
    const balance = Number(d.balance) || 0;
    if (balance <= CENTS) continue;
    const minPayment = Number(d.minPayment) || 0;
    if (minPayment <= 0) continue;
    out.push({
      id: d.id,
      apr: Number(d.apr) || 0,
      balance,
      minPayment,
    });
  }
  return out;
}
