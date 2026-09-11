// Shared weekly-first time-range model. The household lives by the week, so
// `wk` is the default everywhere; `mo`/`yr` are opt-in. Weeks are Sun–Sat to
// match the app's existing convention (weekStartFor / allowance sundayOf /
// currentWeekBounds) — never a new week definition.
//
// (PR2) Week, month and year are the HOUSEHOLD's (America/Chicago), whatever
// timezone the browser is in. `ref` is an INSTANT.

import { householdToday, monthBounds, weekBounds } from "./householdDay";

export type RangeMode = "wk" | "mo" | "yr";

export interface DateRange {
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
  label: string;
  mode: RangeMode;
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
  const { start, end } = monthBounds(householdToday(ref));
  return {
    from: start,
    to: end,
    // "September 2026", formatted in UTC from the day itself (see dayLabel).
    label: new Date(`${start}T12:00:00Z`).toLocaleDateString("en-US", {
      timeZone: "UTC",
      month: "long",
      year: "numeric",
    }),
    mode: "mo",
  };
}

export function currentYearRange(ref: Date = new Date()): DateRange {
  const year = householdToday(ref).slice(0, 4);
  return { from: `${year}-01-01`, to: `${year}-12-31`, label: year, mode: "yr" };
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
