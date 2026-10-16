import type { UrlCodec } from "@/hooks/useUrlState";

/**
 * ⭐ (T3) `/forecast?day=YYYY-MM-DD` — the selected day lives in the address,
 * so "Review shortfall" (dashboard tile, the page's own low point) and a shared
 * link land on that day. Only a real calendar day is read; anything else is no
 * selection.
 */
export const DAY_CODEC: UrlCodec<string | null> = {
  read: (raw) => {
    if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    const [y, m, d] = raw.split("-").map(Number);
    const t = new Date(Date.UTC(y!, m! - 1, d!));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m! - 1 && t.getUTCDate() === d ? raw : null;
  },
  write: (v) => v,
};

/** Whole days from `from` to `to` (both `YYYY-MM-DD`), calendar arithmetic only. */
function daysBetween(from: string, to: string): number {
  const ms = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/**
 * The horizon a deep-linked day needs: the window runs from `today` through
 * `today + days`, so the smallest offered horizon that reaches `day`, never
 * narrower than the one already chosen (`current`). A day before today, beyond
 * the longest horizon, or no day at all keeps `current` (the day panel then
 * says the day is outside the window).
 */
export function horizonForDay(day: string | null, today: string, offered: readonly number[], current: number): number {
  if (!day || day <= today) return current;
  const need = daysBetween(today, day);
  const fit = [...offered].sort((a, b) => a - b).find((h) => h >= need);
  return fit != null && fit > current ? fit : current;
}

/** The last day of a `YYYY-MM` month, as `YYYY-MM-DD`. */
export function monthEnd(month: string): string | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}
