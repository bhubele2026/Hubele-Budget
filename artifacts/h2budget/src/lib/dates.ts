import { householdDateOf } from "@workspace/avalanche-core/householdTime";

/**
 * Calendar dates as words. Every input is a household calendar date
 * (YYYY-MM-DD) and every format runs in UTC, so the words never depend on the
 * zone of the device reading them. Instants go through `householdDateOf`
 * (America/Chicago) first.
 *
 * (C0) Ported unchanged from the frozen h2 app (`artifacts/h2/src/lib/dates.ts`)
 * with its tests, for the screens folded in from it (parity review F1–F10).
 * h2 is deleted at the switch; this copy is the one that stays. Never import
 * across the two apps.
 */
function utcDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

const LONG = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "long",
  month: "long",
  day: "numeric",
});
const SHORT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});

/** "Tuesday, October 7" for a YYYY-MM-DD date. */
export function longDate(iso: string): string {
  const d = utcDate(iso);
  return d ? LONG.format(d) : "";
}

/** "Oct 7" for a YYYY-MM-DD date. */
export function shortDate(iso: string): string {
  const d = utcDate(iso);
  return d ? SHORT.format(d) : "";
}

/** "Oct 7" for an ISO instant, read on the household's calendar. */
export function shortDateOfInstant(isoInstant: string): string {
  const t = new Date(isoInstant);
  if (Number.isNaN(t.getTime())) return "";
  return shortDate(householdDateOf(t));
}

/**
 * "12 minutes ago". Ported from the classic app's `formatRelativeTime` so the
 * two apps describe the same moment in the same words. Future instants (clock
 * skew) read "just now", never "in 3 minutes".
 */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const diffMs = now.getTime() - then.getTime();
  if (diffMs < 30 * 1000) return "just now";
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} ${min === 1 ? "minute" : "minutes"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ${hr === 1 ? "hour" : "hours"} ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day} days ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk} ${wk === 1 ? "week" : "weeks"} ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo} ${mo === 1 ? "month" : "months"} ago`;
  const yr = Math.floor(day / 365);
  return `${yr} ${yr === 1 ? "year" : "years"} ago`;
}

const WEEKDAY_SHORT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
});

/** "Fri, Oct 9" for a YYYY-MM-DD date. */
export function weekdayDate(iso: string): string {
  const d = utcDate(iso);
  return d ? WEEKDAY_SHORT.format(d) : "";
}

/** "today" / "tomorrow" / "yesterday", else "Fri, Oct 9" — `today` is the household's date. */
export function dayWord(iso: string, today: string): string {
  const a = utcDate(iso);
  const b = utcDate(today);
  if (!a || !b) return "";
  const diff = Math.round((a.getTime() - b.getTime()) / 86_400_000);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  return weekdayDate(iso);
}
