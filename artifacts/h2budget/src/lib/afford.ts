import { addDaysISO, dayOfWeekISO } from "@workspace/avalanche-core/householdTime";

/**
 * Words and small exact helpers for the Afford sheet and the wish list.
 *
 * (F6) Ported from the frozen h2 app (`screens/afford/verdict.ts`,
 * `screens/plan/format.ts` `parseDollars`, `screens/plan/PlanWishlist.tsx`
 * `parseAmount` / `DECISION`, `AffordSheet.tsx` `comingSaturday` / `refusal`)
 * with their tests. Nothing here works out a money figure: the verdict and
 * every before/after figure are the server's (`POST /money/afford`).
 */

export type Verdict = "fits" | "tight" | "breaks_buffer" | "breaks_zero";
/** A `.chip` tone. The verdict is always a WORD first; colour only tints it. */
export type ChipTone = "ok" | "warn" | "bad" | "gray";

export const VERDICT: Record<Verdict, { word: string; chip: ChipTone }> = {
  fits: { word: "Fits", chip: "ok" },
  tight: { word: "Tight", chip: "warn" },
  breaks_buffer: { word: "Would dip below your buffer", chip: "bad" },
  breaks_zero: { word: "Would overdraw", chip: "bad" },
};

export type Decision = "pending" | "approved" | "bought" | "declined";
export const DECISION: Record<Decision, { word: string; chip: ChipTone }> = {
  pending: { word: "Waiting", chip: "warn" },
  approved: { word: "Approved", chip: "ok" },
  bought: { word: "Bought", chip: "ok" },
  declined: { word: "Dropped", chip: "gray" },
};

const MONTH = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", year: "numeric" });

/** "2027-03" → "Mar 2027". */
export function monthWord(ym: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(ym ?? "");
  return m ? MONTH.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))) : null;
}

/** The coming Saturday: today when today is one. */
export function comingSaturday(today: string): string {
  return addDaysISO(today, (6 - dayOfWeekISO(today) + 7) % 7);
}

/**
 * Typed dollars → the canonical string the API takes ("1234.50"), or null when
 * it is not a dollar amount of at most two decimals. A leading "$" and commas
 * are allowed.
 */
export function parseDollars(raw: string): string | null {
  const t = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(t)) return null;
  const [d, c = ""] = t.split(".");
  return `${d}.${c.padEnd(2, "0")}`;
}

/** Dollars typed by a person: "$1,200.50" → 1200.5; blank is no amount; anything else is "bad". */
export function parseAmount(raw: string): number | null | "bad" {
  const s = raw.replace(/[$,\s]/g, "");
  if (s === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return "bad";
  const n = Number(s);
  return n > 1_000_000 ? "bad" : n;
}

export function isWebAddress(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** The message an API error carries, else a plain fallback. */
export function apiMessage(e: unknown, fallback: string): string {
  const data = (e as { data?: { error?: unknown } } | null)?.data;
  if (data && typeof data.error === "string" && data.error.trim()) return data.error;
  const status = (e as { status?: number } | null)?.status;
  if (status === 403) return "Only the household owner can do this.";
  return fallback;
}

/** Words for the server's refusals of an Afford check; anything else gets a plain fallback. */
export function refusal(e: unknown): string {
  const data = (e as { data?: { error?: unknown } } | null)?.data;
  if (data?.error === "date_past_window") return "That day is further out than H2 can see. Pick an earlier day.";
  const status = (e as { status?: number } | null)?.status;
  if (status === 404) return "H2 couldn't find that category or member. Pick again.";
  return apiMessage(e, "Couldn't check that. Nothing changed.");
}
