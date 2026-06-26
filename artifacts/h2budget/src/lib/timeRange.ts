// Shared weekly-first time-range model. The household lives by the week, so
// `wk` is the default everywhere; `mo`/`yr` are opt-in. Weeks are Sun–Sat to
// match the app's existing convention (weekStartFor / allowance sundayOf /
// currentWeekBounds) — never a new week definition.

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
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Sunday of the week containing `ref`. */
export function weekSunday(ref: Date = new Date()): Date {
  const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  return addDays(d, -d.getDay());
}

export function currentWeekRange(ref: Date = new Date()): DateRange {
  const sun = weekSunday(ref);
  const sat = addDays(sun, 6);
  const sameMonth = sun.getMonth() === sat.getMonth();
  const left = sun.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const right = sat.toLocaleDateString("en-US", {
    month: sameMonth ? undefined : "short",
    day: "numeric",
  });
  return { from: isoOf(sun), to: isoOf(sat), label: `${left} – ${right}`, mode: "wk" };
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
