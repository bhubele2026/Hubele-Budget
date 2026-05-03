import type { CashEvent } from "./forecast";
import type { SimResult } from "./avalanche";

export type DebtLite = {
  id: string;
  name: string;
  minPayment: string | number;
  status?: string;
};

export type RecurringLite = {
  id: string;
  name: string;
  amount: string | number;
  kind: string;
  active: string | boolean;
  debtId?: string | null;
};

export type PayoffInfo = {
  debtId: string;
  debtName: string;
  payoffDate: Date;
  payoffYM: string;
  lastMinPaid: number;
};

function normalize(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isActiveRecurring(r: RecurringLite): boolean {
  return typeof r.active === "boolean" ? r.active : r.active === "true";
}

function ymOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Heuristic match: each recurring item -> debt id (or none).
 * Prefer name match (normalized substring either direction, length >= 3).
 * Fallback to amount match where recurring amount == debt minPayment within $0.50,
 * but only if the debt has no name-matched recurring item already.
 */
export function linkRecurringToDebts(
  debts: DebtLite[],
  recurring: RecurringLite[],
): Map<string, string> {
  const out = new Map<string, string>();
  const activeDebts = debts.filter((d) => (d.status ?? "active") === "active");
  const activeRecur = recurring.filter(
    (r) => isActiveRecurring(r) && r.kind !== "income",
  );

  const debtNorms = activeDebts.map((d) => ({
    debt: d,
    norm: normalize(d.name),
    min: Math.abs(Number(d.minPayment) || 0),
  }));

  const matchedDebtIds = new Set<string>();
  const activeDebtIds = new Set(activeDebts.map((d) => d.id));

  // Pass 0: explicit debtId on the recurring item wins.
  for (const r of activeRecur) {
    if (r.debtId && activeDebtIds.has(r.debtId)) {
      out.set(r.id, r.debtId);
      matchedDebtIds.add(r.debtId);
    }
  }

  // Pass 1: name match
  for (const r of activeRecur) {
    if (out.has(r.id)) continue;
    const rn = normalize(r.name);
    if (rn.length < 3) continue;
    let best: (typeof debtNorms)[number] | null = null;
    for (const d of debtNorms) {
      if (d.norm.length < 3) continue;
      if (rn.includes(d.norm) || d.norm.includes(rn)) {
        if (!best || d.norm.length > best.norm.length) best = d;
      }
    }
    if (best) {
      out.set(r.id, best.debt.id);
      matchedDebtIds.add(best.debt.id);
    }
  }

  // Pass 2: amount match for debts not yet linked
  for (const r of activeRecur) {
    if (out.has(r.id)) continue;
    const ramt = Math.abs(Number(r.amount) || 0);
    if (ramt <= 0) continue;
    const candidates = debtNorms.filter(
      (d) => !matchedDebtIds.has(d.debt.id) && Math.abs(d.min - ramt) <= 0.5,
    );
    if (candidates.length === 1) {
      out.set(r.id, candidates[0].debt.id);
      matchedDebtIds.add(candidates[0].debt.id);
    }
  }

  return out;
}

/**
 * For each debt killed in the simulation, return its payoff month and the
 * actual minimum-payment amount paid in that final month (which can be less
 * than the full minimum if the debt was wiped out mid-month).
 */
export function computePayoffsByDebt(sim: SimResult): Map<string, PayoffInfo> {
  const out = new Map<string, PayoffInfo>();
  for (const k of sim.killedOrder) {
    const month = sim.months.find((m) => m.monthIndex === k.monthIndex);
    const snap = month?.perDebt.find((p) => p.id === k.id);
    out.set(k.id, {
      debtId: k.id,
      debtName: k.name,
      payoffDate: k.date,
      payoffYM: ymOf(k.date),
      lastMinPaid: snap ? snap.minPaid : 0,
    });
  }
  return out;
}

/**
 * Filter and adjust forecast events based on Avalanche payoff dates.
 * - Drops debt-linked events strictly after the debt's payoff month.
 * - In the payoff month, replaces the event amount with the actual minimum
 *   paid (sign-preserving) when the simulation paid off the debt for less
 *   than the full minimum.
 * - Non-debt events are returned unchanged.
 */
export function filterEventsByPayoff(
  events: CashEvent[],
  links: Map<string, string>,
  payoffs: Map<string, PayoffInfo>,
): CashEvent[] {
  const out: CashEvent[] = [];
  for (const ev of events) {
    const debtId = links.get(ev.itemId);
    if (!debtId) {
      out.push(ev);
      continue;
    }
    const payoff = payoffs.get(debtId);
    if (!payoff) {
      // Debt didn't pay off in the simulation horizon — keep event as-is.
      out.push(ev);
      continue;
    }
    const evYM = ev.date.slice(0, 7);
    if (evYM > payoff.payoffYM) continue; // dropped — after payoff
    if (evYM === payoff.payoffYM) {
      const fullAmt = Math.abs(ev.amount);
      if (payoff.lastMinPaid > 0 && payoff.lastMinPaid < fullAmt - 0.005) {
        const sign = ev.amount < 0 ? -1 : 1;
        out.push({ ...ev, amount: sign * Math.round(payoff.lastMinPaid * 100) / 100 });
        continue;
      }
    }
    out.push(ev);
  }
  return out;
}

export type PayoffTransition = {
  debtId: string;
  debtName: string;
  freedAmount: number;
  payoffYM: string;
  payoffDate: Date;
};

/**
 * For each payoff month, list the debts paid off and the recurring monthly
 * cash that frees up afterward (sum of linked recurring item amounts).
 */
export function computePayoffTransitions(
  links: Map<string, string>,
  payoffs: Map<string, PayoffInfo>,
  recurring: RecurringLite[],
): Map<string, PayoffTransition[]> {
  const sumByDebt = new Map<string, number>();
  for (const r of recurring) {
    if (!isActiveRecurring(r) || r.kind === "income") continue;
    const debtId = links.get(r.id);
    if (!debtId) continue;
    const amt = Math.abs(Number(r.amount) || 0);
    if (amt <= 0) continue;
    sumByDebt.set(debtId, (sumByDebt.get(debtId) ?? 0) + amt);
  }
  const out = new Map<string, PayoffTransition[]>();
  for (const [debtId, p] of payoffs.entries()) {
    const freed = sumByDebt.get(debtId) ?? 0;
    if (freed <= 0) continue;
    const arr = out.get(p.payoffYM) ?? [];
    arr.push({
      debtId,
      debtName: p.debtName,
      freedAmount: freed,
      payoffYM: p.payoffYM,
      payoffDate: p.payoffDate,
    });
    out.set(p.payoffYM, arr);
  }
  return out;
}

/** Build a per-recurring-item lookup of payoff info, for badge rendering. */
export function payoffByRecurringItem(
  links: Map<string, string>,
  payoffs: Map<string, PayoffInfo>,
): Map<string, PayoffInfo> {
  const out = new Map<string, PayoffInfo>();
  for (const [itemId, debtId] of links.entries()) {
    const p = payoffs.get(debtId);
    if (p) out.set(itemId, p);
  }
  return out;
}
