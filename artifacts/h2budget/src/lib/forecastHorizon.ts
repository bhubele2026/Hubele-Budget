import type { UrlCodec } from "@/hooks/useUrlState";

/**
 * ⭐ (C3) THE FORECAST HORIZON — one value for the Forecast detail, the Overview and the
 * dashboard tile (the spine's low point is a 90-day read).
 *
 *   `?horizon=` in the address wins; else the one sessionStorage key; else 90.
 *   The detail's old 30-day default is gone (30 stays one tab away).
 *
 * Pure reads/writes of a choice among the offered horizons; no money here.
 */
export const FORECAST_HORIZON_KEY = "h2budget:forecastHorizonDays";
export const HORIZON_DAYS: readonly number[] = [30, 90, 120, 183, 365];
export const DEFAULT_HORIZON = 90;

/** "90" → 90 when it is one of the offered horizons; anything else is no choice. */
export function parseHorizon(raw: string | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && HORIZON_DAYS.includes(n) ? n : null;
}

export const HORIZON_CODEC: UrlCodec<number> = {
  read: parseHorizon,
  write: (n) => String(n),
};

export function storedHorizon(): number | null {
  try {
    return parseHorizon(sessionStorage.getItem(FORECAST_HORIZON_KEY));
  } catch {
    return null;
  }
}

export function saveHorizon(days: number): void {
  try {
    sessionStorage.setItem(FORECAST_HORIZON_KEY, String(days));
  } catch {
    /* no-op */
  }
}

/** The address's `?horizon=`, then the saved choice, then 90. */
export function currentHorizon(search?: string): number {
  const s = search ?? (typeof window === "undefined" ? "" : window.location.search);
  return parseHorizon(new URLSearchParams(s).get("horizon")) ?? storedHorizon() ?? DEFAULT_HORIZON;
}

/** "/forecast?horizon=90&day=2026-10-22" — the detail, on the horizon (and day) the reader is looking at. */
export function forecastHref(horizon: number, day?: string | null): string {
  const q = new URLSearchParams({ horizon: String(horizon) });
  if (day) q.set("day", day.slice(0, 10));
  return `/forecast?${q.toString()}`;
}

/** The address carries a usable `?horizon=`. */
export function hasHorizonParam(search?: string): boolean {
  const s = search ?? (typeof window === "undefined" ? "" : window.location.search);
  return parseHorizon(new URLSearchParams(s).get("horizon")) != null;
}
