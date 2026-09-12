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
  HOUSEHOLD_TZ,
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Sep 10" for a stored timestamp (or bare day) on the household calendar, with
 * the year only when it isn't this household year. "date unknown" for none.
 */
export function householdDayLabel(
  at: string | null | undefined,
  today: string = householdToday(),
): string {
  if (!at) return "date unknown";
  const day = householdDayOfAt(at);
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return "date unknown";
  const label = `${MONTHS[m - 1]} ${d}`;
  return day.slice(0, 4) === today.slice(0, 4) ? label : `${label}, ${day.slice(0, 4)}`;
}

/**
 * "Sep 11, 4:05 AM" for a stored instant, in household time — never the
 * browser's zone, which would put a failure on another day for a viewer
 * elsewhere. "time unknown" for a malformed value.
 */
export function householdDateTimeLabel(at: string, today: string = householdToday()): string {
  const instant = new Date(at);
  if (Number.isNaN(instant.getTime())) return "time unknown";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HOUSEHOLD_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${householdDayLabel(at, today)}, ${part("hour")}:${part("minute")} ${part("dayPeriod").toUpperCase()}`;
}

/**
 * A browser-local midnight Date for a YYYY-MM-DD day, for pages whose period
 * arithmetic runs on local Date fields. Build the day from the household
 * calendar first (`householdToday(now)`, `monthBounds(...)`), then convert.
 */
export function localDateOf(iso: string): Date {
  return new Date(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10)),
  );
}

/** First day (YYYY-MM-01) of the household's month for an instant. */
export function householdMonthStartOf(instant: Date = new Date()): string {
  return monthBounds(householdDateOf(instant)).start;
}
