// (PR2) Week and day bounds for the Banking page, on the household calendar
// (America/Chicago). They used to read the browser's local date, so a phone
// outside Central time put "this week" and "today" a day off every evening.
// `now` is an INSTANT.
//
// The unused `weeklyBudgetStreak` that lived here is gone (PR2): nothing called
// it, and Allowances keeps its own streaks.

import { addDaysISO, householdToday, weekBounds } from "./householdDay";

/** Household date `n` days before `now` — for bounding the transactions query. */
export function isoDaysAgo(now: Date, n: number): string {
  return addDaysISO(householdToday(now), -n);
}

/** The household's today (YYYY-MM-DD) at the instant `now`. */
export function todayISO(now: Date): string {
  return householdToday(now);
}

/** ISO bounds of the household's Sun–Sat week containing `now`. */
export function currentWeekBounds(now: Date): { startISO: string; endISO: string } {
  const { start, end } = weekBounds(householdToday(now));
  return { startISO: start, endISO: end };
}
