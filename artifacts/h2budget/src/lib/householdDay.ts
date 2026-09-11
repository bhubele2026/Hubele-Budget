// ⭐ The household calendar in the browser — America/Chicago.
//
// The server now answers every "today", week, month and snapshot-day question
// in Central time (PR2a). The browser has to use the same calendar, or the page
// and the server disagree for five hours every evening. A few places computed
// UTC dates instead: `toISOString().slice(0, 10)` on "now" is tomorrow after
// 7pm Central, and slicing a stored snapshot timestamp gives its UTC day, so a
// 9pm snapshot was treated as tomorrow's.
//
// Imported from the `householdTime` subpath so the page only pulls the calendar,
// never the payoff simulator behind the package root.

import {
  addDaysISO,
  householdDateOf,
  householdToday,
  monthBounds,
  weekBounds,
} from "@workspace/avalanche-core/householdTime";

// `weekBounds` is the household's Sun–Sat week of a YYYY-MM-DD date; pair it
// with `householdToday(now)`, never with a browser-local date.
export { addDaysISO, householdToday, monthBounds, weekBounds };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The household calendar day (YYYY-MM-DD) of a stored timestamp.
 *
 * A bare YYYY-MM-DD is already a day and is returned unchanged — parsing it as
 * an instant would read UTC midnight, which is the previous evening in Chicago.
 */
export function householdDayOfAt(at: string): string {
  if (DATE_ONLY.test(at)) return at;
  const instant = new Date(at);
  // Never throw during render over malformed stored data: `formatToParts` on an
  // Invalid Date raises a RangeError, which would swap the whole page for the
  // error panel. Fall back to the text's own date prefix, as the old slice did.
  if (Number.isNaN(instant.getTime())) return at.slice(0, 10);
  return householdDateOf(instant);
}

/** First day (YYYY-MM-01) of the household's month for an instant. */
export function householdMonthStartOf(instant: Date = new Date()): string {
  return monthBounds(householdDateOf(instant)).start;
}
