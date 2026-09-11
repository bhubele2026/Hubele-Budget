import {
  addDaysISO,
  householdDateOf,
  householdToday,
  monthBounds,
  weekBounds,
} from "@workspace/avalanche-core";

export { addDaysISO, householdDateOf, monthBounds, weekBounds };

/**
 * ⭐ THE SERVER'S "TODAY" IS THE HOUSEHOLD'S — America/Chicago — never the
 * process clock's. Render runs in UTC, so between 7pm and midnight Central
 * `new Date().getDate()` is already tomorrow: the spine's "spent this week"
 * rolled into next week every Saturday evening, and a bank snapshot taken after
 * 7pm was dated the next day.
 *
 * Two shapes of one date:
 *   householdTodayISO()  → "YYYY-MM-DD", for comparisons and SQL bounds.
 *   householdTodayDate() → a Date at SERVER-LOCAL midnight of that same date,
 *     for the existing local-field arithmetic (fmtISO / addDays / parseISO /
 *     getDay in cashSignal and friends), which then stays self-consistent on
 *     any server timezone.
 *
 * ⚠️ Never hand a householdTodayDate() value to householdDateOf() /
 * householdDayOf(): those read their argument as an INSTANT, and local midnight
 * on a UTC server is 7pm the previous evening in Chicago.
 */
export function householdTodayISO(now: Date = new Date()): string {
  return householdToday(now);
}

export function householdTodayDate(now: Date = new Date()): Date {
  const iso = householdToday(now);
  return new Date(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10)),
  );
}

/** The household calendar day an instant (a bank snapshot, say) fell on. */
export function householdDayOf(instant: Date | string): string {
  return householdDateOf(typeof instant === "string" ? new Date(instant) : instant);
}

/** First day of the household's current month, as a server-local midnight Date. */
export function householdMonthStartDate(now: Date = new Date()): Date {
  const start = monthBounds(householdToday(now)).start;
  return new Date(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, 1);
}
