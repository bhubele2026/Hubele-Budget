import { descriptionsFuzzyEqual, tokenizeDescription } from "./descriptionMatch";
import { addDaysISO } from "./householdTime";
import { isPaymentOrTransferCredit, type CreditKindSignals } from "./spendingRule";

/** A posted row can replace a pending row dated up to this many days before it. */
export const SUPERSEDE_MAX_DAYS = 7;

/**
 * ⭐ (F6 round 4, lead's decision) An expired charge takes its reversal credit
 * dated up to this many days after it. Hotel and car-rental holds are reversed
 * late — a reversal 8 days after its hold must still cancel it, or it counts
 * alone as a refund (finding 8: owed-now read 150 low, real carried purchases
 * cut). 31 days: one card cycle. A credit dated later is not a reversal.
 */
export const REVERSAL_MAX_DAYS = 31;

export type SupersedeRow = {
  id: string;
  plaidAccountId: string | null;
  pending: boolean;
  occurredOn: string;
  /** Signed: negative is money out. */
  amount: number;
  description: string | null;
  /** When the row reached the ledger. */
  createdAt: Date;
};

const cents = (n: number): number => Math.round(Math.abs(n) * 100);

/** (PR4c review) "(no description)" and empty labels match each other trivially: never pair them. */
function hasRealDescription(d: string | null): boolean {
  if (tokenizeDescription(d).size === 0) return false;
  return (d ?? "").trim().toLowerCase() !== "(no description)";
}

/**
 * ⭐ DID THIS POSTED ROW REPLACE THIS PENDING ROW? (PR4c)
 *
 * The sync normally re-keys a pending row onto its posted row
 * (`pending_transaction_id`), so they are one row. When that link is missing —
 * the merchant re-bills under a fresh id, or the pending row survives because
 * the user had categorised it and the `removed` delete and the vanished-pending
 * sweep never delete a touched row — both rows sit in the ledger and the charge
 * counts twice. There is no `pending_transaction_id` column, so this is a
 * heuristic. Every condition must hold:
 *   - both on the same Plaid account; the pending row is pending, the posted row is not;
 *   - the posted row reached the ledger after the pending row;
 *   - it is dated on the pending row's day or up to SUPERSEDE_MAX_DAYS after;
 *   - same sign, and |pending| ≤ |posted| ≤ 1.30 × |pending| + $1.00 (a tip or a
 *     final amount above the authorisation hold, never below it);
 *   - both have a real description, and they are fuzzy-equal (`descriptionsFuzzyEqual`).
 */
export function canSupersede(pending: SupersedeRow, posted: SupersedeRow): boolean {
  if (!pending.pending || posted.pending) return false;
  if (!pending.plaidAccountId || pending.plaidAccountId !== posted.plaidAccountId) return false;
  if (posted.createdAt.getTime() <= pending.createdAt.getTime()) return false;
  if (posted.occurredOn < pending.occurredOn) return false;
  if (posted.occurredOn > addDaysISO(pending.occurredOn, SUPERSEDE_MAX_DAYS)) return false;
  if (pending.amount === 0 || Math.sign(pending.amount) !== Math.sign(posted.amount)) return false;
  const p = cents(pending.amount);
  const q = cents(posted.amount);
  if (q < p || q > Math.round(p * 1.3) + 100) return false;
  if (!hasRealDescription(pending.description) || !hasRealDescription(posted.description)) return false;
  return descriptionsFuzzyEqual(pending.description, posted.description);
}

/**
 * A pending row as the expired-hold rule reads it. (F6 round 5) With what the
 * row says about itself (`CreditKindSignals`, all optional): a credit that is a
 * payment or a transfer is never a reversal (`isPaymentOrTransferCredit`).
 */
export type ExpiredHoldRow = Pick<SupersedeRow, "id" | "plaidAccountId" | "pending" | "occurredOn" | "amount" | "description"> &
  Omit<CreditKindSignals, "description">;

/** What `expiredHolds` answers. */
export type ExpiredHolds = {
  /** The expired holds, and the reversals paired with them. They count nowhere. */
  expiredIds: Set<string>;
  /** A reversal's id → the expired hold it reversed (one to one). */
  holdOf: Map<string, string>;
};

/** (F6 round 5) What `expiredHolds` may also read. */
export type ExpiredHoldsOptions = {
  /**
   * ⭐ (F6 round 5, finding 6) Does the bank snapshot already hold this row (the
   * cash rule's `held`: `isInSnapshot`)? Given only where a snapshot is known —
   * the cash rule, the register, the list's labels — and true only for rows on
   * the snapshot's account. A credit the snapshot does NOT hold takes a charge
   * the snapshot holds only when no charge it does not hold qualifies: the
   * reversal of a held hold counts in the bank balance (it is the money coming
   * back), so pairing a newer, unheld hold's reversal with an old held leftover
   * would lift the balance by money that never came back.
   */
  isHeld?: (row: ExpiredHoldRow) => boolean;
};

/**
 * Is this row an expired hold on its own: still pending now, on a Plaid
 * account, and dated more than SUPERSEDE_MAX_DAYS before the household's today?
 * (Whether a posted row replaced it is the caller's: `expiredHolds` takes the
 * replaced ids.) Exactly 7 days: no; 8: yes.
 */
export function isExpiredByAge(row: Pick<SupersedeRow, "pending" | "plaidAccountId" | "occurredOn">, todayISO: string): boolean {
  return row.pending && !!row.plaidAccountId && row.occurredOn < addDaysISO(todayISO, -SUPERSEDE_MAX_DAYS);
}

/**
 * ⭐ (F6 round 5) Can this row be the reversal of an expired charge? A pending
 * CREDIT (money in) that is not a payment or a transfer
 * (`isPaymentOrTransferCredit`, the server's own rules: a card payment, a debt
 * tag, Plaid LOAN_PAYMENTS / TRANSFER_*, payment or transfer words). Finding 2:
 * a 2-day-old "PAYMENT - THANK YOU" of the same cents as an older unpaired
 * hotel hold was taken as its reversal and counted nowhere.
 */
export function canBeReversal(row: ExpiredHoldRow): boolean {
  return row.amount > 0 && !isPaymentOrTransferCredit(row);
}

/**
 * Negative when charge `a` is the better hold for `credit` to reverse than `b`.
 * ⭐ (F6 round 6, lead's order — findings 6 and 7) (a) a fuzzy-equal real
 * description first (a "MARRIOTT HOTEL 4471" credit reverses the MARRIOTT hold,
 * not a stuck pump hold of the same cents); (b) then, with a snapshot, a charge
 * the snapshot does not hold for a credit it does not hold; (c) then the
 * closest earlier charge; then id.
 */
function rankHold(a: ExpiredHoldRow, b: ExpiredHoldRow, credit: ExpiredHoldRow, isHeld: ExpiredHoldsOptions["isHeld"]): number {
  const named = (r: ExpiredHoldRow) =>
    hasRealDescription(credit.description) && hasRealDescription(r.description) && descriptionsFuzzyEqual(credit.description, r.description) ? 0 : 1;
  // A credit the snapshot does not hold prefers a charge it does not hold.
  const heldRank = (r: ExpiredHoldRow) => (isHeld && !isHeld(credit) && isHeld(r) ? 1 : 0);
  return (
    named(a) - named(b) ||
    heldRank(a) - heldRank(b) ||
    b.occurredOn.localeCompare(a.occurredOn) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * The most pairs the credits can still make with the free charges — one
 * group: one account, one amount to the cent. Glover's rule: credits in date
 * order (each sees the charges dated from 31 days before it to its day), each
 * takes the OLDEST free charge it can reach — the one whose window closes
 * first. That is a maximum matching for windows of one length. `credits` and
 * `charges` are sorted by date; `free[j]` says charge j may be taken. O(n).
 */
function maxPairsFrom(credits: readonly ExpiredHoldRow[], from: number, charges: readonly ExpiredHoldRow[], free: readonly boolean[]): number {
  let pairs = 0;
  let lo = 0;
  for (let i = from; i < credits.length; i += 1) {
    const credit = credits[i]!;
    const first = addDaysISO(credit.occurredOn, -REVERSAL_MAX_DAYS);
    while (lo < charges.length && (!free[lo] || charges[lo]!.occurredOn < first)) lo += 1;
    if (lo < charges.length && charges[lo]!.occurredOn <= credit.occurredOn) {
      pairs += 1;
      lo += 1;
    }
  }
  return pairs;
}

/**
 * ⭐ (F6 round 6, findings 6 and 7) ONE GROUP'S PAIRS — a MAXIMUM matching
 * (no reversal is left unpaired while the charges could pair one more), each
 * credit getting its best charge (`rankHold`) among the choices that keep it
 * maximum. Credits decide in date order (then id); a credit tries its charges
 * best first and takes the first one after which the remaining credits can
 * still make the most pairs (`maxPairsFrom`); with none, it pairs with
 * nothing. So a later credit changes an earlier credit's pair only to pair one
 * more (the 75 case: 9/01 and 9/20 holds, credits 9/25 and 10/12 — the 9/25
 * credit takes 9/01, which the 10/12 credit cannot reach, and leaves it 9/20).
 */
function pairGroup(
  credits: readonly ExpiredHoldRow[],
  charges: readonly ExpiredHoldRow[],
  isHeld: ExpiredHoldsOptions["isHeld"],
  holdOf: Map<string, string>,
): void {
  const free = charges.map(() => true);
  const most = maxPairsFrom(credits, 0, charges, free);
  if (most === 0) return;
  let made = 0;
  for (let i = 0; i < credits.length && made < most; i += 1) {
    const credit = credits[i]!;
    const first = addDaysISO(credit.occurredOn, -REVERSAL_MAX_DAYS);
    const choices: number[] = [];
    charges.forEach((c, j) => {
      if (free[j] && c.occurredOn >= first && c.occurredOn <= credit.occurredOn) choices.push(j);
    });
    choices.sort((x, y) => rankHold(charges[x]!, charges[y]!, credit, isHeld));
    for (const j of choices) {
      free[j] = false;
      if (made + 1 + maxPairsFrom(credits, i + 1, charges, free) === most) {
        made += 1;
        holdOf.set(credit.id, charges[j]!.id);
        break;
      }
      free[j] = true;
    }
  }
}

/**
 * ⭐ (F6 round 3, owner's decision 2026-10-15) EXPIRED HOLDS COUNT NOWHERE.
 * "A charge that is still pending more than 7 days after its date: stop
 * counting it everywhere — worked out, nothing deleted. If it posts later, the
 * posted charge counts."
 *
 * An EXPIRED HOLD is a row that is pending now, on a Plaid account, dated more
 * than SUPERSEDE_MAX_DAYS before `todayISO` (the household's today), and not
 * replaced by a posted row (`replacedIds`: the pending → posted pairing; a
 * replaced row is never also expired). Any sign: a pending credit that old is
 * no more real than a pending charge. Manual rows never.
 *
 * Its REVERSAL is expired WITH it, even when younger than 7 days: a pending
 * CREDIT on the same account, of the same amount to the cent, dated on the
 * hold's day or up to REVERSAL_MAX_DAYS (31) after it, not replaced.
 * (Lead's amendment) No description test — a bank describes the reversal of a
 * restaurant hold generically ("Restaurant Transaction"), not by the merchant.
 * (F6 round 4) ONLY A CHARGE TAKES A REVERSAL: an expired credit expires alone
 * and never takes a charge (finding 10).
 * ⭐ (F6 round 5, lead's decisions on findings 2 and 6)
 *   - A credit that is a payment or a transfer is never a reversal
 *     (`canBeReversal`): a real pending card payment counts until it posts.
 *   - THE CREDIT CHOOSES. Credits pair oldest first (then id), each among the
 *     expired charges still free on or before it (within 31 days). Finding 6:
 *     a leftover 9/15 hold (the snapshot holds it) took the 10/09 reversal of a
 *     10/04 hold 24 days later; the bank balance read 100 high.
 * ⭐ (F6 round 6, lead's decisions on round 5's findings 6 and 7)
 *   - ITS ORDER (`rankHold`): (a) a fuzzy-equal real description, (b) with
 *     `opts.isHeld` (a snapshot is known), a charge the snapshot does not hold
 *     for a credit it does not hold, (c) the closest earlier charge, then id.
 *   - A MAXIMUM MATCHING per account and amount (`pairGroup`): a credit takes
 *     its best charge among those that still let the most credits pair. Round
 *     5's greedy gave the 9/25 credit the 9/20 hold, and the 10/12 credit
 *     could not reach back to 9/01: it counted (bank 75 high).
 * A row in a pair is never in another. ⚠️ A later credit can move an earlier
 * credit's pair (only to pair one more): readers of a window read past it
 * (`findSupersededPendingForRange`'s forward cut).
 *
 * Pure: the caller chooses the rows (all the pending rows that can pair with
 * the ones it asks about — see `findSupersededPendingForRange`). Non-pending
 * rows in `rows` are ignored.
 */
export function expiredHolds(
  rows: readonly ExpiredHoldRow[],
  todayISO: string,
  replacedIds: ReadonlySet<string>,
  opts: ExpiredHoldsOptions = {},
): ExpiredHolds {
  const expiredIds = new Set<string>();
  const holdOf = new Map<string, string>();
  const live = rows.filter((r) => r.pending && r.plaidAccountId && !replacedIds.has(r.id));
  // The expired CHARGES — the holds a credit can reverse — by account and amount in cents.
  const chargesByKey = new Map<string, ExpiredHoldRow[]>();
  for (const r of live) {
    if (!isExpiredByAge(r, todayISO)) continue;
    expiredIds.add(r.id);
    if (!(r.amount < 0)) continue;
    const key = `${r.plaidAccountId}|${cents(r.amount)}`;
    const list = chargesByKey.get(key);
    if (list) list.push(r);
    else chargesByKey.set(key, [r]);
  }
  const byDate = (a: ExpiredHoldRow, b: ExpiredHoldRow) => a.occurredOn.localeCompare(b.occurredOn) || a.id.localeCompare(b.id);
  const creditsByKey = new Map<string, ExpiredHoldRow[]>();
  for (const r of live) {
    if (!canBeReversal(r)) continue;
    const key = `${r.plaidAccountId}|${cents(r.amount)}`;
    if (!chargesByKey.has(key)) continue;
    const list = creditsByKey.get(key);
    if (list) list.push(r);
    else creditsByKey.set(key, [r]);
  }
  for (const [key, credits] of creditsByKey) {
    pairGroup(credits.sort(byDate), chargesByKey.get(key)!.sort(byDate), opts.isHeld, holdOf);
  }
  for (const creditId of holdOf.keys()) expiredIds.add(creditId);
  return { expiredIds, holdOf };
}

/** A read's pending answer: rows a posted row replaced, and (F6 round 3) expired holds. */
export type NotCountedSets = { replacedIds: ReadonlySet<string>; expiredIds: ReadonlySet<string> };

/** ⭐ (F6 round 3) Does this row count nowhere: a pending row a posted row replaced, or an expired hold (or its reversal)? */
export function countsNowhere(s: NotCountedSets, id: string): boolean {
  return s.replacedIds.has(id) || s.expiredIds.has(id);
}

/** ⭐ (F6 round 3) Every id that counts nowhere (`countsNowhere`), as one set. */
export function notCountedIdsOf(s: NotCountedSets): Set<string> {
  return new Set([...s.replacedIds, ...s.expiredIds]);
}

/** Negative when `a` is the better pending row for `posted` than `b`. */
function rankPending(a: SupersedeRow, b: SupersedeRow, posted: SupersedeRow): number {
  const gapA = cents(posted.amount) - cents(a.amount);
  const gapB = cents(posted.amount) - cents(b.amount);
  return (
    gapA - gapB ||
    a.occurredOn.localeCompare(b.occurredOn) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Pair posted rows with the pending rows they replaced, one to one. Posted rows
 * pick in date order (then `created_at`, then id); each takes the qualifying
 * pending row with the closest amount, then the oldest (holds post oldest first —
 * PR4c review), then id. Returns posted row id → the pending row it replaced.
 */
export function pairPendingWithPosted(rows: readonly SupersedeRow[]): Map<string, SupersedeRow> {
  const pendings = rows.filter((r) => r.pending && r.plaidAccountId);
  return pairPendingWithPostedAmong(rows, () => pendings);
}

/**
 * `pairPendingWithPosted`, offering each posted row only `candidatesFor(posted)`
 * instead of every pending row (PR7b review M1: the spending read has hundreds
 * of pending rows and must not test each against every posted row).
 *
 * ⚠️ SAME ANSWER ONLY IF THE CANDIDATES ARE COMPLETE: every pending row in
 * `rows` that `canSupersede`s a posted row must be among that posted row's
 * candidates. Extra candidates are harmless (`canSupersede` still decides), and
 * their order does not matter (`rankPending` is a total order).
 */
export function pairPendingWithPostedAmong(
  rows: readonly SupersedeRow[],
  candidatesFor: (posted: SupersedeRow) => readonly SupersedeRow[],
): Map<string, SupersedeRow> {
  const posteds = rows
    .filter((r) => !r.pending && r.plaidAccountId)
    .sort(
      (a, b) =>
        a.occurredOn.localeCompare(b.occurredOn) ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
  const taken = new Set<string>();
  const pairs = new Map<string, SupersedeRow>();
  for (const posted of posteds) {
    let best: SupersedeRow | null = null;
    for (const pending of candidatesFor(posted)) {
      if (taken.has(pending.id) || !canSupersede(pending, posted)) continue;
      if (!best || rankPending(pending, best, posted) < 0) best = pending;
    }
    if (best) {
      taken.add(best.id);
      pairs.set(posted.id, best);
    }
  }
  return pairs;
}
