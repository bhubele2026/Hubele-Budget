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
import { CARD_CREDIT_PAIR_BEFORE } from "./cardLedger";

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
// "Unpaid" is measured per occurrence from evidence, never FROM the card's
// balance: the balance is a point-in-time sync value with no period split, and
// it holds whatever the card owed before the window (an archived debt's old
// balance) — reserving it would move a whole paydown onto one Saturday. So a
// purchase counts once (its period, pending→posted once), a refund nets the
// period it is dated in, and each payment is allocated ONCE, oldest obligation
// first, possibly across several weeks (`allocateHookPayments`). ⭐ (F5 round 2)
// The balance is still a CEILING: a card's carried + current unpaid never
// exceeds what the card says it owes (`capHookObligationsAtBalance`, oldest
// cut first) — the owner: "cautious but never over".

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
  /**
   * ⭐ (F5 round 2) The period's rows on the card, by day: a purchase positive,
   * a refund negative, in cents. A payment pays only what had been bought by
   * its date (`accruedByCents`). Absent: nothing of the period is payable
   * before the period's end (`periodEnd`, else the occurrence date — F1's rule).
   */
  rows?: ReadonlyArray<{ on: string; cents: number }>;
  /**
   * (F5 round 3) The period's last day. A monthly occurrence is dated at its
   * period's START (the 1st), so "on or after the occurrence" is no proof the
   * month's purchases were made by then. Absent: the occurrence date.
   */
  periodEnd?: string;
}

/** A payment the obligations may be paid by. */
export interface HookPaymentEvidence {
  txnId: string;
  occurredOn: string;
  /** What was paid, in cents (> 0). */
  cents: number;
  /** The card it is known to have paid (a debt tag, the card's own ledger), or null: any in_full card. */
  accountId: string | null;
  /**
   * ⭐ (F5 round 2) The occurrence a Review "matched" answer tied this payment
   * to. It pays that occurrence first, whatever its date; the rest of it pays
   * the other obligations by the usual rule — an answer never throws away the
   * rest of a payment.
   */
  forKey?: string | null;
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
 * (F5 round 2) What of an obligation had been bought by `dayISO`: the
 * period's rows dated on or before it, never below 0 nor above the obligation.
 * (F5 round 3) Whenever the rows are known they decide, whatever the
 * occurrence date: a monthly occurrence is dated the 1st, and a payment on the
 * 2nd must not pay purchases made on the 12th. With no rows, nothing before the
 * period's end (`periodEnd`, else the occurrence date), all of it from then on.
 */
export function accruedByCents(o: Pick<HookObligation, "occurrenceDate" | "cents" | "rows" | "periodEnd">, dayISO: string): number {
  const total = Math.max(0, Math.round(o.cents));
  if (!o.rows) return (o.periodEnd ?? o.occurrenceDate) <= dayISO ? total : 0;
  let running = 0;
  for (const r of o.rows) if (r.on <= dayISO) running += Math.round(r.cents);
  return Math.min(total, Math.max(0, running));
}

const obligationOrder = byDateThen<HookObligation>((o) => o.occurrenceDate, (o) => (o.cadence === "weekly" ? "0" : "1"), (o) => o.accountId, (o) => o.key);

/**
 * ⭐ ONE PAYMENT, ALLOCATED ONCE, OLDEST OBLIGATION FIRST. Payments in date
 * order; each pays the outstanding obligations oldest first (weekly before
 * monthly on the same day, then the card), only its own card's when it is
 * known. An obligation is payable for what had been BOUGHT by the payment's
 * date (`accruedByCents`; all of it once its period has ended) — (F5 round 2)
 * a statement-size payment also pays the open week's purchases made before
 * it, instead of dropping its leftover. A
 * payment tied to an occurrence by a "matched" answer (`forKey`) pays that one
 * first. What is still left of a payment pays nothing here (it paid an older
 * balance, or sits on the card as a credit — the card's balance cap,
 * `capHookObligationsAtBalance`, sees that). Multi-week and partial payments
 * fall out of this; a payment can never be counted twice.
 *
 * (F5 round 3) `firstOccurrence`: the earliest sized occurrence of each
 * cadence. A payment dated BEFORE it has no obligation in the window that had
 * closed by its date — it paid the balance from before the window (typically
 * the previous statement) — so it pays nothing of that cadence here, F1's rule
 * (the forecast reads low until the card's balance cap or Review says
 * otherwise). Accrual only places what is left of a payment AFTER the
 * obligations closed by its date. A "matched" answer still ties its row to its
 * occurrence. Pure.
 */
export function allocateHookPayments(
  obligations: readonly HookObligation[],
  payments: readonly HookPaymentEvidence[],
  opts: { firstOccurrence?: Partial<Record<HookCadence, string>> } = {},
): HookAllocation[] {
  const open = obligations
    .filter((o) => o.cents > 0)
    .map((o) => ({ ...o, left: Math.round(o.cents) }))
    .sort(obligationOrder);
  const out: HookAllocation[] = [];
  const ordered = payments.filter((p) => p.cents > 0).slice().sort(byDateThen((p) => p.occurredOn, (p) => p.txnId));
  const beforeWindow = (p: HookPaymentEvidence, o: HookObligation): boolean => {
    const first = opts.firstOccurrence?.[o.cadence];
    return first != null && p.occurredOn < first;
  };
  for (const p of ordered) {
    let left = Math.round(p.cents);
    const take = (o: (typeof open)[number], payable: number): void => {
      const cents = Math.min(left, payable);
      if (cents <= 0) return;
      o.left -= cents;
      left -= cents;
      out.push({ txnId: p.txnId, key: o.key, accountId: o.accountId, cents });
    };
    if (p.forKey) {
      for (const o of open) {
        if (left <= 0) break;
        if (o.key !== p.forKey || o.left <= 0) continue;
        if (p.accountId != null && p.accountId !== o.accountId) continue;
        take(o, o.left);
      }
    }
    for (const o of open) {
      if (left <= 0) break;
      if (o.left <= 0) continue;
      if (p.accountId != null && p.accountId !== o.accountId) continue;
      if (beforeWindow(p, o)) continue;
      const paidSoFar = Math.round(o.cents) - o.left;
      take(o, Math.max(0, accruedByCents(o, p.occurredOn) - paidSoFar));
    }
  }
  return out;
}

/**
 * ⭐ (F5 round 2) A CARD NEVER OWES MORE THAN ITS BALANCE. For each in_full
 * card with a known cap (what the card itself says it owes now — the caller
 * reads it), the obligations still unpaid after the payments (`allocations`)
 * — every period carried plus the open one — are cut down to the cap, OLDEST
 * FIRST: whatever paid the difference (a payment H2 cannot see, the leftover of
 * one that paid an older balance) paid the oldest purchases. A card with no cap
 * is not touched. The cut can only lower what is reserved, and never moves a
 * paydown onto one day. Returns the cut, per occurrence and card (`txnId` "").
 * Pure.
 */
export function capHookObligationsAtBalance(
  obligations: readonly HookObligation[],
  allocations: readonly HookAllocation[],
  capCentsByCard: ReadonlyMap<string, number>,
): HookAllocation[] {
  const paid = new Map<string, number>();
  for (const a of allocations) paid.set(`${a.key}#${a.accountId}`, (paid.get(`${a.key}#${a.accountId}`) ?? 0) + a.cents);
  const out: HookAllocation[] = [];
  const byCard = new Map<string, HookObligation[]>();
  for (const o of obligations) {
    if (o.cents <= 0 || !capCentsByCard.has(o.accountId)) continue;
    byCard.set(o.accountId, [...(byCard.get(o.accountId) ?? []), o]);
  }
  for (const [accountId, list] of byCard) {
    const unpaid = list
      .sort(obligationOrder)
      .map((o) => ({ o, left: Math.max(0, Math.round(o.cents) - (paid.get(`${o.key}#${accountId}`) ?? 0)) }));
    const total = unpaid.reduce((s, u) => s + u.left, 0);
    let excess = total - Math.max(0, Math.round(capCentsByCard.get(accountId)!));
    for (const u of unpaid) {
      if (excess <= 0) break;
      const cut = Math.min(excess, u.left);
      if (cut <= 0) continue;
      excess -= cut;
      out.push({ txnId: "", key: u.o.key, accountId, cents: cut });
    }
  }
  return out;
}

/** (F5 round 3) A card's last balance read: what it owed, and when. */
export interface CardBalanceRead {
  /** What the card owed at the read, cents. */
  balanceCents: number;
  /** The instant it was read (ISO). */
  asOf: string;
  /** The household day of `asOf`. */
  asOfDay: string;
  /**
   * The ids of the card's rows that were PENDING at the read, kept with the
   * balance. (F5 round 4) Kept ONLY by a read that came right after a
   * transactions sync of the card's item (the Sync button): non-null says H2's
   * rows were current when the balance was read, so "pending at the read" and
   * "stored after the read" mean something. Null: any other read (a debt's
   * Refresh, a link, a liability-accounts refresh, or a read before 0210) — the
   * day decides alone. (Round 6) Such a read's own list is `pendingAtOtherRead`.
   */
  pendingAtRead: ReadonlySet<string> | null;
  /**
   * ⭐ (F5 round 6) The ids of the card's rows H2 held as PENDING at a read that
   * did NOT follow a transactions sync (every liability fetch keeps its list;
   * this is the list of a non-Sync one). H2's pending flags may lag that
   * balance, so it is read for payment credits and refunds only
   * (`creditOutsideCardBalanceRead`): one pending at the read is outside, even
   * after it posts in place. A stale flag (the balance already held it) reads
   * the cap LOW — the side the owner allows. Purchases never read it. Absent /
   * null: none kept (a Sync's read, or a read before 0210).
   */
  pendingAtOtherRead?: ReadonlySet<string> | null;
}

/** (F5 round 3) A card row as a balance read sees it. */
export interface CardBalanceRow {
  txnId: string;
  on: string;
  /** cents: a purchase or a payment credit positive, a refund negative. */
  cents: number;
  /** Still pending now. */
  pending: boolean;
  /** When H2 stored the row (ISO instant); null or absent: unknown. */
  createdAt?: string | null;
}

/**
 * ⭐ (F5 round 3, round 4) WAS A CARD ROW OUTSIDE THE BALANCE WHEN IT WAS READ?
 * Plaid's current balance holds the card's POSTED rows (the available balance is
 * the one that moves with pending ones). On ANY read, outside:
 *   - a row still pending now;
 *   - a row dated after the read's day.
 * On a read right after a transactions sync of the card's item (`pendingAtRead`
 * kept: H2's rows were current at the read), also outside:
 *   - a row pending at the read that has posted in place since (Plaid's
 *     pending→posted re-key keeps H2's row, its id and its store time);
 *   - a row H2 stored after the read (`createdAt` > `asOf`): the sync just before
 *     the read had not seen it. A purchase pending at a morning read that posts
 *     later that day as a new row is dated the read day; so is a payment made
 *     after the read. Only the instant tells them apart.
 * (Round 4) On any other read (a debt's Refresh, a link, a read before 0210 —
 * `pendingAtRead` null) H2's rows may lag the balance it read, so neither the
 * pending flags nor the store time say anything: the day decides alone. And a
 * pending row kept at the read says nothing about the posted row that replaced
 * it: a leftover pending copy H2 keeps beside its posted twin (the superseded
 * pairing) is pending at every read, while the twin — stored before the read —
 * is inside the balance (round 3 read the twin outside: the cap ran high for a
 * purchase, low for a payment credit). The twin stored after the read is
 * outside by its store time. Purchases read by this one rule; (round 5) a
 * payment credit — and (round 6) a refund — also by
 * `creditOutsideCardBalanceRead` (pending at a non-Sync read, or stored after
 * it: outside — never over). Pure.
 */
export function outsideCardBalanceRead(row: CardBalanceRow, read: Pick<CardBalanceRead, "asOf" | "asOfDay" | "pendingAtRead">): boolean {
  if (row.pending) return true;
  if (row.on > read.asOfDay) return true;
  // Not read right after a sync: the day decides.
  if (!read.pendingAtRead) return false;
  if (read.pendingAtRead.has(row.txnId)) return true;
  return storedAfterRead(row, read);
}

/** H2 stored the row after the read's instant (an unknown store time: no). */
const storedAfterRead = (row: Pick<CardBalanceRow, "createdAt">, read: Pick<CardBalanceRead, "asOf">): boolean => {
  if (!row.createdAt) return false;
  const created = Date.parse(row.createdAt);
  const asOf = Date.parse(read.asOf);
  return Number.isFinite(created) && Number.isFinite(asOf) && created > asOf;
};

/**
 * ⭐ (F5 round 5) A PAYMENT CREDIT READS ON THE "NEVER OVER" SIDE. Outside the
 * balance whenever `outsideCardBalanceRead` says so, and — on a read that kept
 * no pending list (a debt's Refresh, a link, a read before 0210: H2's rows may
 * lag it) — also when H2 stored it AFTER the read and it is dated no earlier
 * than `CARD_CREDIT_PAIR_BEFORE` days before the read's day (the window a
 * payment counts as in flight). A payment made after a debt's Refresh posts
 * as a credit dated on or before the read's day and stored later; round 4 read
 * it inside by the day, so once the credit paired its checking row left "in
 * flight" and the paid amount came back: H2 held up to the whole payment more
 * than the card owed until the next Sync. Subtracted now, the cap may read LOW
 * instead — when the balance already held a credit H2 stored late — until the
 * next Sync: the side the owner allows. Older credits stored after the read are
 * history arriving late (a link, a backfill) that the balance holds.
 * ⭐ (Round 6) Also — on such a read — a credit H2 held as PENDING at it
 * (`pendingAtOtherRead`), whatever its date or store time: Plaid's
 * pending→posted re-key keeps H2's row and its store time, so a credit pending
 * at a debt's Refresh that posted in place later read inside (round 5) and H2
 * held the whole payment over what the card owes until the next Sync. A stale
 * pending flag (the balance already held it) reads the cap LOW instead: allowed.
 * (Round 6) A REFUND reads by this rule too (it lowers what the card owes, like
 * a payment credit): stored after a non-Sync read, or pending at it, it is
 * outside. Purchases keep the day rule (`outsideCardBalanceRead`): read inside,
 * a late one can only lower the cap. Pure.
 */
export function creditOutsideCardBalanceRead(
  credit: CardBalanceRow,
  read: Pick<CardBalanceRead, "asOf" | "asOfDay" | "pendingAtRead" | "pendingAtOtherRead">,
): boolean {
  if (outsideCardBalanceRead(credit, read)) return true;
  if (read.pendingAtRead) return false; // a Sync's read: the store time already decided
  if (read.pendingAtOtherRead?.has(credit.txnId)) return true;
  if (credit.on < addDaysISO(read.asOfDay, -CARD_CREDIT_PAIR_BEFORE)) return false;
  return storedAfterRead(credit, read);
}

/**
 * ⭐ (F5 round 3) WHAT A CARD OWES NOW, from its last balance read: the balance,
 * + purchases outside it (`outsideCardBalanceRead`), − refunds and payment
 * credits outside it (`creditOutsideCardBalanceRead`: round 5 credits, round 6
 * refunds — never over), − payments already sent that the card has not
 * received at all (`inFlightCents`: checking payments with no card credit
 * yet). Never below 0. The ceiling `capHookObligationsAtBalance` cuts to. Pure.
 */
export function cardOwedNowCents(
  read: CardBalanceRead,
  rows: readonly CardBalanceRow[],
  credits: readonly CardBalanceRow[],
  inFlightCents: number,
): number {
  let owed = Math.round(read.balanceCents);
  // A refund (cents < 0) reads by the credit rule (round 6); a purchase by the day rule.
  // (F6 round 3) An expired hold and its reversal are not in `rows` at all: the
  // card's rows drop them upstream (`readCardPeriods`), so they are neither
  // added nor subtracted here.
  for (const r of rows) if (r.cents < 0 ? creditOutsideCardBalanceRead(r, read) : outsideCardBalanceRead(r, read)) owed += Math.round(r.cents);
  for (const c of credits) if (creditOutsideCardBalanceRead(c, read)) owed -= Math.round(c.cents);
  owed -= Math.max(0, Math.round(inFlightCents));
  return Math.max(0, owed);
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
  /**
   * (F5 round 2) What the cards' balances show was already paid of its own
   * purchases beyond the payments H2 sees (`capHookObligationsAtBalance`),
   * cents. Never on the curve. Absent: 0.
   */
  cappedCents?: number;
  /** On or before the drag cutoff (and sized): due now. */
  due: boolean;
  /**
   * Answered matched: settled by the confirmed row, never carried, never a
   * carrier. (F5) Only "matched": a missed / skipped / dismissed answer is
   * `reserveClosed`, never settled.
   */
  settled: boolean;
  /**
   * ⭐ (F5) Answered missed / skipped / dismissed. The answer closes the
   * occurrence's RESERVE (allowance left → 0), never its purchases: on an
   * in_full card they stay owed (the owner, 2026-10-14: "exhausting an
   * allowance never erases the obligation to pay existing purchases"), are paid
   * by evidence, and carry — or carry the earlier ones in — exactly as an
   * unanswered occurrence's do. Before F5 the answer settled the week, and a
   * household that had answered every past week (to stop the pre-F1 stored
   * reserve dragging) lost every unpaid purchase from the curve.
   */
  reserveClosed?: boolean;
  /** Answered partial: keeps its own amount, never carried, never a carrier. */
  partial: boolean;
}

export interface HookOccurrenceAmounts {
  /** Own unpaid: ownCents − paidCents − cappedCents. */
  incurredCents: number;
  paidCents: number;
  /** (F5 round 2) Its own purchases the cards' balances show paid (never on the curve). */
  cappedCents: number;
  /** Earlier occurrences' unpaid carried into this one. */
  carriedCents: number;
  /** The occurrences carried in, oldest first. */
  carriedFrom: Array<{ key: string; occurrenceDate: string; cents: number }>;
  /** The occurrence this one's unpaid was carried into (its key), or null. */
  carriedTo: string | null;
  allowanceLeftCents: number;
  /** Before payment evidence and review answers: (carriedTo ? 0 : incurred) + paid + carried + allowanceLeft (never `cappedCents`). */
  amountCents: number;
  /** What lands on the curve before review answers: amountCents − paidCents. */
  curveCents: number;
  closed: boolean;
}

/**
 * ⭐ EACH OCCURRENCE'S AMOUNT (F1). See the section header. For each hook item,
 * the LATEST due occurrence that is not settled (matched) nor partial is the
 * carrier: every earlier such occurrence with something unpaid moves it there
 * (`carriedTo` / `carriedFrom`), so the curve holds each obligation once, on
 * one event, until it is paid. (F5) A missed / skipped answer
 * (`reserveClosed`) only drops the occurrence's allowance left: it carries and
 * can be the carrier like any other, so Σ curve over an item = Σ own − Σ paid
 * (settled and partial aside) + Σ allowance left, whatever was answered. Pure.
 */
export function hookOccurrenceAmounts(facts: readonly HookOccurrenceFacts[], todayISO: string): Map<string, HookOccurrenceAmounts> {
  const out = new Map<string, HookOccurrenceAmounts>();
  for (const f of facts) {
    const closed = f.periodEnd < todayISO;
    const own = Math.max(0, Math.round(f.ownCents));
    const paid = Math.min(own, Math.max(0, Math.round(f.paidCents)));
    const capped = Math.min(own - paid, Math.max(0, Math.round(f.cappedCents ?? 0)));
    const allowanceLeft = closed || f.reserveClosed
      ? 0
      : f.capCents != null
        ? Math.max(0, Math.round(f.capCents) - Math.round(f.spentCents))
        : Math.max(0, Math.round(f.storedCents) - own);
    out.set(f.key, {
      incurredCents: own - paid - capped,
      paidCents: paid,
      cappedCents: capped,
      carriedCents: 0,
      carriedFrom: [],
      carriedTo: null,
      allowanceLeftCents: allowanceLeft,
      amountCents: own - capped + allowanceLeft,
      curveCents: own - paid - capped + allowanceLeft,
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
