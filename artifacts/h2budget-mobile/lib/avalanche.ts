// VENDORED COPY of the shared isomorphic payoff engine.
//
// The web app and the API server both consume the SAME math from
// `lib/avalanche-core/src/index.ts` (`@workspace/avalanche-core`). The web
// re-exports it from `artifacts/h2budget/src/lib/avalanche.ts`; the server
// reuses `simulate` / `targetIndex` in `avalancheSim.ts`. This mobile app is a
// STANDALONE Expo project outside the pnpm workspace, so it cannot import the
// workspace package — instead we vendor a verbatim copy of the pure, DB-free
// math here. It is NOT a fork of business logic: household scoping, debt
// resolution, and the "extra" amount all still come from the API
// (GET /api/debts + GET /api/avalanche/settings). This file only mirrors the
// dashboard's read-only "next moves" projection so the home glance matches web.
//
// KEEP IN SYNC with lib/avalanche-core/src/index.ts if that engine changes.

import type { Debt, AvalancheSettings } from "./api";

export type Strategy = "avalanche" | "snowball";

export type SimDebt = {
  id: string;
  name: string;
  apr: number;
  balance: number;
  minPayment: number;
  status?: string;
};

type WorkDebt = {
  id: string;
  name: string;
  apr: number;
  balance: number;
  minPayment: number;
};

export type DebtKill = {
  id: string;
  name: string;
  apr: number;
  minFreed: number;
  date: Date;
  monthIndex: number;
};

export const CENTS = 0.005;
export const MAX_MONTHS = 600;

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function targetIndex(
  rows: { balance: number; apr: number }[],
  strat: Strategy,
): number {
  let bestIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.balance <= CENTS) continue;
    if (bestIdx === -1) {
      bestIdx = i;
      continue;
    }
    const best = rows[bestIdx];
    if (strat === "avalanche") {
      if (r.apr > best.apr || (r.apr === best.apr && r.balance < best.balance))
        bestIdx = i;
    } else {
      if (r.balance < best.balance || (r.balance === best.balance && r.apr > best.apr))
        bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Month-by-month payoff schedule. Mirrors the web dashboard's "kill order".
 * Returns only the fields the mobile home glance needs (the killed order +
 * months-to-freedom + debt-free date). Same math as the workspace engine.
 */
export function simulate(opts: {
  debts: SimDebt[];
  extraPerMonth: number;
  strategy: Strategy;
  startDate?: Date;
}): {
  monthsToFreedom: number;
  debtFreeDate: Date | null;
  startingTotalBalance: number;
  killedOrder: DebtKill[];
  ranOutOfTime: boolean;
} {
  const startDate =
    opts.startDate ??
    new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const extra = Math.max(0, opts.extraPerMonth || 0);

  const work: WorkDebt[] = opts.debts
    .filter((d) => (d.status ?? "active") === "active" && d.balance > CENTS)
    .map((d) => ({
      id: d.id,
      name: d.name,
      apr: d.apr,
      balance: d.balance,
      minPayment: d.minPayment,
    }));

  const startingTotalBalance = round2(
    work.reduce((s, d) => s + d.balance, 0),
  );
  const killedOrder: DebtKill[] = [];
  const months: { date: Date; totalBalanceEnd: number }[] = [];

  for (let m = 1; m <= MAX_MONTHS; m++) {
    const remaining = work.filter((d) => d.balance > CENTS);
    if (remaining.length === 0) break;

    const date = new Date(
      startDate.getFullYear(),
      startDate.getMonth() + (m - 1),
      1,
    );

    const startBalances = work.map((d) => d.balance);

    // 1. Accrue interest.
    for (const d of work) {
      if (d.balance <= CENTS) continue;
      const interest = round2(d.balance * (d.apr / 12));
      d.balance = round2(d.balance + interest);
    }

    // 2. Pay minimums; freed minimums of dead debts spill into the pool.
    let pool = extra;
    for (const d of work) {
      if (d.balance <= CENTS) {
        pool += d.minPayment;
        continue;
      }
      const pay = Math.min(d.minPayment, d.balance);
      d.balance = round2(d.balance - pay);
    }

    // 3. Cascade extra into the strategy target(s).
    while (pool > CENTS) {
      const idx = targetIndex(work, opts.strategy);
      if (idx === -1) break;
      const d = work[idx];
      const pay = Math.min(pool, d.balance);
      d.balance = round2(d.balance - pay);
      pool = round2(pool - pay);
    }

    // 4. Record kills.
    for (let i = 0; i < work.length; i++) {
      const d = work[i];
      const wasAlive = startBalances[i] > CENTS;
      const already = killedOrder.some((k) => k.id === d.id);
      if (wasAlive && d.balance <= CENTS && !already) {
        killedOrder.push({
          id: d.id,
          name: d.name,
          apr: d.apr,
          minFreed: d.minPayment,
          date,
          monthIndex: m,
        });
      }
    }

    const totalBalanceEnd = round2(work.reduce((s, d) => s + d.balance, 0));
    months.push({ date, totalBalanceEnd });
    if (totalBalanceEnd <= CENTS) break;
  }

  const last = months[months.length - 1];
  const ranOutOfTime =
    months.length === MAX_MONTHS && (last?.totalBalanceEnd ?? 0) > CENTS;
  const monthsToFreedom = ranOutOfTime ? Infinity : months.length;
  const debtFreeDate =
    ranOutOfTime || months.length === 0 ? null : last.date;

  return {
    monthsToFreedom,
    debtFreeDate,
    startingTotalBalance,
    killedOrder,
    ranOutOfTime,
  };
}

export type NextMove = {
  id: string;
  name: string;
  apr: number;
  balance: number;
  minFreed: number;
  date: Date;
};

/**
 * Mirrors the web dashboard's <DashboardKillOrder>: runs the avalanche
 * projection over the API's active debts + the household's "extra/mo" and
 * returns the next N debts in kill order. Read-only — no writes, no business
 * logic forked. Returns `[]` when there are no active debts.
 */
export function nextMoves(
  debts: Debt[] | undefined,
  settings: AvalancheSettings | undefined,
  count = 3,
): NextMove[] {
  const simDebts: SimDebt[] = (debts ?? [])
    .map((d) => ({
      id: d.id,
      name: d.name,
      apr: Number(d.apr),
      balance: Number(d.balance),
      minPayment: Number(d.minPayment),
      status: d.status,
    }))
    .filter((d) => (d.status ?? "active") === "active");
  if (simDebts.length === 0) return [];

  const strategy: Strategy =
    settings?.strategy === "snowball" ? "snowball" : "avalanche";
  const manualExtra = Number(settings?.manualExtra ?? 0);

  const sim = simulate({
    debts: simDebts,
    extraPerMonth: manualExtra,
    strategy,
  });
  const byId = new Map(simDebts.map((d) => [d.id, d]));
  return sim.killedOrder.slice(0, count).map((k) => {
    const d = byId.get(k.id)!;
    return {
      id: k.id,
      name: d.name,
      apr: d.apr,
      balance: d.balance,
      minFreed: k.minFreed,
      date: k.date,
    };
  });
}
