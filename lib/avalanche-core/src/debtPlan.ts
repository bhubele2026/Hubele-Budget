// (PR-D) The debt plan: strategies compared, a debt-free RANGE (never one
// date), and the milestones on the way. Pure: no I/O, no clock unless the
// caller omits a start month.
//
// Everything here is a reading of `simulate` (index.ts) — the one payoff
// engine the client and the server share. Nothing re-implements a month of
// interest or a payment: compareStrategies runs it twice, debtFreeRange three
// times, milestonesFor reads a run's own months.
//
// ⚠️ NEVER AN EXACT PAYOFF DATE. A payoff month depends on minimums, the extra
// actually paid and new charges — all of which move. Callers expose months
// (`YYYY-MM`) and a range, and every result carries the assumptions it rests on.

import {
  CENTS,
  round2,
  simulate,
  type SimDebt,
  type SimResult,
  type Strategy,
} from "./index";
import { inPayoffPopulation } from "./pendingDebt";

/**
 * A debt as the plan reads it: the simulator's fields plus where each figure
 * came from (`*_source` on `debts`), its anchor and its type. Balances are the
 * NETTED balance (`effectiveDebtBalance`) — the caller nets before it calls.
 */
export type PlanDebt = SimDebt & {
  minPaymentSource?: string | null;
  aprSource?: string | null;
  balanceSource?: string | null;
  /** `debts.original_balance` — the anchor `payoffPct` measures against. */
  originalBalance?: number | null;
  /** `debts.type` (e.g. `credit_card`, `loan`), null when never set. */
  type?: string | null;
};

export type StrategySummary = {
  /** Months until every debt is at $0; null when the plan never gets there (MAX_MONTHS). */
  monthsToFreedom: number | null;
  /** `YYYY-MM` of the last payment month; null when it never gets there. */
  debtFreeMonth: string | null;
  /** Interest paid on the way; null when the plan never finishes (the sum would be meaningless). */
  totalInterest: number | null;
  /** The first debt the plan pays off, and the month. */
  firstKill: { debtId: string; month: string } | null;
};

export type StrategyComparison = {
  avalanche: StrategySummary;
  snowball: StrategySummary;
  /**
   * Snowball minus avalanche: positive months / interest is what avalanche
   * saves. Null when either side never finishes.
   */
  delta: { months: number | null; interest: number | null };
  /** Per debt: the month each strategy pays it off (null = not inside MAX_MONTHS). */
  killMonths: Array<{ debtId: string; avalanche: string | null; snowball: string | null }>;
};

export type PlanAssumption = { key: string; text: string };

export type DebtFreeRange = {
  /** Earliest debt-free month across the three runs; null when none finishes. */
  earliestMonth: string | null;
  /** Latest debt-free month; null when ANY run never finishes (open-ended). */
  latestMonth: string | null;
  interestLow: number | null;
  /** Null when any run never finishes. */
  interestHigh: number | null;
  /** The three runs, in order: plan as set, half the extra, plan plus new charges. */
  runs: Array<{ key: "base" | "half_extra" | "new_charges"; debtFreeMonth: string | null; totalInterest: number | null }>;
  assumptions: PlanAssumption[];
};

export type MilestoneKind = "debt_paid_off" | "first_card_zero" | "percent_paid";

export type Milestone = {
  /**
   * Stable key shared with `debt_milestones.key`: `debt_zero:<debtId>`,
   * `first_card_zero`, `pct_25` / `pct_50` / `pct_75` / `pct_100`.
   */
  key: string;
  kind: MilestoneKind;
  label: string;
  debtId: string | null;
  /** 1-based simulation month the milestone lands in. */
  monthIndex: number;
  /** `YYYY-MM`. */
  estimatedMonth: string;
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM` of a Date's local calendar fields (the simulator's months are local 1sts). */
export function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** First of the month named by `YYYY-MM` or `YYYY-MM-DD`, as a local Date. */
function startDateOf(startISO: string): Date {
  const m = /^(\d{4})-(\d{2})/.exec(startISO);
  if (!m) throw new Error(`debtPlan: start month must be YYYY-MM[-DD], got "${startISO}"`);
  return new Date(Number(m[1]), Number(m[2]) - 1, 1);
}

function summarize(sim: SimResult): StrategySummary {
  const done = !sim.ranOutOfTime;
  const first = sim.killedOrder[0];
  return {
    monthsToFreedom: done ? sim.monthsToFreedom : null,
    debtFreeMonth: done && sim.debtFreeDate ? monthKeyOf(sim.debtFreeDate) : null,
    totalInterest: done ? round2(sim.totalInterestPaid) : null,
    firstKill: first ? { debtId: first.id, month: monthKeyOf(first.date) } : null,
  };
}

/**
 * Avalanche (highest APR first) against snowball (smallest balance first), on
 * the same debts and the same monthly extra. Each side is exactly
 * `simulate(...)` — `debtPlan.test.ts` pins avalanche to the engine's output.
 */
export function compareStrategies(
  debts: SimDebt[],
  extraMonthly: number,
  startISO: string,
): StrategyComparison {
  const startDate = startDateOf(startISO);
  const av = simulate({ debts, extraPerMonth: extraMonthly, strategy: "avalanche", startDate });
  const sn = simulate({ debts, extraPerMonth: extraMonthly, strategy: "snowball", startDate });
  const avalanche = summarize(av);
  const snowball = summarize(sn);
  const both = avalanche.monthsToFreedom !== null && snowball.monthsToFreedom !== null;
  const killOf = (sim: SimResult) => new Map(sim.killedOrder.map((k) => [k.id, monthKeyOf(k.date)] as const));
  const avKills = killOf(av);
  const snKills = killOf(sn);
  const ids = new Set([...av.killedOrder.map((k) => k.id), ...sn.killedOrder.map((k) => k.id)]);
  for (const d of debts) if ((d.status ?? "active") === "active" && d.balance > CENTS) ids.add(d.id);
  return {
    avalanche,
    snowball,
    delta: {
      months: both ? snowball.monthsToFreedom! - avalanche.monthsToFreedom! : null,
      interest: both ? round2(snowball.totalInterest! - avalanche.totalInterest!) : null,
    },
    killMonths: [...ids].map((id) => ({
      debtId: id,
      avalanche: avKills.get(id) ?? null,
      snowball: snKills.get(id) ?? null,
    })),
  };
}

const money = (n: number) => `$${round2(n).toFixed(2)}`;

/**
 * The assumptions every plan figure rests on. Always the same four, in this
 * order, plus nothing hidden: interest is APR/12 each month, payments land at
 * the start of the month, minimums are as stored (with where each came from),
 * and new charges are as measured.
 */
export function planAssumptions(debts: PlanDebt[], newChargesPerMonth: number): PlanAssumption[] {
  const live = debts.filter((d) => (d.status ?? "active") === "active" && d.balance > CENTS);
  const mins = live
    .map((d) => `${d.name} ${money(d.minPayment)} (${d.minPaymentSource ?? "manual"})`)
    .join("; ");
  return [
    { key: "interest_monthly", text: "Interest is each debt's APR ÷ 12, charged once a month." },
    { key: "payment_month_start", text: "Payments land at the start of each month, after that month's interest." },
    {
      key: "minimums_as_stored",
      text: mins ? `Minimum payments as stored: ${mins}.` : "No debt carries a minimum payment.",
    },
    {
      key: "new_charges_measured",
      text:
        newChargesPerMonth > CENTS
          ? `New card charges as measured: ${money(newChargesPerMonth)} a month, added to the debt being paid down.`
          : "No new card charges were measured.",
    },
  ];
}

/**
 * When the household is debt-free, as a range — never one date. Three runs of
 * the same engine:
 *   - `base`: the plan as set (`extraMonthly`);
 *   - `half_extra`: half the extra, for months the full extra is not paid;
 *   - `new_charges`: the plan as set, with `newChargesPerMonth` (measured, never
 *     guessed) added each month to the debt being paid down.
 * Earliest = the earliest finishing run; latest = the latest, or null (open
 * ended) when any run never finishes inside MAX_MONTHS.
 */
export function debtFreeRange(
  debts: PlanDebt[],
  extraMonthly: number,
  newChargesPerMonth: number,
  opts: { strategy?: Strategy; startISO: string },
): DebtFreeRange {
  const strategy = opts.strategy ?? "avalanche";
  const startDate = startDateOf(opts.startISO);
  const extra = Math.max(0, extraMonthly || 0);
  const charges = Math.max(0, newChargesPerMonth || 0);
  const run = (key: DebtFreeRange["runs"][number]["key"], e: number, c: number) => {
    const s = summarize(simulate({ debts, extraPerMonth: e, strategy, startDate, newChargesPerMonth: c }));
    return { key, debtFreeMonth: s.debtFreeMonth, totalInterest: s.totalInterest };
  };
  const runs = [
    run("base", extra, 0),
    run("half_extra", round2(extra / 2), 0),
    run("new_charges", extra, charges),
  ];
  const months = runs.map((r) => r.debtFreeMonth).filter((m): m is string => m !== null).sort();
  const interests = runs.map((r) => r.totalInterest).filter((n): n is number => n !== null);
  const allDone = months.length === runs.length;
  return {
    earliestMonth: months[0] ?? null,
    latestMonth: allDone ? months[months.length - 1]! : null,
    interestLow: interests.length ? Math.min(...interests) : null,
    interestHigh: allDone ? Math.max(...interests) : null,
    runs,
    assumptions: [
      ...planAssumptions(debts, charges),
      {
        key: "range_runs",
        text: `The range spans three runs: the plan as set (${money(extra)} extra a month), half that extra, and the plan with new charges added.`,
      },
    ],
  };
}

const CARD_TYPE = /credit|card/i;
const CARD_NAME = /card|visa|master\s*card|amex|american\s*express|discover/i;

/** A credit card: by `debts.type`, or — when no type was ever set — by name. */
export function isCardDebt(d: { type?: string | null; name: string }): boolean {
  if (d.type) return CARD_TYPE.test(d.type);
  return CARD_NAME.test(d.name);
}

/** The percent milestones, their keys and labels — shared by the projection and the achieved writer. */
export const PERCENT_MILESTONES: ReadonlyArray<{ step: number; key: string; label: string }> = [
  { step: 25, key: "pct_25", label: "25% paid" },
  { step: 50, key: "pct_50", label: "Halfway: 50% paid" },
  { step: 75, key: "pct_75", label: "75% paid" },
  { step: 100, key: "pct_100", label: "100% paid" },
];

/**
 * The milestones a simulation passes, in the order it passes them: each debt's
 * payoff month, the first credit card at $0, and every 25% of the total paid.
 *
 * ⚠️ THE % BASIS IS `payoffPct`'s when the debts carry anchors. The landing's
 * "% paid" is (Σ original − Σ min(balance, original)) / Σ original over anchored
 * debts; a milestone named "50% paid" must mean that same 50%, or the landing
 * and the plan would disagree about when it happened. Projected balances come
 * from the run's own `perDebt`; a debt the run does not carry (already at $0)
 * stays at its passed balance. Steps already reached at the start are not
 * projected — they are achieved (`writeAchievedMilestones` records them).
 * With no anchors at all the basis is the run's starting total.
 */
export function milestonesFor(simulation: SimResult, debts: PlanDebt[]): Milestone[] {
  const out: Milestone[] = [];
  const byId = new Map(debts.map((d) => [d.id, d] as const));
  const first = simulation.months[0];
  const monthOf = (i: number) => monthKeyOf(simulation.months[i - 1]!.date);

  for (const k of simulation.killedOrder) {
    out.push({
      key: `debt_zero:${k.id}`,
      kind: "debt_paid_off",
      label: `${k.name} paid off`,
      debtId: k.id,
      monthIndex: k.monthIndex,
      estimatedMonth: monthKeyOf(k.date),
    });
  }
  const firstCard = simulation.killedOrder.find((k) => {
    const d = byId.get(k.id);
    return d ? isCardDebt(d) : false;
  });
  if (firstCard) {
    out.push({
      key: "first_card_zero",
      kind: "first_card_zero",
      label: "First card at $0",
      debtId: firstCard.id,
      monthIndex: firstCard.monthIndex,
      estimatedMonth: monthKeyOf(firstCard.date),
    });
  }

  if (first) {
    // (WP4) The population `payoffPct` measures (`inPayoffPopulation`), so a
    // milestone named "50% paid" is that same 50%.
    const anchored = debts.filter(inPayoffPopulation);
    let pctAt: (i: number) => number;
    let startPct: number;
    if (anchored.length > 0) {
      const sumOrig = anchored.reduce((s, d) => s + Number(d.originalBalance), 0);
      const pctFrom = (balOf: (d: PlanDebt) => number) => {
        let sumBal = 0;
        for (const d of anchored) sumBal += Math.min(Math.max(0, balOf(d)), Number(d.originalBalance));
        return Math.max(0, Math.min(1, (sumOrig - sumBal) / sumOrig)) * 100;
      };
      startPct = pctFrom((d) => d.balance);
      pctAt = (i) => {
        const end = new Map(simulation.months[i - 1]!.perDebt.map((p) => [p.id, p.endBalance] as const));
        return pctFrom((d) => end.get(d.id) ?? d.balance);
      };
    } else {
      startPct = 0;
      pctAt = (i) => simulation.months[i - 1]!.pctPaidOff * 100;
    }
    for (const { step, key, label } of PERCENT_MILESTONES) {
      if (startPct >= step - 1e-9) continue;
      for (let i = 1; i <= simulation.months.length; i++) {
        if (pctAt(i) >= step - 1e-9) {
          out.push({
            key,
            kind: "percent_paid",
            label,
            debtId: null,
            monthIndex: i,
            estimatedMonth: monthOf(i),
          });
          break;
        }
      }
    }
  }

  const kindOrder: Record<MilestoneKind, number> = { debt_paid_off: 0, first_card_zero: 1, percent_paid: 2 };
  return out
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.monthIndex - b.m.monthIndex || kindOrder[a.m.kind] - kindOrder[b.m.kind] || a.i - b.i)
    .map(({ m }) => m);
}
