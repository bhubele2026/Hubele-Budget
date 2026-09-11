// ⭐ ONE HOUSEHOLD CALENDAR — America/Chicago.
//
// The household lives in Central time. The server runs in UTC on Render and the
// browser runs wherever the phone is, so "today", "this week" and "this month"
// must never come from the process clock's local fields. Between 7pm and
// midnight Central a UTC server already thinks it is tomorrow: the spine's
// "spent this week" rolled into next week every Saturday evening, and a bank
// snapshot taken after 7pm was stamped with the next day.
//
// Two kinds of function live here, and the split is the whole design:
//   - householdDateOf / householdToday turn an INSTANT into the household's
//     calendar date. This is the only place a timezone is involved.
//   - everything else is pure calendar arithmetic on YYYY-MM-DD strings, done
//     in UTC so it never depends on the machine it runs on.
//
// No dependency: Intl ships in Node and every browser. The formatter is built
// lazily on first use so importing this module costs nothing at load time.

export const HOUSEHOLD_TZ = "America/Chicago";

let formatter: Intl.DateTimeFormat | null = null;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The household's calendar date (YYYY-MM-DD) of an instant. */
export function householdDateOf(instant: Date): string {
  formatter ??= new Intl.DateTimeFormat("en-CA", {
    timeZone: HOUSEHOLD_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(instant);
  const part = (type: "year" | "month" | "day") =>
    parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Today's date for the household (YYYY-MM-DD). */
export function householdToday(now: Date = new Date()): string {
  return householdDateOf(now);
}

function utcDay(iso: string): number {
  return Date.UTC(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10)),
  );
}

function isoOfUtc(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Calendar arithmetic on a YYYY-MM-DD string. */
export function addDaysISO(iso: string, days: number): string {
  return isoOfUtc(utcDay(iso) + days * 86_400_000);
}

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD string. */
export function dayOfWeekISO(iso: string): number {
  return new Date(utcDay(iso)).getUTCDay();
}

/** The Sunday–Saturday week containing a YYYY-MM-DD date. Both ends inclusive. */
export function weekBounds(iso: string): { start: string; end: string } {
  const start = addDaysISO(iso, -dayOfWeekISO(iso));
  return { start, end: addDaysISO(start, 6) };
}

/**
 * The calendar month containing a YYYY-MM-DD date. `end` is the last day
 * (inclusive); `endExclusive` is the first day of the next month.
 */
export function monthBounds(iso: string): {
  start: string;
  end: string;
  endExclusive: string;
} {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${y}-${pad(m)}-${pad(lastDay)}`;
  return { start: `${y}-${pad(m)}-01`, end, endExclusive: addDaysISO(end, 1) };
}
