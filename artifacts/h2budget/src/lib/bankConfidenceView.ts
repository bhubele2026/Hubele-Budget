import { agoShort, dayOf } from "@/lib/accountFreshness";
import { formatCurrency } from "@/lib/utils";

/**
 * (Q5) CAN THE BANK BALANCE BE TRUSTED — four separate facts, said apart.
 *
 *   Updated 2 h ago                 when the bank last told us anything (a fetch)
 *   Checking $Y today · bank read …  H2's balance today beside the bank's reading
 *   Balances match / Difference …   the last Sync's check of the two (never the review count)
 *   N pending                       pending rows H2's balance counts
 *
 * ⭐ (T2) THE CHECK, ONE STATE MACHINE (`checkState`). The server's
 * status / stale / staleReason / difference / direction / lastDrift are the only
 * inputs; this picks ONE chip, one line and one action:
 *
 *   matches, fresh            Balances match          ok     —
 *   off_by, fresh             Difference needs review rust   Review difference
 *   resolved_since            Resolved since          ok (grey when only age) —
 *   matches/off_by, stale     Check is out of date    grey   Sync to check
 *   not_checked               Not checked             grey   Sync to check
 *
 * plus a history line when an earlier check was off ("Earlier: off by $D on
 * <day>"). The dashboard tile and header chips read the same chip words
 * (`checkView`). Green only for a check that matched (or was explained) and is
 * not out of date; a difference is rust; nothing is ever added up here.
 */

export type CheckStatus = "matches" | "off_by" | "resolved_since" | "not_checked";
export type CheckStaleReason = "age" | "anchor_changed" | "rows_since";

/** The fields of the server's check that the words read (spine.bankConfidence.check and the review's balanceCheck both fit). */
export interface CheckLike {
  status: CheckStatus;
  reason: string | null;
  stale: boolean;
  /** Why it is out of date (first reason wins); absent on old payloads. */
  staleReason?: CheckStaleReason | string | null;
  checkedAt: string | null;
  difference: string | null;
  direction: "bank_higher" | "bank_lower" | null;
  /** The bank's figure the check compared (the review's check only). */
  bank?: { balance: string; at: string } | null;
  /** H2's figure at the check (the review's check only). */
  h2?: { balance: string } | null;
  /** The last EARLIER check that was off (the review's check only). */
  lastDrift?: { checkedAt: string; difference: string; direction?: string | null } | null;
}

export type ConfidenceTone = "ok" | "bad" | "grey";

export interface CheckView {
  /** The chip: "Balances match" · "Difference needs review" · "Resolved since" · "Check is out of date" · "Not checked" */
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

/** (T2) The not-checked line, when there is more to say than the action. */
const NOT_CHECKED_LINE: Record<string, string> = {
  not_forecast_account: "H2 checks the planned account only.",
  anchor_too_old: "The last balance was too old to compare.",
  balance_unavailable: "The bank gave no balance.",
};

export const CHECK_CHIP = {
  matches: "Balances match",
  off_by: "Difference needs review",
  resolved_since: "Resolved since",
  stale: "Check is out of date",
  not_checked: "Not checked",
} as const;

/** "9 days ago" (whole days); under two days the relative short form. A label only. */
export function checkedAgo(iso: string, now: number): string {
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  return days >= 2 ? `${days} days ago` : (agoShort(iso, now) ?? "");
}

/** "bank higher" / "bank lower": which way the difference runs. */
export const directionShort = (d: CheckLike["direction"]): string | null =>
  d === "bank_higher" ? "bank higher" : d === "bank_lower" ? "bank lower" : null;

/** The same moment, whatever its format (avalanche-core `sameAnchorMoment`, for the view). */
function sameMoment(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isNaN(x) || Number.isNaN(y) ? a === b : x === y;
}

const cents = (v: string | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/** Today's figures beside the check (the Banking review's balance). */
export interface CheckToday {
  /** H2's balance today. */
  h2: string | null;
  /** The bank's reading it rolls forward from. */
  reading: string | null;
  /** When that reading was taken. */
  asOf: string | null;
  /** Where the reading came from: a typed balance is not the bank's. */
  source?: "plaid" | "manual" | string | null;
}

export interface CheckState {
  chip: string;
  tone: ConfidenceTone;
  /** One line, the check's own moment ("At the last check (Oct 15) the bank was …"); null when the chip says it all. */
  line: string | null;
  /** "Today H2 $0.00 and the bank $0.00 agree." — a difference stands, but today's two figures are one reading. */
  agree: string | null;
  /** "Earlier: off by $D on <day>" — an earlier check that was off. */
  history: string | null;
  /** The one action: open the investigation, or Sync to check again. */
  action: "review" | "sync" | null;
}

/** ⭐ (T2) The check's chip, line and action. Words only; every figure is the server's. */
export function checkState(c: CheckLike, now: number = Date.now(), today?: CheckToday | null): CheckState {
  const day = c.checkedAt ? dayOf(c.checkedAt) : null;
  const atDay = day ? ` (${day})` : "";
  const diff = c.difference != null ? formatCurrency(c.difference) : null;
  const history = c.lastDrift ? `Earlier: off by ${formatCurrency(c.lastDrift.difference)}${dayOf(c.lastDrift.checkedAt) ? ` on ${dayOf(c.lastDrift.checkedAt)}` : ""}` : null;
  const base = { agree: null, history } as const;

  if (c.status === "not_checked") {
    const reason = c.reason ?? "never";
    return {
      ...base,
      chip: CHECK_CHIP.not_checked,
      tone: "grey",
      line: NOT_CHECKED_LINE[reason] ?? null,
      action: reason === "not_forecast_account" ? null : "sync",
    };
  }
  if (c.status === "resolved_since") {
    return {
      ...base,
      chip: CHECK_CHIP.resolved_since,
      tone: c.stale && c.staleReason === "age" ? "grey" : "ok",
      line: diff ? `Was off by ${diff} at the ${day ?? "last"} check; rows that arrived later explain it.` : "Rows that arrived later explain the last check.",
      action: null,
    };
  }
  if (c.stale) {
    const why =
      c.staleReason === "anchor_changed"
        ? today?.source === "manual"
          ? `A balance was typed in since the last check${atDay}.`
          : `The bank balance was re-read since the last check${atDay}.`
        : c.staleReason === "rows_since"
          ? `Rows arrived after the last check${atDay}.`
          : c.checkedAt
            ? `Last checked ${checkedAgo(c.checkedAt, now)}.`
            : "The last check is old.";
    const then = c.status === "off_by" && diff ? ` It was off by ${diff} then.` : "";
    return { ...base, chip: CHECK_CHIP.stale, tone: "grey", line: `${why}${then}`, action: "sync" };
  }
  if (c.status === "off_by") {
    const way = c.direction === "bank_lower" ? "lower" : c.direction === "bank_higher" ? "higher" : null;
    const line = diff
      ? way
        ? `At the last check${atDay} the bank was ${diff} ${way} than H2 expected.`
        : `At the last check${atDay} the bank and H2 differed by ${diff}.`
      : `At the last check${atDay} the bank and H2 differed.`;
    // Today's two figures are one reading and agree: the difference is the check's, not today's.
    const h2 = cents(today?.h2);
    const reading = cents(today?.reading);
    const agree =
      today && h2 != null && reading != null && h2 === reading && sameMoment(c.bank?.at, today.asOf)
        ? `Today H2 ${formatCurrency(today.h2!)} and the bank ${formatCurrency(today.reading!)} agree.`
        : null;
    return { chip: CHECK_CHIP.off_by, tone: "bad", line, agree, history, action: "review" };
  }
  // matches
  const ago = c.checkedAt ? checkedAgo(c.checkedAt, now) : "";
  const pair = c.bank && c.h2 ? ` · bank ${formatCurrency(c.bank.balance)} = H2 ${formatCurrency(c.h2.balance)}` : "";
  return { ...base, chip: CHECK_CHIP.matches, tone: "ok", line: ago ? `Checked ${ago}${pair}` : null, action: null };
}

/** The chip alone (the dashboard tile and header): the same words as Banking's Balance check. */
export function checkView(c: CheckLike, now: number = Date.now()): CheckView {
  const s = checkState(c, now);
  const matched = c.status === "matches" || c.status === "resolved_since";
  return { word: s.chip, tone: s.tone, matched };
}

export interface ConfidenceInput {
  /** When the bank last told us anything; null with no snapshot */
  fetchedAt: string | null;
  bankBalance: string | null;
  /** When the bank's reading was taken (spine.bankConfidence.bankAsOf). */
  bankAsOf?: string | null;
  h2Balance: string | null;
  check: CheckLike;
  pendingCount: number;
}

export interface ConfidenceView {
  /** "Updated 2 h ago" — null when nothing was ever fetched */
  updated: string | null;
  /** "Checking $3,047.50 today · bank read $2,985.00 2 h ago" — null when either side is unknown */
  balances: string | null;
  check: CheckView;
  /** "1 pending" — null at zero */
  pending: string | null;
  /** The dot is green only for a fresh matching check */
  tone: ConfidenceTone;
}

export function confidenceView(i: ConfidenceInput, now: number = Date.now()): ConfidenceView {
  const ago = agoShort(i.fetchedAt, now);
  const readAgo = agoShort(i.bankAsOf ?? i.fetchedAt, now);
  const check = checkView(i.check, now);
  return {
    updated: ago ? `Updated ${ago}` : null,
    balances:
      i.bankBalance != null && i.h2Balance != null
        ? `Checking ${formatCurrency(i.h2Balance)} today · bank read ${formatCurrency(i.bankBalance)}${readAgo ? ` ${readAgo}` : ""}`
        : null,
    check,
    pending: i.pendingCount > 0 ? `${i.pendingCount} pending` : null,
    tone: check.tone,
  };
}
