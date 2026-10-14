import { addDaysISO, monthBounds, weekBounds } from "@/lib/householdDay";

/**
 * (W5) Dates for the This week / This month pages. Pure, on YYYY-MM-DD strings
 * (no Date object, so no timezone shifts a day). No money in here.
 */
export type PeriodView = "week" | "month";

/** The server tracks spending from this day; a period ending before it is refused. */
export const TRACKING_START = "2026-05-01";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function isIsoDay(raw: string | null | undefined): raw is string {
  if (!raw || !ISO.test(raw)) return false;
  const d = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw;
}

/** The first day of the period that holds `iso`: its Sunday, or the 1st. */
export function periodStartOf(view: PeriodView, iso: string): string {
  return view === "week" ? weekBounds(iso).start : monthBounds(iso).start;
}

/** The period a `?start=` names: today's period when it is missing, junk or in the future. */
export function resolveStart(view: PeriodView, param: string, today: string): string {
  const current = periodStartOf(view, today);
  if (!isIsoDay(param)) return current;
  const start = periodStartOf(view, param);
  return start > current ? current : start;
}

export function periodEnd(view: PeriodView, start: string): string {
  return view === "week" ? addDaysISO(start, 6) : monthBounds(start).end;
}

/** The period before / after (`dir` -1 or +1). */
export function shiftPeriod(view: PeriodView, start: string, dir: -1 | 1): string {
  if (view === "week") return addDaysISO(start, 7 * dir);
  return dir < 0 ? monthBounds(addDaysISO(start, -1)).start : monthBounds(addDaysISO(monthBounds(start).end, 1)).start;
}

/** The server cannot read a period that ended before tracking began. */
export function canGoBack(view: PeriodView, start: string): boolean {
  return periodEnd(view, shiftPeriod(view, start, -1)) >= TRACKING_START;
}

function dayWords(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
}

/** "Sun Oct 11 – Sat Oct 17" */
export function weekRangeWords(start: string): string {
  return `${dayWords(start)} – ${dayWords(addDaysISO(start, 6))}`;
}

/** "October 2026" */
export function monthWords(start: string): string {
  return `${MONTHS_LONG[Number(start.slice(5, 7)) - 1]} ${start.slice(0, 4)}`;
}

/** "Sun Oct 11" */
export function startWords(iso: string): string {
  return dayWords(iso);
}

/** The header line: "This week · Sun Oct 11 – Sat Oct 17", "Week · …" for another week. */
export function periodTitle(view: PeriodView, start: string, isCurrent: boolean): string {
  const range = view === "week" ? weekRangeWords(start) : monthWords(start);
  const lead = view === "week" ? (isCurrent ? "This week" : "Week") : isCurrent ? "This month" : "Month";
  return `${lead} · ${range}`;
}
