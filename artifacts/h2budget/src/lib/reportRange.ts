import { rangeForMode, rangeDays, type RangeMode } from "./timeRange";
import { fmtISO } from "./reportsAnalytics";

/**
 * (R) THE PERIOD A REPORT SHOWS, AS ADDRESS STATE.
 *
 *   ?mode=wk|mo|yr            a preset (wk is the default and is not written)
 *   ?from=YYYY-MM-DD&to=...   a custom span (a hub tile's "Last 30 days"); no preset is lit
 *
 * A custom span wins over `mode` when both dates are real and `from <= to`. Pure: no clock
 * except the `ref` instant a caller hands in. The preset window is the pages' own (today back
 * `rangeDays` of the mode), unchanged, so no report figure moves.
 */
export interface ReportSpan {
  /** The lit preset; null for a custom span. */
  mode: RangeMode | null;
  from: string;
  to: string;
  /** Days back from `to` to `from` (the pages' `rangeDays`). */
  days: number;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const MODES: readonly RangeMode[] = ["wk", "mo", "yr"];

/** A real calendar day, as a browser-local midnight Date; null for anything else. */
export function parseDay(iso: string | null | undefined): Date | null {
  const m = iso ? ISO.exec(iso) : null;
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return fmtISO(d) === iso ? d : null;
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / 86_400_000);
}

/** The span an address names. `ref` is "now" (tests pass it). */
export function spanFromSearch(search: string, ref: Date = new Date()): ReportSpan {
  const p = new URLSearchParams(search);
  const from = parseDay(p.get("from"));
  const to = parseDay(p.get("to"));
  if (from && to && from <= to) {
    return { mode: null, from: fmtISO(from), to: fmtISO(to), days: daysBetween(from, to) };
  }
  const raw = p.get("mode");
  const mode: RangeMode = MODES.includes(raw as RangeMode) ? (raw as RangeMode) : "wk";
  const days = rangeDays(rangeForMode(mode, ref));
  const back = new Date(ref);
  back.setDate(back.getDate() - days);
  return { mode, from: fmtISO(back), to: fmtISO(ref), days };
}

/** The address for a preset: `mode` set (wk = absent), `from`/`to` dropped; other params kept. */
export function searchWithMode(search: string, mode: RangeMode): string {
  const p = new URLSearchParams(search);
  p.delete("from");
  p.delete("to");
  if (mode === "wk") p.delete("mode");
  else p.set("mode", mode);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

/** "?from=…&to=…" for a custom span. */
export function spanQuery(from: string, to: string): string {
  return `?${new URLSearchParams({ from, to }).toString()}`;
}

/** The hub's "Last 30 days": today back 30 days — the window `/reports/spending-facts` is asked for. */
export function lastDaysSpan(days: number, ref: Date = new Date()): { from: string; to: string } {
  const back = new Date(ref);
  back.setDate(back.getDate() - days);
  return { from: fmtISO(back), to: fmtISO(ref) };
}

/** "Oct 9 – Nov 8" (the year is added when the span leaves the current one). */
export function spanLabel(from: string, to: string): string {
  const a = parseDay(from);
  const b = parseDay(to);
  if (!a || !b) return `${from} – ${to}`;
  const fmt = (d: Date, withYear: boolean) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: withYear ? "numeric" : undefined });
  const year = new Date().getFullYear();
  const withYear = a.getFullYear() !== b.getFullYear() || b.getFullYear() !== year;
  return `${fmt(a, withYear)} – ${fmt(b, withYear)}`;
}
