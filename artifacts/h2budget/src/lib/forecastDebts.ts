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
 * Match each recurring item to a debt id (or none) so the Avalanche
 * "ends Mon YYYY" payoff badge / Bills payoff filter can stop the row
 * once the linked debt is killed by the simulation.
 *
 * Two passes only — both require evidence that the recurring item is
 * actually a debt payment:
 *   Pass 0 — explicit `debtId` on the recurring item wins (manual link
 *            from the Bills / Debts UI).
 *   Pass 1 — name overlap (normalized substring either direction,
 *            length >= 3). Catches the common case where the user
 *            named the bill after the debt ("Discover" recurring →
 *            "Discover" debt).
 *
 * An earlier pass that linked any unmatched recurring item to any
 * unlinked debt whose minimum payment was within $0.50 of the
 * recurring amount was removed: that misfired on bills like "State
 * Farm Insurance" whose monthly premium happens to equal a credit
 * card's minimum payment and inherited the wrong "ends Mon YYYY"
 * payoff badge. Coincidental dollar amounts are not a safe signal —
 * if a recurring item really is a debt payment and the names don't
 * match, the user should set the explicit `debtId` link.
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
  }));

  const activeDebtIds = new Set(activeDebts.map((d) => d.id));

  // Pass 0: explicit debtId on the recurring item wins.
  for (const r of activeRecur) {
    if (r.debtId && activeDebtIds.has(r.debtId)) {
      out.set(r.id, r.debtId);
    }
  }

  // Pass 1: name overlap (longest debt name wins on ties).
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
    // Synthetic debt-minimum events emitted by the server use an itemId of
    // the form `debt:<debtId>` (see expandDebtMin). Treat that as a direct
    // pointer to the debt so the payoff cutoff applies even when no
    // recurring item is linked. Otherwise fall back to the recurring-item
    // → debt link map.
    const debtId = ev.itemId.startsWith("debt:")
      ? ev.itemId.slice("debt:".length)
      : links.get(ev.itemId);
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

export type DebtMinRowLite = {
  debtId: string;
  nextOccurrence?: string | null;
};

/**
 * Hide a Bills page debt-minimum row when the avalanche simulation has
 * already killed that debt before the row's next due date. Mirrors the
 * Forecast page so the two views agree on which debts are still alive.
 *
 * Rules:
 *  - Debt missing from `payoffs` (still alive in the sim) → keep.
 *  - Row has no `nextOccurrence` (we don't know when it would fall) → keep.
 *  - Otherwise compare the row's next-due YYYY-MM against the payoff month
 *    and drop rows whose next due falls strictly after payoff.
 */
export function filterDebtMinRowsByPayoff<T extends DebtMinRowLite>(
  rows: T[],
  payoffs: Map<string, PayoffInfo>,
): T[] {
  return rows.filter((row) => {
    const payoff = payoffs.get(row.debtId);
    if (!payoff) return true;
    if (!row.nextOccurrence) return true;
    const nextYM = row.nextOccurrence.slice(0, 7);
    return nextYM <= payoff.payoffYM;
  });
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
