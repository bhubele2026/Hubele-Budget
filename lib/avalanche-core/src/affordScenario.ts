// ⭐ (PR-F1) "CAN WE AFFORD THIS?" — one purchase, evaluated against the money
// position the household already sees. Pure: no I/O, no clock.
//
// ⚠️ NOTHING HERE IS A NEW CALCULATION. The purchase is one more outflow on the
// SAME curve, and every figure is re-read by the SAME code:
//
//   1. the curve       the ledger's own items plus one outflow on the purchase
//                      day, re-walked by `walkLedger` (ledgerWalk.ts) from the
//                      same starting balance over the same window;
//   2. the position    `computePosition` (availableToSpend.ts) re-run on the
//                      baseline's exact inputs with the re-walked `daily`, the
//                      purchase added to `events`, and — when it lands in this
//                      household week — the purchase as weekly spend in
//                      `weekRows`;
//   3. the debt plan   `debtFreeRange` (debtPlan.ts) for the baseline; the
//                      proposed range runs the SAME engine (`simulate`) with one
//                      month's extra lowered (see "The debt rule").
//
// THE LAWS (affordScenario.test.ts, on random households):
//   - a $0 purchase reproduces the baseline to the cent, figure for figure;
//   - a purchase never shows a higher cash figure, an earlier debt-free month or
//     less interest than the baseline. "The forecast may read low, never high."
//
// THE DATE. Omitted, the purchase is counted today; a past date is counted today
// (the money has not left yet). A date after the curve's last day is refused
// (`AffordInputError`): off the curve it would change nothing and read high.
//
// THE WEEK. A purchase dated in this Sunday–Saturday week counts against this
// week's cap, as weekly spend. One dated after Saturday leaves this week's cap
// alone (it belongs to a later week's cap, which the position does not read yet).
//
// THE VERDICT (one word, from the proposed figures):
//   - `breaks_zero`   the lowest expected balance goes under $0;
//   - `breaks_buffer` the lowest expected balance goes under the cash buffer
//                     (plus money held back for goals);
//       "Lowest" is the lower of the curve's lowest end-of-day balance over its
//       whole window and the position's lowest until payday (payday's bills
//       counted before its paycheck), so a purchase after payday that dips a
//       later week under the buffer is caught too;
//   - `tight`         the cash holds, but the purchase takes this week over its
//                     cap, or leaves less than 15% of what was left this week
//                     or until payday;
//   - `fits`          none of the above.
//   On a curve already under the buffer, every purchase reads `breaks_buffer`
//   (or `breaks_zero`) and the assumptions say the curve was short before it.
//
// THE DEBT RULE. The planned extra (`avalanche.extraMonthly`) is paid from the
// same checking account. When what is left until payday after the purchase is
// LESS than one month's planned extra (or unknown: no bank data), H2 assumes
// the purchase comes out of that month's extra: the extra for the purchase's
// month is cut by min(amount, extra), every other month keeps the full extra.
// Otherwise the debt plan is untouched (shift 0, interest delta $0.00). A cut
// never shows a gain: where the engine's snowball reordering would finish
// sooner or pay less interest, the baseline's own figure is kept.

import { walkLedger, type LedgerWalkItem, type LedgerWalkResult } from "./ledgerWalk";
import {
  computePosition,
  type MoneyPosition,
  type PositionEvent,
  type PositionInputs,
  type PositionWeekRow,
} from "./availableToSpend";
import { debtFreeRange, monthKeyOf, type PlanDebt } from "./debtPlan";
import { addDaysISO, weekBounds } from "./householdTime";
import { CENTS, MAX_MONTHS, round2, simulate, type SimDebt, type SimResult, type Strategy } from "./index";

/** The share of what was left that a purchase may leave before it reads `tight` (15%, compared ×100 in whole cents). */
export const AFFORD_TIGHT_PERCENT = 15;
/** The id the purchase carries on the curve. */
export const AFFORD_PURCHASE_ITEM_ID = "afford:purchase";

export interface AffordCategoryPlan {
  categoryId: string;
  /** This month's plan for the category, dollars. */
  planned: number | string;
  /** Spent in the category this month so far, dollars. */
  spentMtd: number | string;
}

/** Everything the evaluator reads: one read of the household, made once. */
export interface AffordBaseline {
  /** Exactly the inputs `computePosition` took for `GET /money/position`. */
  positionInputs: PositionInputs;
  /** The curve's items (plans and real rows), sorted by date, as the forecast walked them. */
  events: readonly LedgerWalkItem[];
  /** The balance at the start of `fromISO` (`rollForwardBalance`). */
  startingBalance: number;
  fromISO: string;
  toISO: string;
  categoryPlans: readonly AffordCategoryPlan[];
  /** The plan's debts, netted, as `debtFreeRange` takes them. */
  debts: PlanDebt[];
  avalanche: { strategy: Strategy; extraMonthly: number; newChargesPerMonth: number };
}

export interface AffordPurchase {
  /** Dollars, ≥ 0. Rounded to the cent. */
  amount: number;
  /** `YYYY-MM-DD`; today when omitted, today when in the past. */
  dateISO?: string | null;
  categoryId?: string | null;
  /** The member making the purchase. The shared weekly cap is used for everyone. */
  member?: string | null;
}

export type AffordVerdict = "fits" | "tight" | "breaks_buffer" | "breaks_zero";

/** The figures compared. Money is `toFixed(2)`; months are `YYYY-MM`. */
export interface AffordFigures {
  safeToSpendNow: string | null;
  remainingWeek: string | null;
  availableUntilPayday: string | null;
  /** The curve's lowest end-of-day balance over its whole window (or its starting balance). */
  lowest: string;
  lowestDate: string | null;
  debtFreeEarliest: string | null;
  debtFreeLatest: string | null;
  totalInterestLow: string | null;
}

/** Proposed minus baseline. Months are whole months later; null when either side is null. */
export interface AffordDelta {
  safeToSpendNow: string | null;
  remainingWeek: string | null;
  availableUntilPayday: string | null;
  lowest: string;
  /** The proposed lowest day when the purchase moved it, else null. */
  lowestDate: string | null;
  debtFreeEarliest: number | null;
  debtFreeLatest: number | null;
  totalInterestLow: string | null;
}

export interface AffordDebtEffect {
  /** True when the debt rule cut a month's extra. */
  affected: boolean;
  /** The extra taken from the purchase's month, `toFixed(2)`. */
  cut: string;
  /** `YYYY-MM` of the month cut, or null when unaffected. */
  cutMonth: string | null;
  /** Months the plan-as-set run finishes later: 0 when unaffected; null when either run never finishes. */
  debtFreeMonthShift: number | null;
  /** Extra interest on the plan-as-set run, `toFixed(2)`: "0.00" when unaffected; null when either never finishes. */
  interestDelta: string | null;
}

export interface AffordResult {
  /** The purchase as counted. */
  amount: string;
  dateISO: string;
  baseline: AffordFigures;
  proposed: AffordFigures;
  delta: AffordDelta;
  category: { categoryId: string; remainingBefore: string | null; remainingAfter: string | null } | null;
  debt: AffordDebtEffect;
  verdict: AffordVerdict;
  assumptions: string[];
}

export type AffordInputErrorCode = "bad_amount" | "bad_date" | "date_past_window";

/** A purchase the evaluator refuses to read. The route answers 400. */
export class AffordInputError extends Error {
  constructor(public readonly code: AffordInputErrorCode) {
    super(`afford: ${code}`);
    this.name = "AffordInputError";
  }
}

/** Fixed wording the evaluator adds after the position's own assumptions. */
export const AFFORD_ASSUMPTIONS = {
  countedOn: (day: string) => `the purchase is counted on ${day}`,
  pastDateToday: "a date in the past is counted today",
  countsThisWeek: "it counts against this week's cap",
  afterThisWeek: "it lands after Saturday: this week's cap is unchanged",
  sharedCap: "the household's shared weekly cap is used for every member",
  extraCut: (month: string, cut: string) =>
    `what is left until payday would be under one month's planned extra: ${month}'s extra is cut by $${cut}`,
  noDebtGain: "a purchase never moves the debt-free month earlier or lowers interest",
  alreadyShort: "the forecast was already under the cash buffer before this purchase",
  categoryNoPlan: "this category has no monthly plan to measure against",
  categoryThisMonth: "it is measured against this month's plan for the category",
} as const;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const toCents = (v: number | string | null | undefined): number | null => {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const money = (cents: number): string => (cents / 100).toFixed(2);

/** `items` with `item` placed after every item dated on or before its day (the list stays in date order). */
function insertByDate<T extends { date: string }>(items: readonly T[], item: T): T[] {
  let i = 0;
  while (i < items.length && items[i]!.date <= item.date) i++;
  return [...items.slice(0, i), item, ...items.slice(i)];
}

/** Whole months from `YYYY-MM` a to `YYYY-MM` b (b − a). */
function monthsBetween(a: string, b: string): number {
  return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));
}

const firstOfMonth = (monthKey: string, plus = 0): Date =>
  new Date(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)) - 1 + plus, 1);

// ── The debt engine, one month's extra lowered ──────────────────────────────

/** A run as the range reads it: `debtPlan.ts`'s `summarize`, the two fields the range uses. */
export interface CutRun {
  debtFreeMonth: string | null;
  totalInterest: number | null;
}

function runOf(sim: SimResult): CutRun {
  const done = !sim.ranOutOfTime;
  return {
    debtFreeMonth: done && sim.debtFreeDate ? monthKeyOf(sim.debtFreeDate) : null,
    totalInterest: done ? round2(sim.totalInterestPaid) : null,
  };
}

export interface CutRunOptions {
  debts: SimDebt[];
  extraPerMonth: number;
  strategy: Strategy;
  startDate: Date;
  newChargesPerMonth?: number;
  /** 1-based simulation month whose extra is lowered. */
  cutMonthIndex: number;
  /** Dollars taken from that month's extra (capped at the extra). */
  cut: number;
}

/**
 * `simulate` with month `cutMonthIndex`'s extra lowered by `cut`, built from
 * three runs of the engine itself — months before the cut at the full extra,
 * the cut month alone, then the rest at the full extra — each picking up the
 * balances the last one left. A debt paid off along the way frees its minimum
 * into the next run's extra, exactly as the engine's own pool does (in the
 * engine's order, so the sums are the same floats).
 *
 * With `cut` 0 it equals one `simulate` run exactly (affordScenario.test.ts,
 * 2,000 random debt sets): the splitting itself changes nothing.
 */
export function composeCutRun(o: CutRunOptions): CutRun {
  const extra = Math.max(0, o.extraPerMonth || 0);
  const charges = Math.max(0, o.newChargesPerMonth || 0);
  const cut = Math.min(Math.max(0, o.cut || 0), extra);
  const k = Math.max(1, Math.floor(o.cutMonthIndex));
  // The engine's own work list: active debts with a balance, in the order given.
  const live = o.debts.filter((d) => (d.status ?? "active") === "active" && d.balance > CENTS);
  const balance = new Map(live.map((d) => [d.id, d.balance] as const));
  const monthAt = (i: number) => new Date(o.startDate.getFullYear(), o.startDate.getMonth() + (i - 1), 1);
  const debtsNow = (): SimDebt[] =>
    live.map((d) => ({ id: d.id, name: d.name, apr: d.apr, minPayment: d.minPayment, balance: balance.get(d.id)! }));
  // The engine's pool: the extra, plus the minimum of every debt already at $0, in order.
  const poolFrom = (base: number): number => {
    let p = base;
    for (const d of live) if (balance.get(d.id)! <= CENTS) p += d.minPayment;
    return p;
  };
  const take = (m: SimResult["months"][number]) => {
    for (const p of m.perDebt) balance.set(p.id, p.endBalance);
  };

  let interest = 0;
  if (k > 1) {
    const before = simulate({ debts: live, extraPerMonth: extra, strategy: o.strategy, startDate: o.startDate, newChargesPerMonth: charges });
    // Paid off before the cut month: the cut never happens.
    if (before.months.length < k) return runOf(before);
    for (let i = 0; i < k - 1; i++) {
      interest = round2(interest + before.months[i]!.totalInterest);
      take(before.months[i]!);
    }
  }
  const cutMonth = simulate({
    debts: debtsNow(),
    extraPerMonth: poolFrom(extra - cut),
    strategy: o.strategy,
    startDate: monthAt(k),
    newChargesPerMonth: charges,
  });
  const m = cutMonth.months[0];
  // No debt left to pay (an empty plan): what `simulate` answers for one.
  if (!m) return { debtFreeMonth: null, totalInterest: interest };
  interest = round2(interest + m.totalInterest);
  take(m);
  if (m.totalBalanceEnd <= CENTS) return { debtFreeMonth: monthKeyOf(m.date), totalInterest: interest };
  const after = simulate({
    debts: debtsNow(),
    extraPerMonth: poolFrom(extra),
    strategy: o.strategy,
    startDate: monthAt(k + 1),
    newChargesPerMonth: charges,
  });
  // The engine stops at MAX_MONTHS; so does the composed run.
  if (after.ranOutOfTime || k + after.months.length > MAX_MONTHS || !after.debtFreeDate) {
    return { debtFreeMonth: null, totalInterest: null };
  }
  return { debtFreeMonth: monthKeyOf(after.debtFreeDate), totalInterest: round2(interest + after.totalInterestPaid) };
}

/** `simulate`, or `composeCutRun` when there is a cut to make. */
export function simulateWithCut(o: CutRunOptions): CutRun {
  const extra = Math.max(0, o.extraPerMonth || 0);
  if (Math.min(Math.max(0, o.cut || 0), extra) <= CENTS) {
    return runOf(simulate({ debts: o.debts, extraPerMonth: extra, strategy: o.strategy, startDate: o.startDate, newChargesPerMonth: o.newChargesPerMonth }));
  }
  return composeCutRun(o);
}

export interface CutRange {
  earliestMonth: string | null;
  latestMonth: string | null;
  interestLow: number | null;
  runs: Array<{ key: "base" | "half_extra" | "new_charges"; debtFreeMonth: string | null; totalInterest: number | null }>;
}

/**
 * `debtFreeRange`'s three runs (the plan as set, half the extra, the plan with
 * new charges) with month `cutMonthIndex`'s extra lowered by `cut` in each —
 * capped at that run's own extra. The earliest / latest / lowest-interest
 * reading is `debtFreeRange`'s, line for line; with `cut` 0 the two agree
 * exactly (affordScenario.test.ts).
 */
export function debtFreeRangeWithCut(
  debts: PlanDebt[],
  extraMonthly: number,
  newChargesPerMonth: number,
  opts: { strategy?: Strategy; startISO: string; cutMonthIndex: number; cut: number },
): CutRange {
  const strategy = opts.strategy ?? "avalanche";
  const startDate = firstOfMonth(opts.startISO);
  const extra = Math.max(0, extraMonthly || 0);
  const charges = Math.max(0, newChargesPerMonth || 0);
  const run = (key: CutRange["runs"][number]["key"], e: number, c: number) => ({
    key,
    ...simulateWithCut({ debts, extraPerMonth: e, strategy, startDate, newChargesPerMonth: c, cutMonthIndex: opts.cutMonthIndex, cut: Math.min(opts.cut, e) }),
  });
  const runs = [run("base", extra, 0), run("half_extra", round2(extra / 2), 0), run("new_charges", extra, charges)];
  const months = runs.map((r) => r.debtFreeMonth).filter((m): m is string => m !== null).sort();
  const interests = runs.map((r) => r.totalInterest).filter((n): n is number => n !== null);
  const allDone = months.length === runs.length;
  return {
    earliestMonth: months[0] ?? null,
    latestMonth: allDone ? months[months.length - 1]! : null,
    interestLow: interests.length ? Math.min(...interests) : null,
    runs,
  };
}

// The floor: a purchase never shows a debt gain. Null (never finishes) is the worst.
const laterMonth = (base: string | null, proposed: string | null): string | null =>
  base === null || proposed === null ? null : proposed > base ? proposed : base;
const moreInterest = (base: number | null, proposed: number | null): number | null =>
  base === null || proposed === null ? null : Math.max(base, proposed);

// ── The evaluator ───────────────────────────────────────────────────────────

function figuresOf(
  pos: MoneyPosition,
  walk: LedgerWalkResult,
  range: { earliestMonth: string | null; latestMonth: string | null; interestLow: number | null },
): AffordFigures {
  return {
    safeToSpendNow: pos.safeToSpendNow,
    remainingWeek: pos.remainingWeek,
    availableUntilPayday: pos.availableUntilPayday,
    lowest: money(toCents(walk.lowest) ?? 0),
    lowestDate: walk.lowestDate,
    debtFreeEarliest: range.earliestMonth,
    debtFreeLatest: range.latestMonth,
    totalInterestLow: range.interestLow === null ? null : money(toCents(range.interestLow)!),
  };
}

/** The lower of the curve's lowest and the position's lowest until payday, in cents. */
function cashLowCents(pos: MoneyPosition, walk: LedgerWalkResult): number {
  const w = toCents(walk.lowest) ?? 0;
  const p = toCents(pos.lowestUntilPayday);
  return p === null ? w : Math.min(w, p);
}

/**
 * ⭐ Evaluate one purchase. See the file header for every rule; the review note
 * (docs/reviews/2026-10-08-prf1-afford.md) works an example through.
 */
export function evaluateAfford(baseline: AffordBaseline, purchase: AffordPurchase): AffordResult {
  const cents = toCents(purchase.amount);
  if (cents === null || cents < 0) throw new AffordInputError("bad_amount");
  const inputs = baseline.positionInputs;
  const todayISO = inputs.todayISO;
  const asked = purchase.dateISO ?? null;
  if (asked !== null && (!ISO_DAY.test(asked) || addDaysISO(asked, 0) !== asked)) throw new AffordInputError("bad_date");
  const firstDay = baseline.fromISO > todayISO ? baseline.fromISO : todayISO;
  const dateISO = asked === null || asked < firstDay ? firstDay : asked;
  if (dateISO > baseline.toISO) throw new AffordInputError("date_past_window");

  // ── The curve and the position, before and after.
  const outflow = cents === 0 ? 0 : -cents / 100;
  const baseWalk = walkLedger(baseline.events, baseline.startingBalance, baseline.fromISO, baseline.toISO);
  const propWalk = walkLedger(
    insertByDate(baseline.events, { date: dateISO, amount: outflow }),
    baseline.startingBalance,
    baseline.fromISO,
    baseline.toISO,
  );
  const week = weekBounds(todayISO);
  const inThisWeek = dateISO <= week.end;
  const purchaseEvent: PositionEvent = {
    date: dateISO,
    amount: outflow,
    kind: "expense",
    itemId: AFFORD_PURCHASE_ITEM_ID,
    label: "This purchase",
    assumption: null,
    amountKind: "fixed",
  };
  const weekRows: readonly PositionWeekRow[] =
    inThisWeek && cents > 0 ? [...inputs.weekRows, { coverage: "allowance_weekly", spend: cents / 100 }] : inputs.weekRows;
  const basePos = computePosition(inputs);
  const propPos = computePosition({
    ...inputs,
    daily: propWalk.daily,
    events: insertByDate(inputs.events, purchaseEvent),
    weekRows,
  });

  // ── The debt plan, before and after (the debt rule).
  const { strategy, extraMonthly, newChargesPerMonth } = baseline.avalanche;
  const startISO = todayISO.slice(0, 7);
  const baseRange = debtFreeRange(baseline.debts, extraMonthly, newChargesPerMonth, { strategy, startISO });
  const extraCents = Math.max(0, toCents(extraMonthly) ?? 0);
  const availAfter = toCents(propPos.availableUntilPayday);
  const affected = cents > 0 && extraCents > 0 && (availAfter === null || availAfter < extraCents);
  const cutCents = affected ? Math.min(cents, extraCents) : 0;
  const cutMonth = dateISO.slice(0, 7);
  let propRange: { earliestMonth: string | null; latestMonth: string | null; interestLow: number | null } = baseRange;
  let baseRun = { debtFreeMonth: baseRange.runs[0]!.debtFreeMonth, totalInterest: baseRange.runs[0]!.totalInterest };
  let propRun = baseRun;
  let floored = false;
  if (affected) {
    const cut = debtFreeRangeWithCut(baseline.debts, extraMonthly, newChargesPerMonth, {
      strategy,
      startISO,
      cutMonthIndex: monthsBetween(startISO, cutMonth) + 1,
      cut: cutCents / 100,
    });
    propRange = {
      earliestMonth: laterMonth(baseRange.earliestMonth, cut.earliestMonth),
      latestMonth: laterMonth(baseRange.latestMonth, cut.latestMonth),
      interestLow: moreInterest(baseRange.interestLow, cut.interestLow),
    };
    propRun = {
      debtFreeMonth: laterMonth(baseRun.debtFreeMonth, cut.runs[0]!.debtFreeMonth),
      totalInterest: moreInterest(baseRun.totalInterest, cut.runs[0]!.totalInterest),
    };
    floored =
      propRange.earliestMonth !== cut.earliestMonth ||
      propRange.latestMonth !== cut.latestMonth ||
      propRange.interestLow !== cut.interestLow ||
      propRun.debtFreeMonth !== cut.runs[0]!.debtFreeMonth ||
      propRun.totalInterest !== cut.runs[0]!.totalInterest;
  }
  const debt: AffordDebtEffect = {
    affected,
    cut: money(cutCents),
    cutMonth: affected ? cutMonth : null,
    debtFreeMonthShift: !affected
      ? 0
      : baseRun.debtFreeMonth === null || propRun.debtFreeMonth === null
        ? null
        : monthsBetween(baseRun.debtFreeMonth, propRun.debtFreeMonth),
    interestDelta: !affected
      ? "0.00"
      : baseRun.totalInterest === null || propRun.totalInterest === null
        ? null
        : money(toCents(propRun.totalInterest)! - toCents(baseRun.totalInterest)!),
  };

  // ── Figures and the difference.
  const baseFigures = figuresOf(basePos, baseWalk, baseRange);
  const propFigures = figuresOf(propPos, propWalk, propRange);
  const diff = (a: string | null, b: string | null): string | null =>
    a === null || b === null ? null : money(toCents(b)! - toCents(a)!);
  const shift = (a: string | null, b: string | null): number | null =>
    a === null || b === null ? null : monthsBetween(a, b);
  const delta: AffordDelta = {
    safeToSpendNow: diff(baseFigures.safeToSpendNow, propFigures.safeToSpendNow),
    remainingWeek: diff(baseFigures.remainingWeek, propFigures.remainingWeek),
    availableUntilPayday: diff(baseFigures.availableUntilPayday, propFigures.availableUntilPayday),
    lowest: money(toCents(propFigures.lowest)! - toCents(baseFigures.lowest)!),
    lowestDate: propFigures.lowestDate !== baseFigures.lowestDate ? propFigures.lowestDate : null,
    debtFreeEarliest: shift(baseFigures.debtFreeEarliest, propFigures.debtFreeEarliest),
    debtFreeLatest: shift(baseFigures.debtFreeLatest, propFigures.debtFreeLatest),
    totalInterestLow: diff(baseFigures.totalInterestLow, propFigures.totalInterestLow),
  };

  // ── The category.
  let category: AffordResult["category"] = null;
  const assumptions = [...propPos.assumptions];
  if (purchase.categoryId) {
    const plan = baseline.categoryPlans.find((p) => p.categoryId === purchase.categoryId);
    if (!plan) {
      category = { categoryId: purchase.categoryId, remainingBefore: null, remainingAfter: null };
      assumptions.push(AFFORD_ASSUMPTIONS.categoryNoPlan);
    } else {
      const before = (toCents(plan.planned) ?? 0) - (toCents(plan.spentMtd) ?? 0);
      category = { categoryId: purchase.categoryId, remainingBefore: money(before), remainingAfter: money(before - cents) };
      if (cutMonth !== startISO) assumptions.push(AFFORD_ASSUMPTIONS.categoryThisMonth);
    }
  }

  // ── The verdict.
  const floorCents = (toCents(propPos.cashBuffer) ?? 0) + (toCents(propPos.reservesHeld) ?? 0);
  const lowAfter = cashLowCents(propPos, propWalk);
  let verdict: AffordVerdict;
  if (lowAfter < 0) verdict = "breaks_zero";
  else if (lowAfter < floorCents) verdict = "breaks_buffer";
  else {
    const remB = toCents(basePos.remainingWeek);
    const remP = toCents(propPos.remainingWeek);
    const weekTight =
      remP !== null && (remP < 0 || (remB !== null && remB > 0 && remP * 100 < remB * AFFORD_TIGHT_PERCENT));
    const avB = toCents(basePos.availableUntilPayday);
    const avP = toCents(propPos.availableUntilPayday);
    const paydayTight = avB !== null && avP !== null && avB > 0 && avP * 100 < avB * AFFORD_TIGHT_PERCENT;
    verdict = weekTight || paydayTight ? "tight" : "fits";
  }

  // ── What it rests on.
  assumptions.push(AFFORD_ASSUMPTIONS.countedOn(dateISO));
  if (asked !== null && asked < firstDay) assumptions.push(AFFORD_ASSUMPTIONS.pastDateToday);
  if (inputs.weekCap !== null) assumptions.push(inThisWeek ? AFFORD_ASSUMPTIONS.countsThisWeek : AFFORD_ASSUMPTIONS.afterThisWeek);
  if (purchase.member) assumptions.push(AFFORD_ASSUMPTIONS.sharedCap);
  if (affected) assumptions.push(AFFORD_ASSUMPTIONS.extraCut(cutMonth, money(cutCents)));
  if (floored) assumptions.push(AFFORD_ASSUMPTIONS.noDebtGain);
  if (cashLowCents(basePos, baseWalk) < floorCents) assumptions.push(AFFORD_ASSUMPTIONS.alreadyShort);

  return {
    amount: money(cents),
    dateISO,
    baseline: baseFigures,
    proposed: propFigures,
    delta,
    category,
    debt,
    verdict,
    assumptions,
  };
}
