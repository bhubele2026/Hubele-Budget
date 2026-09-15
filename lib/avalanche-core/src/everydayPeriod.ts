// (PR8r, plan section A) THE EVERYDAY PAYOFF PERIODS — pure calendar arithmetic
// on the household calendar (`householdTime.ts`: Sunday–Saturday weeks,
// calendar months, YYYY-MM-DD strings, no timezone involved).
//
//   - a WEEKLY period is a Sunday–Saturday week, paid on its Saturday;
//   - a MONTHLY period is a calendar month, paid on the 1st of the next month.
//
// `householdMoney.ts` reads it for a card row's timing ("via an Amex payoff on
// date Y") and `everydayReserve.ts` for the payoffs themselves, so a charge and
// the payoff that settles it can never be put in two different periods.

import { addDaysISO, dayOfWeekISO, monthBounds, weekBounds } from "./householdTime";

export type EverydayCadence = "weekly" | "monthly";

export interface EverydayPeriod {
  cadence: EverydayCadence;
  /** First day: the Sunday, or the 1st. Inclusive. */
  start: string;
  /** Last day: the Saturday, or the month's last day. Inclusive. */
  end: string;
  /** The day the hook pays the period: the Saturday (`end`), or the 1st of the next month. */
  payoffDate: string;
}

/** The period of `cadence` that contains `iso`. */
export function everydayPeriodOf(cadence: EverydayCadence, iso: string): EverydayPeriod {
  if (cadence === "weekly") {
    const { start, end } = weekBounds(iso);
    return { cadence, start, end, payoffDate: end };
  }
  const { start, end, endExclusive } = monthBounds(iso);
  return { cadence, start, end, payoffDate: endExclusive };
}

/** Every period of `cadence` whose payoff date falls in [fromISO, toISO], in date order. */
export function everydayPeriodsPaidBetween(
  cadence: EverydayCadence,
  fromISO: string,
  toISO: string,
): EverydayPeriod[] {
  const out: EverydayPeriod[] = [];
  if (toISO < fromISO) return out;
  if (cadence === "weekly") {
    // The first Saturday on or after `fromISO` is the end of its own week.
    for (let saturday = weekBounds(fromISO).end; saturday <= toISO; saturday = addDaysISO(saturday, 7)) {
      out.push(everydayPeriodOf("weekly", saturday));
    }
    return out;
  }
  let first = fromISO.endsWith("-01") ? fromISO : monthBounds(fromISO).endExclusive;
  for (; first <= toISO; first = monthBounds(first).endExclusive) {
    out.push(everydayPeriodOf("monthly", addDaysISO(first, -1)));
  }
  return out;
}

/**
 * The next business day (Monday–Friday) strictly after `iso`: a Friday rolls to
 * Monday. The ISO twin of `nextBusinessDay` (`artifacts/api-server/src/lib/
 * cashSignal.ts`), the drag target every overdue plan uses.
 */
export function nextBusinessDayISO(iso: string): string {
  let day = addDaysISO(iso, 1);
  while (dayOfWeekISO(day) === 0 || dayOfWeekISO(day) === 6) day = addDaysISO(day, 1);
  return day;
}
