import { monthFirstISO, monthKeyFromISO, type MonthKey } from "@/components/account-page/month-navigator";
import type { RangeMode } from "@/lib/timeRange";
import type { UrlCodec } from "@/hooks/useUrlState";

/**
 * How the two ledgers (Chase, Amex) spell their view in the address:
 * `?month=YYYY-MM-01` (the form every deep link already uses), `?mode=` and
 * the plain-string params (`account`, `card`).
 */
export const monthParam: UrlCodec<MonthKey> = {
  read: (raw) => (raw && /^\d{4}-\d{2}-01$/.test(raw) ? monthKeyFromISO(raw) : null),
  write: (m) => monthFirstISO(m),
};

const MODE_NAME: Record<RangeMode, string> = { wk: "week", mo: "month", yr: "year" };
const MODE_FROM: Record<string, RangeMode> = { week: "wk", month: "mo", year: "yr" };

export const modeParam: UrlCodec<RangeMode> = {
  read: (raw) => (raw ? (MODE_FROM[raw] ?? null) : null),
  write: (m) => MODE_NAME[m],
};

/** A plain string param; "all" (or empty) is the default and removes it. */
export const pickParam: UrlCodec<string> = {
  read: (raw) => (raw ? raw : null),
  write: (v) => (v && v !== "all" ? v : null),
};

/** Did the address name a month? (A deliberate month is never moved by a first-load jump.) */
export function urlHasMonth(): boolean {
  return (
    typeof window !== "undefined" &&
    monthParam.read(new URLSearchParams(window.location.search).get("month")) != null
  );
}
