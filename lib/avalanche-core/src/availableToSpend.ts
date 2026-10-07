// ⭐ (PR-B1) THE MONEY POSITION — "how much can we spend right now, and are we
// within plan?" — computed, never estimated by anything but this code.
//
// The owner's question (2026-10-07 plan, "Primary purpose"): discretionary
// money until payday, and whether this week is within plan. Two ceilings, and
// the smaller one wins:
//
//   1. CASH UNTIL PAYDAY. Payday is the first paycheck still ahead on the cash
//      curve. Until it lands, the lowest end-of-day balance the curve expects
//      (every bill, debt minimum and payoff already on it) is all the cash
//      there is to work with; the household's cash buffer and any money held
//      back for goals stay out of reach:
//          availableUntilPayday = max(0, lowest before payday − buffer − reserves)
//      ⭐ (Round 2, lead's ruling on PR-B1 Q1) The window is today THROUGH
//      payday, and on payday itself the bills count before the paycheck: that
//      day reads its end-of-day balance less every income event dated payday.
//      A bill the ledger lands on payday (one due today, dragged to the next
//      business day, or one simply due that day) can post before the deposit,
//      so leaving it out would read HIGH by that bill.
//   2. THE WEEK'S PLAN. The weekly cap minus what this Sunday–Saturday week has
//      already spent from it:
//          remainingWeek = weekCap − spentWeekDiscretionary
//
//   safeToSpendNow = max(0, min(remainingWeek, availableUntilPayday))
//
// "The forecast may read low, never high" (owner, 2026-09-15) carries over:
//   - only the curve's own events count, so an unconfirmed guess never raises
//     the figure (a paycheck a bank row matched away is already off the curve);
//   - available credit is never counted — a card's open-to-buy is not money;
//   - money that has not been filed yet (`needs_classification`) counts AGAINST
//     the weekly cap until someone files it. Deliberate: an unfiled purchase is
//     still a purchase, and leaving it out would let the cap read high. Filing
//     it unplanned (or matching it to a bill) gives that room back;
//   - with no bank data (`status: "no_data"`) or no curve the cash figures are
//     null — never a false zero, never a false "plenty".
//
// Pure and dependency-free (see the package header). All arithmetic is in
// whole cents; every money figure leaves as a `toFixed(2)` string.
//
// ⚠️ THE CREDIT / DEBT LAW. The returned object never carries a key naming
// credit or a limit, and never a debt balance or amount owed
// (`availableToSpend.test.ts`, and the spine's landing-law test). The weekly
// ceiling is a CAP the household set, named `weekCap`.

import { addDaysISO, dayOfWeekISO, householdDateOf, weekBounds } from "./householdTime";
import type { MovementCoverage } from "./householdMoney";

/** How far ahead a paycheck still counts as "payday" for this figure. */
export const PAYDAY_MAX_DAYS = 45;
/**
 * A deposit is a payday only when it is at least this share of the largest
 * active income plan's amount — so a $40 reimbursement plan never ends the
 * window early and makes the low point look higher than it is.
 */
export const PAYDAY_MIN_SHARE = 0.25;

export type PositionEventKind = "income" | "expense" | "actual";

/** One event on the cash curve, as the forecast ledger placed it. */
export interface PositionEvent {
  /** `YYYY-MM-DD` — the day it lands on the curve. */
  date: string;
  /** Signed dollars, like the ledger: negative is money out. */
  amount: number;
  /** A planned paycheck, a planned outflow, or a real checking row. */
  kind: PositionEventKind;
  /** The plan's item id (or synthetic id); the transaction id for an actual row. */
  itemId: string;
  label: string;
  /** The ledger's tag when it moved the plan off its due date (`overdue_assumed_unpaid`, …). */
  assumption?: string | null;
  /** "estimate" when the plan's amount is expected to vary. Absent reads "fixed". */
  amountKind?: "fixed" | "estimate";
}

export interface PositionIncomeItem {
  id: string;
  amount: number | string;
  frequency: string;
  active: boolean;
}

/** A row of the current household week, already classified (`classifyMovement`) and sized (`spendAmount`). */
export interface PositionWeekRow {
  coverage: MovementCoverage;
  /** `spendAmount(row)`: positive dollars for an outflow, 0 otherwise. */
  spend: number;
}

export interface PositionFreshness {
  stale: boolean;
  staleReason: string | null;
  /** When the bank balance was read (an ISO instant), or null with no snapshot. */
  asOfBank: string | null;
}

export type PositionStatus = "ready" | "tight" | "not_yet" | "no_data";

export interface PositionInputs {
  /** The household's today, `YYYY-MM-DD`. */
  todayISO: string;
  /** The curve's end-of-day balances, from today on (`computeCashSignal().daily`). */
  daily: ReadonlyArray<{ date: string; balance: string | number }>;
  /** The events on that curve (plans and real rows), in date order. */
  events: readonly PositionEvent[];
  /** The household's income plans: the largest active one sets the payday threshold. */
  incomeItems: readonly PositionIncomeItem[];
  cashBuffer: number | string;
  /** Money set aside for goals and still in checking. 0 until goals ship. */
  reservesHeld?: number | string;
  /** This week's cap in dollars, or null when the household has set none. */
  weekCap: number | string | null;
  /** Every row of the current Sunday–Saturday week, classified. */
  weekRows: readonly PositionWeekRow[];
  freshness: PositionFreshness;
  /** `computeCashSignal().status`. */
  status: PositionStatus;
}

export type WithinPlan = "over" | "tight" | "yes";

export interface PositionEstimate {
  itemId: string;
  label: string;
  /** Signed, like the event. */
  amount: string;
  date: string;
}

export interface MoneyPosition {
  todayISO: string;
  status: PositionStatus;
  /** The payday that closes the window, or null when none is within 45 days. */
  paydayDate: string | null;
  payday: { itemId: string; label: string; amount: string } | null;
  /**
   * The window the cash figures cover, both ends inclusive. `payday`: today
   * through `endDate`, the payday — on payday the bills count and the paycheck
   * does not. `week_end`: no payday within 45 days, so today through
   * `endDate`, this week's Saturday. `lastDay` is the last day counted.
   */
  horizon: { kind: "payday" | "week_end"; endDate: string; lastDay: string };
  /**
   * The lowest end-of-day balance the curve expects in the window — payday's
   * own day read before its paycheck — or null with no curve.
   */
  lowestUntilPayday: string | null;
  lowestUntilPaydayDate: string | null;
  /** Σ |planned outflows| landing in the window, payday's own bills included. */
  committedUntilPayday: string;
  cashBuffer: string;
  reservesHeld: string;
  /** max(0, lowest − buffer − reserves); null with no bank data or no curve — never a false zero. */
  availableUntilPayday: string | null;
  weekStart: string;
  weekEnd: string;
  /** This week's cap, or null when none is set. */
  weekCap: string | null;
  /** Weekly-allowance spend plus spend not yet filed: what counts against the cap. */
  spentWeekDiscretionary: string;
  /** The part of `spentWeekDiscretionary` not yet filed. */
  needsClassificationWeek: string;
  /** Spend filed unplanned this week — on top of the cap, never inside it. */
  unplannedWeek: string;
  /** Spend filed to the monthly allowance this week. */
  monthlyWeek: string;
  /** weekCap − spentWeekDiscretionary (negative when over); null with no cap. */
  remainingWeek: string | null;
  /** How much of the cap an even pace allows by the end of today; null with no cap. */
  paceAllowedToday: string | null;
  withinPlan: WithinPlan | null;
  /** max(0, min(remainingWeek, availableUntilPayday)); null when availableUntilPayday is null. */
  safeToSpendNow: string | null;
  confidence: "firm" | "estimated";
  estimates: PositionEstimate[];
  assumptions: string[];
  /** The bank data is stale: every figure is from the last good snapshot. */
  degraded: boolean;
  degradedReason: string | null;
}

/** Fixed wording the position always carries. */
export const POSITION_ASSUMPTIONS = {
  noCredit: "available credit is not counted",
  noBank: "no bank balance yet",
  bankFrom: (day: string) => `bank data from ${day}`,
  noPayday: `no payday in the next ${PAYDAY_MAX_DAYS} days: counted to Saturday`,
  paydayBillsFirst: "bills due on payday are counted before the paycheck",
  unfiledCounts: "spending not yet filed counts against the weekly cap",
} as const;

const toCents = (v: number | string | null | undefined): number | null => {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const money = (cents: number): string => (cents / 100).toFixed(2);

/**
 * The payday the window closes on, or null: the earliest INCOME event on the
 * curve dated after today and within 45 days whose amount is at least 25% of
 * the largest active income plan. A paycheck a bank row already matched away
 * (confirmed, or a tier-1/2 pair) is not on the curve, so it can never be
 * chosen — the next one is.
 */
export function selectPayday(
  todayISO: string,
  events: readonly PositionEvent[],
  incomeItems: readonly PositionIncomeItem[],
): PositionEvent | null {
  let largest = 0;
  for (const item of incomeItems) {
    if (!item.active) continue;
    const c = Math.abs(toCents(item.amount) ?? 0);
    if (c > largest) largest = c;
  }
  const lastISO = addDaysISO(todayISO, PAYDAY_MAX_DAYS);
  let best: PositionEvent | null = null;
  for (const e of events) {
    if (e.kind !== "income") continue;
    if (e.date <= todayISO || e.date > lastISO) continue;
    const c = toCents(e.amount) ?? 0;
    // ≥ 25% of the largest active income plan, in whole cents (a quarter of an
    // integer is exact in binary, so the boundary is exact too).
    if (c <= 0 || c < largest * PAYDAY_MIN_SHARE) continue;
    if (!best || e.date < best.date) best = e;
  }
  return best;
}

/**
 * ⭐ THE MONEY POSITION. See the file header for every rule; the review note
 * (docs/reviews/2026-10-07-prb1-money-position.md) works the formulas through.
 */
export function computePosition(inputs: PositionInputs): MoneyPosition {
  const { todayISO } = inputs;
  const week = weekBounds(todayISO);

  // ── The window: today through payday, or through Saturday when no payday is near.
  const payday = selectPayday(todayISO, inputs.events, inputs.incomeItems);
  const horizon: MoneyPosition["horizon"] = payday
    ? { kind: "payday", endDate: payday.date, lastDay: payday.date }
    : { kind: "week_end", endDate: week.end, lastDay: week.end };
  const inWindow = (iso: string): boolean => iso >= todayISO && iso <= horizon.lastDay;
  // On payday the paycheck — and any other deposit plan dated that day — does
  // not count: the day's bills may post before it.
  const paydayIncome = (e: PositionEvent): boolean =>
    payday != null && e.kind === "income" && e.date === payday.date;
  let paydayIncomeCents = 0;
  for (const e of inputs.events) if (paydayIncome(e)) paydayIncomeCents += toCents(e.amount) ?? 0;

  // ── Lowest end-of-day balance in the window (first day it is reached);
  // payday's own day before its paycheck.
  let lowestCents: number | null = null;
  let lowestDate: string | null = null;
  for (const d of inputs.daily) {
    if (!inWindow(d.date)) continue;
    let c = toCents(d.balance);
    if (c == null) continue;
    if (payday && d.date === payday.date) c -= paydayIncomeCents;
    if (lowestCents == null || c < lowestCents) {
      lowestCents = c;
      lowestDate = d.date;
    }
  }

  // ── What the window holds: planned outflows, estimates, assumption tags.
  let committedCents = 0;
  let estimated = false;
  const estimates: PositionEstimate[] = [];
  const tags: string[] = [];
  for (const e of inputs.events) {
    if (!inWindow(e.date) || paydayIncome(e)) continue;
    if (e.kind === "expense") committedCents += Math.abs(toCents(e.amount) ?? 0);
    if (e.kind !== "actual" && e.amountKind === "estimate") {
      estimated = true;
      estimates.push({ itemId: e.itemId, label: e.label, amount: money(toCents(e.amount) ?? 0), date: e.date });
    }
    if (e.assumption && !tags.includes(e.assumption)) tags.push(e.assumption);
  }

  const bufferCents = toCents(inputs.cashBuffer) ?? 0;
  const reservesCents = toCents(inputs.reservesHeld ?? 0) ?? 0;
  const availableCents =
    inputs.status === "no_data" || inputs.daily.length === 0 || lowestCents == null
      ? null
      : Math.max(0, lowestCents - bufferCents - reservesCents);

  // ── The week: what counts against the cap, and what sits beside it.
  let discretionary = 0;
  let unfiled = 0;
  let unplanned = 0;
  let monthly = 0;
  for (const r of inputs.weekRows) {
    const c = toCents(r.spend) ?? 0;
    if (r.coverage === "allowance_weekly") discretionary += c;
    else if (r.coverage === "needs_classification") {
      discretionary += c;
      unfiled += c;
    } else if (r.coverage === "unplanned") unplanned += c;
    else if (r.coverage === "allowance_monthly") monthly += c;
  }

  const capCents = toCents(inputs.weekCap);
  let remainingCents: number | null = null;
  let paceCents: number | null = null;
  let withinPlan: WithinPlan | null = null;
  if (capCents != null) {
    remainingCents = capCents - discretionary;
    const dow = dayOfWeekISO(todayISO); // 0 = Sunday
    const elapsedDaysInclToday = dow + 1;
    const daysLeftInclToday = 7 - dow;
    paceCents = Math.round((capCents * elapsedDaysInclToday) / 7);
    // tight: less left than an even share of the cap for the days left (today included).
    // Compared ×7 so no cent is rounded away at the boundary.
    if (discretionary > capCents) withinPlan = "over";
    else if (remainingCents * 7 < capCents * daysLeftInclToday) withinPlan = "tight";
    else withinPlan = "yes";
  }

  const safeCents =
    availableCents == null
      ? null
      : Math.max(0, remainingCents == null ? availableCents : Math.min(remainingCents, availableCents));

  // ── Assumptions: the ledger's own tags, then the fixed wording.
  const assumptions = [...tags, POSITION_ASSUMPTIONS.noCredit];
  const bankAt = inputs.freshness.asOfBank ? new Date(inputs.freshness.asOfBank) : null;
  assumptions.push(
    bankAt && Number.isFinite(bankAt.getTime())
      ? POSITION_ASSUMPTIONS.bankFrom(householdDateOf(bankAt))
      : POSITION_ASSUMPTIONS.noBank,
  );
  assumptions.push(payday ? POSITION_ASSUMPTIONS.paydayBillsFirst : POSITION_ASSUMPTIONS.noPayday);
  if (unfiled > 0 && capCents != null) assumptions.push(POSITION_ASSUMPTIONS.unfiledCounts);

  return {
    todayISO,
    status: inputs.status,
    paydayDate: payday ? payday.date : null,
    payday: payday ? { itemId: payday.itemId, label: payday.label, amount: money(toCents(payday.amount) ?? 0) } : null,
    horizon,
    lowestUntilPayday: lowestCents == null ? null : money(lowestCents),
    lowestUntilPaydayDate: lowestDate,
    committedUntilPayday: money(committedCents),
    cashBuffer: money(bufferCents),
    reservesHeld: money(reservesCents),
    availableUntilPayday: availableCents == null ? null : money(availableCents),
    weekStart: week.start,
    weekEnd: week.end,
    weekCap: capCents == null ? null : money(capCents),
    spentWeekDiscretionary: money(discretionary),
    needsClassificationWeek: money(unfiled),
    unplannedWeek: money(unplanned),
    monthlyWeek: money(monthly),
    remainingWeek: remainingCents == null ? null : money(remainingCents),
    paceAllowedToday: paceCents == null ? null : money(paceCents),
    withinPlan,
    safeToSpendNow: safeCents == null ? null : money(safeCents),
    confidence: estimated ? "estimated" : "firm",
    estimates,
    assumptions,
    degraded: inputs.freshness.stale,
    degradedReason: inputs.freshness.stale ? inputs.freshness.staleReason : null,
  };
}
