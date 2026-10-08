import { addDaysISO } from "@workspace/avalanche-core/householdTime";

/**
 * Words and small, exact helpers for the Plan screens. Nothing here works out a
 * money figure: dollars arrive as the server's strings, and the only arithmetic
 * is `remainingWords` (the planned amount less the actual, in whole cents, the
 * way Today's "Over by $x" is the server's remainder with its sign dropped).
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2028-03" → "Mar 2028". */
export function monthWords(ym: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(ym);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? ""} ${m[1]}` : ym;
}

/** "2026-10-01" → "October 2026". */
export function monthLabel(monthStart: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(monthStart);
  return m ? `${MONTHS_LONG[Number(m[2]) - 1] ?? ""} ${m[1]}` : monthStart;
}

/** Rounded as Today rounds it, so the two screens agree. */
export function pctWords(n: number): string {
  return `${Math.round(n)}%`;
}

export function firstOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** The first of the month `delta` months from `monthStart` (calendar arithmetic on a date, not on money). */
export function shiftMonth(monthStart: string, delta: number): string {
  const y = Number(monthStart.slice(0, 4));
  const m = Number(monthStart.slice(5, 7)) - 1 + delta;
  const year = y + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12;
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-01`;
}

/** The last day of the month `monthStart` opens. */
export function monthEnd(monthStart: string): string {
  return addDaysISO(shiftMonth(monthStart, 1), -1);
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

/** A dollar amount above zero, canonical, or null. */
export function parsePositiveDollars(raw: string): string | null {
  const v = parseDollars(raw);
  return v != null && Number(v) > 0 ? v : null;
}

/** "600.00" → "600" for an input's starting value; "12.50" stays. */
export function plainDollars(amount: string | number | null | undefined): string {
  if (amount == null || amount === "") return "";
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return "";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** APR is stored as a fraction ("0.2499"); people read and type percent. */
export function aprWords(apr: string): string {
  const n = Number(apr);
  return Number.isFinite(n) ? `${Number((n * 100).toFixed(2))}%` : "—";
}
export function aprToPercentInput(apr: string): string {
  const n = Number(apr);
  return Number.isFinite(n) ? String(Number((n * 100).toFixed(2))) : "";
}
export function percentToApr(raw: string): string | null {
  const t = raw.trim().replace(/%$/, "");
  if (!/^\d{1,3}(\.\d{1,3})?$/.test(t) || Number(t) > 100) return null;
  return (Number(t) / 100).toFixed(4);
}

/** The planned amount less the actual, in whole cents; the word, then the dollars. */
export function remainingWords(planned: number, actual: number): { kind: "left" | "over" | "even"; amount: number } {
  const cents = Math.round(planned * 100) - Math.round(actual * 100);
  if (cents === 0) return { kind: "even", amount: 0 };
  return { kind: cents > 0 ? "left" : "over", amount: Math.abs(cents) / 100 };
}

export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`;
}

export const CADENCES = [
  { value: "weekly", label: "Every week" },
  { value: "biweekly", label: "Every two weeks" },
  { value: "semimonthly", label: "Twice a month" },
  { value: "monthly", label: "Every month" },
  { value: "onetime", label: "One time" },
] as const;

export function cadenceWords(frequency: string, dayOfMonth?: number | null): string {
  switch (frequency) {
    case "weekly":
      return "every week";
    case "biweekly":
      return "every two weeks";
    case "semimonthly":
      return "twice a month";
    case "monthly":
      return dayOfMonth ? `monthly, the ${ordinal(dayOfMonth)}` : "monthly";
    case "onetime":
      return "one time";
    case "quarterly":
      return "every quarter";
    case "annual":
      return "every year";
    default:
      return frequency;
  }
}

/** The words for an API error: the owner-only 403 gets its own sentence. */
export function errorWords(e: unknown, fallback = "Couldn't save. Try again."): string {
  const status = (e as { status?: number } | null)?.status;
  if (status === 403) return "Only the household owner can change this.";
  if (status === 409) return "That conflicts with another entry. Check the date.";
  return fallback;
}

export function isISODate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && addDaysISO(s, 0) === s;
}
