import { addDaysISO, monthBounds, weekBounds } from "@/lib/householdDay";

/**
 * (W3) The date range of the Banking review: three presets, all on the household
 * calendar (America/Chicago), and an explicit label ("Oct 1 – Oct 14"). Pure.
 * The range is never wider than the server allows (366 days) and never reaches
 * past today, so the page does not send a request the API would refuse.
 */
export type Preset = "week" | "month" | "last";

export const PRESETS: Array<{ key: Preset; label: string }> = [
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "last", label: "Last month" },
];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const isDay = (raw: string | null | undefined): raw is string =>
  !!raw && ISO.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`));

export function presetRange(preset: Preset, today: string): { from: string; to: string } {
  if (preset === "week") return { from: weekBounds(today).start, to: today };
  if (preset === "month") return { from: monthBounds(today).start, to: today };
  const lastMonthDay = addDaysISO(monthBounds(today).start, -1);
  const b = monthBounds(lastMonthDay);
  return { from: b.start, to: b.end };
}

/** A usable range from whatever the address held; the default (this month to today) otherwise. */
export function sanitizeRange(from: string, to: string, today: string): { from: string; to: string } {
  const fallback = presetRange("month", today);
  if (!isDay(from) || !isDay(to)) return fallback;
  if (from > today || to < from) return fallback;
  const cappedTo = to > today ? today : to;
  // At most 366 days, as the API requires.
  if (addDaysISO(from, 366) < cappedTo) return fallback;
  return { from, to: cappedTo };
}

/** Which preset the range is, if any (for the pressed state). */
export function presetOf(range: { from: string; to: string }, today: string): Preset | null {
  for (const p of PRESETS) {
    const r = presetRange(p.key, today);
    if (r.from === range.from && r.to === range.to) return p.key;
  }
  return null;
}

const day = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;

/** "Oct 1 – Oct 14"; the year is added when the range is not in the current year. */
export function rangeWords(range: { from: string; to: string }, today: string): string {
  const yr = (iso: string) => (iso.slice(0, 4) === today.slice(0, 4) ? "" : `, ${iso.slice(0, 4)}`);
  return `${day(range.from)}${yr(range.from)} – ${day(range.to)}${yr(range.to)}`;
}
