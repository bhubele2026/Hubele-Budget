import { formatCurrency } from "@/lib/utils";
import { dayOf } from "@/lib/accountFreshness";

/**
 * ⭐ (T1) THE CHECKING BALANCE, IN WORDS — docs/contracts/checking-balance.md.
 *
 *   Checking today    the bank's reading rolled forward through the counted rows
 *                     (spine.bank.balance = review balance.today = cashSignal.bankToday);
 *                     the figure every surface leads with, "as of <reading>".
 *   Bank's last reading  the bank's own figure (evidence), dated: never under a
 *                     "today" label. A typed balance is said as typed, never as the bank's.
 *   Starting at       the forecast curve's first point (cashSignal.startingBalance).
 *
 * Words only: every figure is the server's. Household time (America/Chicago).
 */

export const READING_WORDS = "Bank's last reading";
export const TYPED_WORDS = "Typed balance (not from the bank)";

/** "Oct 15, 7:02 AM" on the household's clock; null for no time. */
export function dayTimeOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // Composed from parts: engines disagree on the glue ("Oct 15, 7:02 AM" vs "Oct 15 at 7:02 AM" in WebKit).
  const part = new Map(
    new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Chicago" })
      .formatToParts(d)
      .map((x) => [x.type, x.value] as const),
  );
  return `${part.get("month")} ${part.get("day")}, ${part.get("hour")}:${part.get("minute")} ${part.get("dayPeriod")}`;
}

/**
 * "as of Oct 15" — the day of the reading a current figure is built on (household
 * day). The same words on every surface; the reading line beside it carries the time.
 */
export function asOfWords(iso: string | null | undefined): string | null {
  const d = dayOf(iso ?? null);
  return d ? `as of ${d}` : null;
}

export interface ReadingLike {
  balance: string | number | null | undefined;
  at: string | null | undefined;
  source?: "plaid" | "manual" | string | null;
}

/**
 * "Bank's last reading $0.00 · Oct 15, 7:02 AM" — or, for a balance typed into H2,
 * "Typed balance $0.00 (not from the bank) · Oct 15". `who` names the account
 * ("Chase ••4417") between them when given. Null when there is no reading.
 */
export function readingLine(r: ReadingLike | null | undefined, who?: string | null): string | null {
  if (!r || r.balance == null || r.balance === "" || !r.at) return null;
  const n = Number(r.balance);
  if (!Number.isFinite(n)) return null;
  const typed = r.source === "manual";
  const head = typed ? `Typed balance ${formatCurrency(n)} (not from the bank)` : `${READING_WORDS} ${formatCurrency(n)}`;
  return [head, who || null, typed ? dayOf(r.at) : dayTimeOf(r.at)].filter(Boolean).join(" · ");
}

export const CHECKING_WORDS = "Checking today";
export const NO_READING_WORDS = "No bank reading yet";

export interface SinceLike {
  count: number;
}

/**
 * "+2 rows since" · "no rows since" — what the roll-forward added after the reading.
 * `when` names the day the rows are dated when the caller knows they are all dated
 * today ("+2 rows today"); otherwise they are "since". Null when `since` is absent
 * (nothing rolled, or the response did not carry it): the line then says nothing about rows.
 */
export function rowsWords(since: SinceLike | null | undefined, when: "since" | "today" = "since"): string | null {
  if (!since || !Number.isFinite(since.count)) return null;
  if (since.count <= 0) return "no rows since";
  return `+${since.count} row${since.count === 1 ? "" : "s"} ${when}`;
}

/**
 * ⭐ (C1) THE CALCULATED LINE — the one sentence under "Checking today" on every surface:
 *
 *   "Calculated · bank read $0.00 Oct 15, 4:19 PM · +2 rows since"
 *   "Calculated · bank read $0.00 Oct 15, 4:19 PM · no rows since"
 *   "Typed balance $120.00 (not from the bank) · Oct 15"          (source manual)
 *   "No bank reading yet"                                          (no reading)
 *
 * A real $0.00 reading prints "$0.00"; a missing figure never does. Words only.
 */
export function calculatedLine(reading: ReadingLike | null | undefined, since: SinceLike | null | undefined): string {
  if (!reading || reading.balance == null || reading.balance === "" || !reading.at) return NO_READING_WORDS;
  const n = Number(reading.balance);
  if (!Number.isFinite(n)) return NO_READING_WORDS;
  if (reading.source === "manual") return readingLine(reading) ?? NO_READING_WORDS;
  const read = `bank read ${formatCurrency(n)} ${dayTimeOf(reading.at) ?? ""}`.trim();
  return ["Calculated", read, rowsWords(since)].filter(Boolean).join(" · ");
}
