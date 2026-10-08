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

// ── Any IANA zone (AI-4a) ───────────────────────────────────────────────────
// The recap is texted at each member's own local time, so the schedule needs
// "what calendar date is it THERE" and "what instant is 07:00 THERE". Same
// rule as above: Intl is the only place a zone is involved, and nothing here
// reads the process clock's local fields.

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(tz: string): Intl.DateTimeFormat {
  let f = zoneFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    zoneFormatters.set(tz, f);
  }
  return f;
}

/** The wall-clock fields of an instant in `tz`, read back as if they were UTC. */
function wallAsUtcMs(instantMs: number, tz: string): number {
  const parts = zoneFormatter(tz).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
}

/** Offset of `tz` from UTC at an instant, in milliseconds (positive east of UTC). */
function zoneOffsetMs(instantMs: number, tz: string): number {
  const flat = Math.floor(instantMs / 1000) * 1000;
  return wallAsUtcMs(flat, tz) - flat;
}

/** The calendar date (YYYY-MM-DD) of an instant in any IANA time zone. */
export function localDateInZone(instant: Date, tz: string): string {
  const w = new Date(wallAsUtcMs(instant.getTime(), tz));
  return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`;
}

/**
 * The instant at which the wall clock in `tz` reads `dateISO` `hhmm`.
 *
 * DST-safe by probing both offsets around the wall time (a day either side
 * covers any transition), keeping the candidates whose own offset agrees:
 *   - one agrees: that is the instant (every ordinary day);
 *   - two agree (the repeated hour when clocks fall back): the EARLIER instant;
 *   - none agree (the skipped hour when clocks spring forward): the wall time
 *     is read with the offset in force before the gap, which lands just after
 *     it (02:30 on the spring day is 03:30 daylight time).
 */
export function zonedTimeToUtc(dateISO: string, hhmm: string, tz: string): Date {
  const [hh, mm] = hhmm.split(":").map(Number) as [number, number];
  const naive = Date.UTC(
    Number(dateISO.slice(0, 4)),
    Number(dateISO.slice(5, 7)) - 1,
    Number(dateISO.slice(8, 10)),
    hh,
    mm,
  );
  const before = zoneOffsetMs(naive - 86_400_000, tz);
  const after = zoneOffsetMs(naive + 86_400_000, tz);
  const candidates = [...new Set([before, after])]
    .map((off) => naive - off)
    .filter((t) => zoneOffsetMs(t, tz) === naive - t)
    .sort((a, b) => a - b);
  return new Date(candidates[0] ?? naive - before);
}
