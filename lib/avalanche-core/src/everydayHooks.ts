// ⭐ (PR-B2, owner decision 7) ALLOWANCES OWN THE RESERVE; THE FUNDING BILLS
// BECOME DATE HOOKS. Pure, dependency-free (see the package header).
//
// The household's "Weekly Spend" and "Monthly Spend" bills used to be plain
// bills on the forecast: −$300 every Saturday whatever the card actually owed,
// and, before PR-B2, a special pre-snapshot rule (`keepsPreSnapshotRule`) so
// the overdue rule would not drag two of them onto one day. Decision 7 keeps
// the bill only as a DATE: each occurrence of a hooked item is replaced by the
// card payoff it stands for —
//
//     payoff = the period's charges on the cards that bill at the hook's
//              cadence (every coverage: weekly, unplanned, unfiled,
//              reimbursable — all of it is owed to the card)
//            + what is left of the period's allowance while the period is
//              still open (the reserve the household may still spend).
//
// A closed period has nothing left to spend, so its payoff is its charges
// alone. A debit on checking that the household tagged to the allowance has
// already left the bank: it shrinks the remaining allowance, so it shrinks the
// payoff by exactly its amount, while a card charge moves money from
// "remaining" to "charges" and leaves the payoff unchanged
// (docs/reviews/2026-09-11-household-scenario.md, "Payoff for a week").
// The hook item's own stored amount is never read.

import { weekBounds, monthBounds, addDaysISO } from "./householdTime";

export type HookCadence = "weekly" | "monthly";

export interface EverydayHook {
  recurringItemId: string;
}

/** `preferences.everydayHooks` — server-owned; written by 0042_everyday_hooks.sql. */
export interface EverydayHooks {
  weekly: EverydayHook | null;
  monthly: EverydayHook | null;
}

const hookOf = (v: unknown): EverydayHook | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const id = (v as Record<string, unknown>).recurringItemId;
  return typeof id === "string" && id.length > 0 ? { recurringItemId: id } : null;
};

/**
 * Read `preferences.everydayHooks` defensively: anything that is not
 * `{ recurringItemId: string }` is "no hook". The same item can never hook
 * both cadences — then the weekly hook wins and the monthly reads null.
 */
export function readEverydayHooks(preferences: unknown): EverydayHooks {
  const prefs =
    preferences && typeof preferences === "object" && !Array.isArray(preferences)
      ? (preferences as Record<string, unknown>)
      : {};
  const raw = prefs.everydayHooks;
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const weekly = hookOf(obj.weekly);
  let monthly = hookOf(obj.monthly);
  if (weekly && monthly && weekly.recurringItemId === monthly.recurringItemId) monthly = null;
  return { weekly, monthly };
}

/**
 * The period a hook occurrence pays for: the household week (Sunday–Saturday)
 * that contains it, or the calendar month that contains it — the same windows
 * `computeWeeklyPayoff` reads weekly and monthly cards over. A Saturday hook
 * pays for the week ending that day.
 */
export function hookPeriodOf(cadence: HookCadence, occurrenceISO: string): { start: string; end: string } {
  if (cadence === "weekly") return weekBounds(occurrenceISO);
  const m = monthBounds(occurrenceISO);
  return { start: m.start, end: m.end };
}

export interface PayoffInputs {
  /** The period's card charges, in cents (≥ 0). */
  chargesCents: number;
  /** The period's allowance cap, in cents (0 when none). */
  capCents: number;
  /** What the period has already spent from the allowance, in cents (any account). */
  spentCents: number;
  /** The period's last day. */
  periodEnd: string;
  /** The household's today. */
  todayISO: string;
}

export interface Payoff {
  /** charges + remaining, in cents (≥ 0). The forecast books it as an outflow. */
  amountCents: number;
  chargesCents: number;
  /** What is left of the allowance; 0 once the period has closed. */
  remainingCents: number;
  /** The period ended before today: nothing is left to spend in it. */
  closed: boolean;
}

/** ⭐ THE PAYOFF FOR ONE PERIOD. */
export function payoffFor(i: PayoffInputs): Payoff {
  const closed = i.periodEnd < i.todayISO;
  const charges = Math.max(0, Math.round(i.chargesCents));
  const remaining = closed ? 0 : Math.max(0, Math.round(i.capCents) - Math.round(i.spentCents));
  return { amountCents: charges + remaining, chargesCents: charges, remainingCents: remaining, closed };
}

/** A checking row that may be a card payment, as the payoff rule reads it. */
export interface PayoffPaymentRow {
  txnId: string;
  occurredOn: string;
  /** Signed like the bank: a payment is negative. */
  amount: number;
  description: string | null;
}

/** A due payoff occurrence waiting for its payment. */
export interface DuePayoff {
  key: string;
  occurrenceDate: string;
  /** The day the next occurrence of the same hook falls on (the window's end, exclusive). */
  nextOccurrenceDate: string;
  amountCents: number;
}

const AMEX_NAME = /\bamex\b|american\s*express/i;

/** Does a checking row's description name the card issuer the hooks pay (Amex)? */
export function namesCardIssuer(description: string | null | undefined): boolean {
  return AMEX_NAME.test(description ?? "");
}

/**
 * ⭐ A DUE PAYOFF IS PAID ON EVIDENCE ONLY — the hold-back law ("the forecast
 * may read low, never high"). A checking outflow that names Amex, dated from
 * the occurrence up to (not including) the hook's next occurrence, that COVERS
 * the payoff: at least the payoff less max($1, 1%), with no upper bound
 * (round 2, lead's ruling: paying the statement in full pays the week). Each
 * row pays one occurrence; the oldest occurrence chooses first, and takes its
 * window's earliest row. Anything else — a payment smaller than owed, before
 * the occurrence, or a week late — leaves the payoff on the curve (reading
 * low) until the household confirms it in Review.
 */
export function payoffsPaidBy(
  due: readonly DuePayoff[],
  rows: readonly PayoffPaymentRow[],
): Map<string, PayoffPaymentRow> {
  const out = new Map<string, PayoffPaymentRow>();
  const used = new Set<string>();
  const candidates = rows
    .filter((r) => r.amount < 0 && namesCardIssuer(r.description))
    .sort((a, b) => (a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : a.txnId < b.txnId ? -1 : 1));
  const ordered = due
    .slice()
    .sort((a, b) => (a.occurrenceDate < b.occurrenceDate ? -1 : a.occurrenceDate > b.occurrenceDate ? 1 : 0));
  for (const d of ordered) {
    if (d.amountCents <= 0) continue;
    const tolerance = Math.max(100, Math.round(d.amountCents * 0.01));
    const hit = candidates.find(
      (r) =>
        !used.has(r.txnId) &&
        r.occurredOn >= d.occurrenceDate &&
        r.occurredOn < d.nextOccurrenceDate &&
        Math.round(-r.amount * 100) >= d.amountCents - tolerance,
    );
    if (!hit) continue;
    used.add(hit.txnId);
    out.set(d.key, hit);
  }
  return out;
}

/** The next occurrence of a hook when the expansion holds no later one: a week on, or the same day next month (clamped). */
export function nextHookOccurrence(cadence: HookCadence, occurrenceISO: string): string {
  if (cadence === "weekly") return addDaysISO(occurrenceISO, 7);
  const [y, m, d] = occurrenceISO.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(d, last);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
