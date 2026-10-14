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

// ── (F1) THE OBLIGATIONS MODEL ───────────────────────────────────────────────
//
// The owner, 2026-10-14: a card paid IN FULL ("we try to pay weekly for what we
// spend, doesn't always happen") owes its purchases until they are paid — an
// unpaid week stays owed; a card on the DEBT PLAN (minimum + extra) is paid by
// its debt plan, so its new purchases are never reserved again here.
//
// Each hook occurrence is then
//
//     incurred      its own period's purchases − refunds on the in_full cards
//                   of its cadence (debt-linked or not), less the payments
//                   allocated to it;
//   + carried       earlier periods' unpaid in_full obligations, moved into the
//                   latest occurrence already due ("an unpaid week stays owed");
//   + allowanceLeft with a plan, max(0, cap − spent) while the period is open;
//                   with no plan, the stored amount less the period's own
//                   purchases, never below 0; 0 once the period has closed.
//
// "Unpaid" is measured per occurrence from evidence, never from the card's
// balance: the balance is a point-in-time sync value with no period split, and
// it holds whatever the card owed before the window (an archived debt's old
// balance) — reserving it would move a whole paydown onto one Saturday. So a
// purchase counts once (its period, pending→posted once), a refund nets the
// period it is dated in, and each payment is allocated ONCE, oldest obligation
// first, possibly across several weeks (`allocateHookPayments`).

/** One in_full card's obligation for one hook occurrence's period. */
export interface HookObligation {
  /** The occurrence (`<itemId>|<occurrenceDate>`). */
  key: string;
  cadence: HookCadence;
  occurrenceDate: string;
  /** External account id of the card. */
  accountId: string;
  /** The period's purchases − refunds on the card, in cents (≥ 0). */
  cents: number;
}

/** A payment the obligations may be paid by. */
export interface HookPaymentEvidence {
  txnId: string;
  occurredOn: string;
  /** What was paid, in cents (> 0). */
  cents: number;
  /** The card it is known to have paid (a debt tag, the card's own ledger), or null: any in_full card. */
  accountId: string | null;
}

export interface HookAllocation {
  txnId: string;
  key: string;
  accountId: string;
  cents: number;
}

const byDateThen = <T>(date: (t: T) => string, ...rest: Array<(t: T) => string>) =>
  (a: T, b: T): number => {
    for (const f of [date, ...rest]) {
      const x = f(a);
      const y = f(b);
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  };

/**
 * ⭐ ONE PAYMENT, ALLOCATED ONCE, OLDEST OBLIGATION FIRST. Payments in date
 * order; each pays the outstanding obligations already DUE on its date (the
 * occurrence on or before the payment — a payment never pays a week that has
 * not closed, as before F1), oldest first (weekly before monthly on the same
 * day, then the card), only its own card's when it is known; what is left of it
 * pays nothing (it paid an older balance). Multi-week and partial payments fall
 * out of this; a payment can never be counted twice. Pure.
 */
export function allocateHookPayments(
  obligations: readonly HookObligation[],
  payments: readonly HookPaymentEvidence[],
): HookAllocation[] {
  const open = obligations
    .filter((o) => o.cents > 0)
    .map((o) => ({ ...o, left: Math.round(o.cents) }))
    .sort(byDateThen((o) => o.occurrenceDate, (o) => (o.cadence === "weekly" ? "0" : "1"), (o) => o.accountId, (o) => o.key));
  const out: HookAllocation[] = [];
  const ordered = payments.filter((p) => p.cents > 0).slice().sort(byDateThen((p) => p.occurredOn, (p) => p.txnId));
  for (const p of ordered) {
    let left = Math.round(p.cents);
    for (const o of open) {
      if (left <= 0) break;
      if (o.left <= 0 || o.occurrenceDate > p.occurredOn) continue;
      if (p.accountId != null && p.accountId !== o.accountId) continue;
      const take = Math.min(left, o.left);
      o.left -= take;
      left -= take;
      out.push({ txnId: p.txnId, key: o.key, accountId: o.accountId, cents: take });
    }
  }
  return out;
}

/** What the model knows about one hook occurrence. */
export interface HookOccurrenceFacts {
  key: string;
  /** The hook item (carry stays within one item). */
  itemId: string;
  occurrenceDate: string;
  periodEnd: string;
  /** The period's cap in cents, or null: no plan. */
  capCents: number | null;
  /** The hook item's stored amount, cents (≥ 0). */
  storedCents: number;
  /** What the open period has spent from its allowance (any account), cents; ignored otherwise. */
  spentCents: number;
  /** Its own period's in_full obligations (purchases − refunds), cents (≥ 0). */
  ownCents: number;
  /** Payments allocated to its own period, cents (≤ ownCents). */
  paidCents: number;
  /** On or before the drag cutoff (and sized): due now. */
  due: boolean;
  /** Answered matched / skipped / missed / dismissed: settled, never carried. */
  settled: boolean;
  /** Answered partial: keeps its own amount, never carried, never a carrier. */
  partial: boolean;
}

export interface HookOccurrenceAmounts {
  /** Own unpaid: ownCents − paidCents. */
  incurredCents: number;
  paidCents: number;
  /** Earlier occurrences' unpaid carried into this one. */
  carriedCents: number;
  /** The occurrences carried in, oldest first. */
  carriedFrom: Array<{ key: string; occurrenceDate: string; cents: number }>;
  /** The occurrence this one's unpaid was carried into (its key), or null. */
  carriedTo: string | null;
  allowanceLeftCents: number;
  /** Before payment evidence and review answers: (carriedTo ? 0 : incurred) + paid + carried + allowanceLeft. */
  amountCents: number;
  /** What lands on the curve before review answers: amountCents − paidCents. */
  curveCents: number;
  closed: boolean;
}

/**
 * ⭐ EACH OCCURRENCE'S AMOUNT (F1). See the section header. For each hook item,
 * the LATEST due occurrence that is not answered (nor partial) is the carrier:
 * every earlier due, unanswered occurrence with something unpaid moves it there
 * (`carriedTo` / `carriedFrom`), so the curve holds each obligation once, on
 * one event, until it is paid. Pure.
 */
export function hookOccurrenceAmounts(facts: readonly HookOccurrenceFacts[], todayISO: string): Map<string, HookOccurrenceAmounts> {
  const out = new Map<string, HookOccurrenceAmounts>();
  for (const f of facts) {
    const closed = f.periodEnd < todayISO;
    const own = Math.max(0, Math.round(f.ownCents));
    const paid = Math.min(own, Math.max(0, Math.round(f.paidCents)));
    const allowanceLeft = closed
      ? 0
      : f.capCents != null
        ? Math.max(0, Math.round(f.capCents) - Math.round(f.spentCents))
        : Math.max(0, Math.round(f.storedCents) - own);
    out.set(f.key, {
      incurredCents: own - paid,
      paidCents: paid,
      carriedCents: 0,
      carriedFrom: [],
      carriedTo: null,
      allowanceLeftCents: allowanceLeft,
      amountCents: own + allowanceLeft,
      curveCents: own - paid + allowanceLeft,
      closed,
    });
  }
  const byItem = new Map<string, HookOccurrenceFacts[]>();
  for (const f of facts) {
    if (!f.due || f.settled || f.partial) continue;
    const list = byItem.get(f.itemId) ?? [];
    list.push(f);
    byItem.set(f.itemId, list);
  }
  for (const list of byItem.values()) {
    list.sort(byDateThen((f) => f.occurrenceDate, (f) => f.key));
    const carrier = out.get(list[list.length - 1]!.key)!;
    for (const f of list.slice(0, -1)) {
      const a = out.get(f.key)!;
      if (a.incurredCents <= 0) continue;
      carrier.carriedFrom.push({ key: f.key, occurrenceDate: f.occurrenceDate, cents: a.incurredCents });
      carrier.carriedCents += a.incurredCents;
      carrier.amountCents += a.incurredCents;
      carrier.curveCents += a.incurredCents;
      a.carriedTo = list[list.length - 1]!.key;
      a.amountCents -= a.incurredCents;
      a.curveCents -= a.incurredCents;
    }
  }
  return out;
}
