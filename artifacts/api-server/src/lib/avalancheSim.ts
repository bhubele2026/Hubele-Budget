// Minimal server-side avalanche payoff simulator. Used by the Bills /
// Forecast / cash-signal endpoints to know how many months the user's
// "Avalanche extra payment" continues before all debts are predicted
// paid off. Mirrors the client-side `simulate()` (artifacts/h2budget/
// src/lib/avalanche.ts) — same rounding, same target-selection rule,
// same MAX_MONTHS guard — but trimmed to only the data we need here.

import { debtsTable } from "@workspace/db";

type DebtRow = typeof debtsTable.$inferSelect;

export type SimInputDebt = {
  id: string;
  apr: number;
  balance: number;
  minPayment: number;
};

const CENTS = 0.005;
const MAX_MONTHS = 600;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function targetIndex(rows: { balance: number; apr: number }[]): number {
  let bestIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.balance <= CENTS) continue;
    if (bestIdx === -1) {
      bestIdx = i;
      continue;
    }
    const best = rows[bestIdx];
    if (r.apr > best.apr || (r.apr === best.apr && r.balance < best.balance)) {
      bestIdx = i;
    }
  }
  return bestIdx;
}

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
  const work = debts
    .filter((d) => d.balance > CENTS && d.minPayment > 0)
    .map((d) => ({
      id: d.id,
      apr: d.apr,
      balance: d.balance,
      minPayment: d.minPayment,
    }));
  if (work.length === 0) return 0;
  const extra = Math.max(0, extraPerMonth || 0);

  for (let m = 1; m <= MAX_MONTHS; m++) {
    let pool = extra;
    for (const d of work) {
      if (d.balance <= CENTS) {
        pool += d.minPayment;
        continue;
      }
      const interest = round2(d.balance * (d.apr / 12));
      d.balance = round2(d.balance + interest);
      const pay = Math.min(d.minPayment, d.balance);
      d.balance = round2(d.balance - pay);
    }
    while (pool > CENTS) {
      const idx = targetIndex(work);
      if (idx === -1) break;
      const d = work[idx];
      const pay = Math.min(pool, d.balance);
      d.balance = round2(d.balance - pay);
      pool = round2(pool - pay);
    }
    if (work.every((d) => d.balance <= CENTS)) return m;
  }
  return null;
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
