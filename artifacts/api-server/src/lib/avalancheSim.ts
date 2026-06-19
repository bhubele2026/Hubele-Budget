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
