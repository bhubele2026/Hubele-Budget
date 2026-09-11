// Shared weekly-first time-range model. The household lives by the week, so
// `wk` is the default everywhere; `mo`/`yr` are opt-in. Weeks are Sun–Sat to
// match the app's existing convention (weekStartFor / allowance sundayOf /
// currentWeekBounds) — never a new week definition.
//
// (PR2) The week is the HOUSEHOLD's (America/Chicago), whatever timezone the
// browser is in. Month and year still read the browser's local date.

import { householdToday, weekBounds } from "./householdDay";

export type RangeMode = "wk" | "mo" | "yr";

export interface DateRange {
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
  label: string;
  mode: RangeMode;
}

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/**
 * "Sep 6" (or "6") for a YYYY-MM-DD. Formatted at noon UTC in UTC, so the
 * browser's own timezone can never shift the day being labelled.
 */
function dayLabel(iso: string, withMonth: boolean): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: withMonth ? "short" : undefined,
    day: "numeric",
  });
}

/**
 * Sunday of the household's week containing the instant `ref`, as a
 * browser-local midnight Date.
 */
export function weekSunday(ref: Date = new Date()): Date {
  const start = weekBounds(householdToday(ref)).start;
  return new Date(
    Number(start.slice(0, 4)),
    Number(start.slice(5, 7)) - 1,
    Number(start.slice(8, 10)),
  );
}

export function currentWeekRange(ref: Date = new Date()): DateRange {
  const { start, end } = weekBounds(householdToday(ref));
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  return {
    from: start,
    to: end,
    label: `${dayLabel(start, true)} – ${dayLabel(end, !sameMonth)}`,
    mode: "wk",
  };
}

export function currentMonthRange(ref: Date = new Date()): DateRange {
  const first = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const last = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
  return {
    from: isoOf(first),
    to: isoOf(last),
    label: ref.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    mode: "mo",
  };
}

export function currentYearRange(ref: Date = new Date()): DateRange {
  const first = new Date(ref.getFullYear(), 0, 1);
  const last = new Date(ref.getFullYear(), 11, 31);
  return { from: isoOf(first), to: isoOf(last), label: `${ref.getFullYear()}`, mode: "yr" };
}

/** Resolve a range for the given mode, anchored to `ref` (defaults to today). */
export function rangeForMode(mode: RangeMode, ref: Date = new Date()): DateRange {
  if (mode === "mo") return currentMonthRange(ref);
  if (mode === "yr") return currentYearRange(ref);
  return currentWeekRange(ref);
}

/** Days spanned by a range, inclusive — handy for `?days=` style endpoints. */
export function rangeDays(r: DateRange): number {
  const a = Date.parse(`${r.from}T00:00:00Z`);
  const b = Date.parse(`${r.to}T00:00:00Z`);
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}
