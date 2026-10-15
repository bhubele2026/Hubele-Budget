import { agoShort } from "@/lib/accountFreshness";
import { formatCurrency } from "@/lib/utils";

/**
 * (Q5) CAN THE BANK BALANCE BE TRUSTED — four separate facts, said apart.
 *
 *   Updated 2 h ago          when the bank last told us anything (a fetch)
 *   Bank $X · H2 $Y           the bank's own figure beside H2's
 *   Matches bank / Off by $X  the last Sync's check of the two (never the review count)
 *   N pending                 pending rows H2's balance counts
 *
 * Every field is the server's (`spine.bankConfidence`, or the Banking review's
 * `balanceCheck`, which is the same check): this file only chooses words. A
 * dot or chip is green ONLY for a check that matched and is not stale; an
 * unchecked or old check is grey, a difference is rust. Nothing is added up.
 */

export type CheckStatus = "matches" | "off_by" | "resolved_since" | "not_checked";

/** The fields of the server's check that the words read (spine.bankConfidence.check and the review's balanceCheck both fit). */
export interface CheckLike {
  status: CheckStatus;
  reason: string | null;
  stale: boolean;
  checkedAt: string | null;
  difference: string | null;
  direction: "bank_higher" | "bank_lower" | null;
}

export type ConfidenceTone = "ok" | "bad" | "grey";

export interface CheckView {
  /** "Matches bank" · "Off by $62.50 — bank lower" · "Not checked yet — Sync to check" · "Checked 9 days ago" */
  word: string;
  tone: ConfidenceTone;
  /** The check, fresh or old, says the two balances agree (or agreed) */
  matched: boolean;
}

/** Why a check could not run, in a few words. */
export const NOT_CHECKED_SHORT: Record<string, string> = {
  never: "Sync to check",
  not_forecast_account: "planned account only",
  anchor_too_old: "last balance too old",
  balance_unavailable: "bank gave no balance",
};

/** "9 days ago" (whole days); under two days the relative short form. A label only. */
export function checkedAgo(iso: string, now: number): string {
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  return days >= 2 ? `${days} days ago` : (agoShort(iso, now) ?? "");
}

/** "bank higher" / "bank lower": which way the difference runs. */
export const directionShort = (d: CheckLike["direction"]): string | null =>
  d === "bank_higher" ? "bank higher" : d === "bank_lower" ? "bank lower" : null;

export function checkView(c: CheckLike, now: number = Date.now()): CheckView {
  if (c.status === "not_checked") {
    return { word: `Not checked yet — ${NOT_CHECKED_SHORT[c.reason ?? "never"] ?? NOT_CHECKED_SHORT.never}`, tone: "grey", matched: false };
  }
  const when = c.checkedAt ? checkedAgo(c.checkedAt, now) : "";
  const was = c.status === "off_by" && c.difference != null ? ` · was off by ${formatCurrency(c.difference)}` : "";
  // An old answer is never green and never alarming: it says how old it is.
  if (c.stale) return { word: when ? `Checked ${when}${was}` : "Checked earlier", tone: "grey", matched: c.status !== "off_by" };
  if (c.status === "off_by") {
    const dir = directionShort(c.direction);
    return { word: `${c.difference != null ? `Off by ${formatCurrency(c.difference)}` : "Off from bank"}${dir ? ` — ${dir}` : ""}`, tone: "bad", matched: false };
  }
  if (c.status === "resolved_since") return { word: "Resolved since", tone: "ok", matched: true };
  return { word: "Matches bank", tone: "ok", matched: true };
}

export interface ConfidenceInput {
  /** When the bank last told us anything; null with no snapshot */
  fetchedAt: string | null;
  bankBalance: string | null;
  h2Balance: string | null;
  check: CheckLike;
  pendingCount: number;
}

export interface ConfidenceView {
  /** "Updated 2 h ago" — null when nothing was ever fetched */
  updated: string | null;
  /** "Bank $2,985.00 · H2 $3,047.50" — null when either side is unknown */
  balances: string | null;
  check: CheckView;
  /** "1 pending" — null at zero */
  pending: string | null;
  /** The dot is green only for a fresh matching check */
  tone: ConfidenceTone;
}

export function confidenceView(i: ConfidenceInput, now: number = Date.now()): ConfidenceView {
  const ago = agoShort(i.fetchedAt, now);
  const check = checkView(i.check, now);
  return {
    updated: ago ? `Updated ${ago}` : null,
    balances: i.bankBalance != null && i.h2Balance != null ? `Bank ${formatCurrency(i.bankBalance)} · H2 ${formatCurrency(i.h2Balance)}` : null,
    check,
    pending: i.pendingCount > 0 ? `${i.pendingCount} pending` : null,
    tone: check.tone,
  };
}
