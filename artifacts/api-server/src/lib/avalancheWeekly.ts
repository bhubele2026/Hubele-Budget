// ⭐ (AVAL-W) THE WEEKLY AVALANCHE — one payment a week, the most that is safe.
//
// Owner, 2026-11-10: "weekly is easier to maintain for avalanche payments" ·
// "I would like to maximize how much I can pay on debt weekly" · "more and
// more as things fall off". And the requirement that followed: the weekly
// payment is THE MOST THAT IS SAFE THIS WEEK, not a flat share of the monthly
// figure — two biweekly paychecks leave a thin normal month and a fat
// third-paycheck month, and a flat amount would drain checking in one and
// strand money in the other.
//
// Pure: no I/O, no clock. `avalancheWeeklyPlan.ts` reads the household and the
// forecast curve and calls `planWeeklyAvalanche`; the forecast ledger turns the
// result into one `avalanche:extra` occurrence per week and stops each paid-off
// debt's minimum after its payoff day.
//
// THE RULES, each once:
//   - A week's payment day is every `weekday` from today on (today included).
//   - TARGET PACE (`planned`): the monthly figure × 12 ÷ 52, plus the same share
//     of every minimum already freed by a payoff before that day — each rounded
//     to the cent on its own, so a payoff raises the pace by exactly
//     `minimum × 12 ÷ 52` ("goes up $N a week").
//   - SAFE ROOM (`room`): the lowest point of the cash curve from that day to
//     the curve's end — after the payments already planned on earlier weeks,
//     and after adding back the minimums the forecast no longer takes (a paid-off
//     debt's minimum stops after its payoff day) — minus the cash buffer, floored
//     at $0 and rounded DOWN to the cent. Paying `room` keeps every later day of
//     the curve at or above the buffer.
//   - PAID: `room` (the most that is safe), or `min(planned, room)` when the
//     caller caps at the target pace; never more than the debts still owe.
//     Within `lookaheadDays` of the curve's end the room cannot be seen, so
//     those weeks (and every week after the curve) pay the target pace — they
//     only feed the payoff dates, never the forecast.
//   - A week the household already answered (skipped, missed, matched) pays
//     nothing more out of the curve: the cash it would have used either stayed
//     in checking (and rolls into the next week's room) or already left it.
//   - WHERE IT GOES: the debt the strategy attacks (`targetIndex`, the one
//     avalanche/snowball rule the monthly simulator uses: highest APR first,
//     ties to the smaller balance); what it does not need rolls to the next
//     debt the same day.
//   - THE DEBTS between payments: on each debt's due day (1–31, clamped to the
//     month; no due day reads as the 1st, as `expandDebtMin` does) interest of
//     APR ÷ 12 is added, then the minimum is paid. A debt is paid off the day
//     its balance reaches $0, by the weekly payment or by its own minimum.

import { CENTS, round2, targetIndex, type Strategy } from "@workspace/avalanche-core";

export const WEEKS_PER_YEAR = 52;
/** Weeks within this many days of the curve's end are not priced from it. */
export const DEFAULT_LOOKAHEAD_DAYS = 28;
/** The plan gives up after this many weeks (ten years). */
export const DEFAULT_MAX_WEEKS = 520;

export type WeeklyPlanDebt = {
  id: string;
  name: string;
  /** Decimal APR (0.2999 = 29.99%). */
  apr: number;
  balance: number;
  minPayment: number;
  dueDay: number | null;
  /**
   * The debt's minimum is on the cash curve as its own `debt:<id>` occurrences,
   * which the forecast stops after the payoff day — so the planner adds those
   * minimums back to the curve once the debt is paid off. False when a linked
   * bill carries the payment (that bill keeps its own schedule).
   */
  minimumOnCurve: boolean;
};

export type WeeklyPlanInput = {
  debts: readonly WeeklyPlanDebt[];
  /** The monthly figure (`avalanche_settings.manual_extra`). */
  monthlyTarget: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  cashBuffer: number;
  /** The household's today, `YYYY-MM-DD`. */
  todayISO: string;
  /**
   * The forecast's daily closing balance from today, ascending, WITHOUT any
   * avalanche payment and with every debt minimum still on it.
   */
  curve: ReadonlyArray<{ date: string; balance: number }>;
  strategy?: Strategy;
  /** Cap each week at the target pace. Default false: pay the most that is safe. */
  capAtTarget?: boolean;
  /** Payment days the household already answered: nothing more is paid out of the curve. */
  answeredDates?: ReadonlySet<string>;
  lookaheadDays?: number;
  maxWeeks?: number;
};

export type WeeklyPlanTarget = { debtId: string; name: string; amount: number; paidOff: boolean };

export type WeeklyPlanPayoff = {
  debtId: string;
  name: string;
  date: string;
  /** What the freed minimum adds to the weekly target pace: `round2(minimum × 12 ÷ 52)`. */
  freedWeekly: number;
};

export type WeeklyPlanWeek = {
  date: string;
  /** Target pace for the week. */
  planned: number;
  /** The most that is safe this week; null when the curve cannot see far enough. */
  room: number | null;
  /**
   * What the week is due to pay, answered or not: the room (or the target pace
   * when capped or past the curve), never more than the debts still owe.
   */
  due: number;
  /** What the week pays (≥ 0): `due`, or 0 when the household already answered it. */
  paid: number;
  /** "curve": priced from the forecast; "target": past the curve, at the target pace. */
  basis: "curve" | "target";
  answered: boolean;
  /** The debt the strategy attacks on that day, before the payment (null when nothing is left). */
  nextTarget: { debtId: string; name: string } | null;
  targets: WeeklyPlanTarget[];
  /** Debts paid off since the previous payment day, through this one (by this payment or by a minimum). */
  paidOff: WeeklyPlanPayoff[];
};

export type WeeklyPlan = {
  weekday: number;
  /** `round2(monthlyTarget × 12 ÷ 52)`. */
  targetWeekly: number;
  weeks: WeeklyPlanWeek[];
  /** Every debt's payoff day, in the order they are paid off. */
  payoffs: WeeklyPlanPayoff[];
  /** The day the last debt is paid off; null when the plan never gets there. */
  debtFreeDate: string | null;
  /** The last payment day priced from the curve; null when none is. */
  curveThrough: string | null;
  ranOutOfTime: boolean;
};

/** `amount × 12 ÷ 52`, to the cent. */
export function weeklyShare(monthly: number): number {
  return round2((Math.max(0, monthly || 0) * 12) / WEEKS_PER_YEAR);
}

const floor2 = (n: number): number => Math.floor(n * 100 + 1e-6) / 100;

function parse(iso: string): { y: number; m: number; d: number } {
  return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)) - 1, d: Number(iso.slice(8, 10)) };
}

/** Calendar arithmetic on `YYYY-MM-DD`, in UTC so no server zone can move a day. */
function addDays(iso: string, n: number): string {
  const { y, m, d } = parse(iso);
  return new Date(Date.UTC(y, m, d + n)).toISOString().slice(0, 10);
}

function weekdayOf(iso: string): number {
  const { y, m, d } = parse(iso);
  return new Date(Date.UTC(y, m, d)).getUTCDay();
}

/** Is `iso` the debt's due day (clamped to the month; none = the 1st)? */
export function isDueDay(dueDay: number | null, iso: string): boolean {
  const day = dueDay && dueDay >= 1 && dueDay <= 31 ? dueDay : 1;
  const { y, m, d } = parse(iso);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return d === Math.min(day, last);
}

type Work = WeeklyPlanDebt & { left: number; paidOffOn: string | null };

/**
 * The weekly avalanche from today: each payment day's target pace, safe room,
 * payment and targets, every debt's payoff day and the debt-free day.
 */
export function planWeeklyAvalanche(input: WeeklyPlanInput): WeeklyPlan {
  const strategy = input.strategy ?? "avalanche";
  const weekday = Number.isInteger(input.weekday) && input.weekday >= 0 && input.weekday <= 6 ? input.weekday : 5;
  const buffer = Math.max(0, input.cashBuffer || 0);
  const lookahead = Math.max(0, input.lookaheadDays ?? DEFAULT_LOOKAHEAD_DAYS);
  const maxWeeks = Math.max(1, input.maxWeeks ?? DEFAULT_MAX_WEEKS);
  const targetWeekly = weeklyShare(input.monthlyTarget);
  const answered = input.answeredDates ?? new Set<string>();

  const work: Work[] = input.debts
    .filter((d) => Number.isFinite(d.balance) && d.balance > CENTS)
    .map((d) => ({
      ...d,
      apr: Number.isFinite(d.apr) ? d.apr : 0,
      minPayment: Math.max(0, Number.isFinite(d.minPayment) ? d.minPayment : 0),
      left: round2(d.balance),
      paidOffOn: null,
    }));

  // The curve from today, keyed by day; `adj[i]` is the curve after the payments
  // planned so far and with the freed minimums added back.
  const curve = input.curve.filter((p) => p.date >= input.todayISO);
  const indexOf = new Map(curve.map((p, i) => [p.date, i] as const));
  const adj = curve.map((p) => p.balance);
  const lastCurveDay = curve.length > 0 ? curve[curve.length - 1]!.date : null;
  const pricedThrough = lastCurveDay ? addDays(lastCurveDay, -lookahead) : null;
  const shiftFrom = (i: number, by: number) => {
    for (let j = i; j < adj.length; j++) adj[j] = round2(adj[j]! + by);
  };

  const payoffs: WeeklyPlanPayoff[] = [];
  const weeks: WeeklyPlanWeek[] = [];
  let pendingPayoffs: WeeklyPlanPayoff[] = [];
  let curveThrough: string | null = null;

  const markPaidOff = (d: Work, day: string) => {
    if (d.paidOffOn) return;
    d.left = 0;
    d.paidOffOn = day;
    const p: WeeklyPlanPayoff = { debtId: d.id, name: d.name, date: day, freedWeekly: weeklyShare(d.minPayment) };
    payoffs.push(p);
    pendingPayoffs.push(p);
    // The forecast stops this minimum after `day`: add every later one back.
    if (d.minimumOnCurve && d.minPayment > 0) {
      for (let j = 0; j < curve.length; j++) {
        const on = curve[j]!.date;
        if (on > day && isDueDay(d.dueDay, on)) shiftFrom(j, d.minPayment);
      }
    }
  };

  const live = () => work.filter((d) => d.left > CENTS);
  const maxDays = maxWeeks * 7 + 7;
  let day = input.todayISO;
  for (let n = 0; n < maxDays && live().length > 0; n++, day = addDays(day, 1)) {
    // 1. Due days: a month's interest, then the minimum.
    for (const d of work) {
      if (d.left <= CENTS || !isDueDay(d.dueDay, day)) continue;
      d.left = round2(d.left + round2(d.left * (d.apr / 12)));
      d.left = round2(d.left - Math.min(d.minPayment, d.left));
      if (d.left <= CENTS) markPaidOff(d, day);
    }
    if (weekdayOf(day) !== weekday) continue;
    if (live().length === 0) {
      // A minimum finished the last debt on a payment day: nothing left to pay.
      break;
    }
    if (weeks.length >= maxWeeks) break;

    // 2. The week's payment.
    const freed = payoffs.reduce((s, p) => s + p.freedWeekly, 0);
    const planned = round2(targetWeekly + freed);
    const owed = round2(live().reduce((s, d) => s + d.left, 0));
    const i = indexOf.get(day);
    const priced = i !== undefined && pricedThrough !== null && day <= pricedThrough;
    let room: number | null = null;
    if (priced) {
      let low = Infinity;
      for (let j = i!; j < adj.length; j++) if (adj[j]! < low) low = adj[j]!;
      room = Math.max(0, floor2(low - buffer));
      curveThrough = day;
    }
    const isAnswered = answered.has(day);
    const due = round2(Math.min(room === null ? planned : input.capAtTarget ? Math.min(planned, room) : room, owed));
    const paid = isAnswered ? 0 : due;
    const first = targetIndex(work.map((d) => ({ balance: d.left, apr: d.apr })), strategy);
    const nextTarget = first === -1 ? null : { debtId: work[first]!.id, name: work[first]!.name };

    // 3. Where it goes: the strategy's target, then the next, the same day.
    const targets: WeeklyPlanTarget[] = [];
    let pool = paid;
    while (pool > CENTS) {
      const rows = work.map((d) => ({ balance: d.left, apr: d.apr }));
      const idx = targetIndex(rows, strategy);
      if (idx === -1) break;
      const d = work[idx]!;
      const pay = round2(Math.min(pool, d.left));
      d.left = round2(d.left - pay);
      pool = round2(pool - pay);
      const done = d.left <= CENTS;
      targets.push({ debtId: d.id, name: d.name, amount: pay, paidOff: done });
      if (done) markPaidOff(d, day);
    }
    if (priced && paid > 0) shiftFrom(i!, -paid);

    weeks.push({
      date: day,
      planned,
      room,
      due,
      paid,
      basis: priced ? "curve" : "target",
      answered: isAnswered,
      nextTarget,
      targets,
      paidOff: pendingPayoffs,
    });
    pendingPayoffs = [];
  }

  const done = live().length === 0;
  return {
    weekday,
    targetWeekly,
    weeks,
    payoffs,
    debtFreeDate: done && payoffs.length > 0 ? payoffs[payoffs.length - 1]!.date : null,
    curveThrough,
    ranOutOfTime: !done,
  };
}

/** Each paid-off debt's payoff day, by debt id (the day after which its minimum stops). */
export function payoffDayByDebt(plan: Pick<WeeklyPlan, "payoffs">): Map<string, string> {
  return new Map(plan.payoffs.map((p) => [p.debtId, p.date] as const));
}
