import { descriptionsFuzzyEqual, tokenizeDescription } from "./descriptionMatch";
import { addDaysISO } from "./householdTime";

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

/** A pending row as the expired-hold rule reads it. */
export type ExpiredHoldRow = Pick<SupersedeRow, "id" | "plaidAccountId" | "pending" | "occurredOn" | "amount" | "description">;

/** What `expiredHolds` answers. */
export type ExpiredHolds = {
  /** The expired holds, and the reversals paired with them. They count nowhere. */
  expiredIds: Set<string>;
  /** A reversal's id → the expired hold it reversed (one to one). */
  holdOf: Map<string, string>;
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

/** Negative when `a` is the better reversal for `hold` than `b`. */
function rankReversal(a: ExpiredHoldRow, b: ExpiredHoldRow, hold: ExpiredHoldRow): number {
  const named = (r: ExpiredHoldRow) =>
    hasRealDescription(hold.description) && hasRealDescription(r.description) && descriptionsFuzzyEqual(hold.description, r.description) ? 0 : 1;
  const gap = (r: ExpiredHoldRow) => Date.parse(`${r.occurredOn}T00:00:00Z`) - Date.parse(`${hold.occurredOn}T00:00:00Z`);
  return named(a) - named(b) || gap(a) - gap(b) || a.occurredOn.localeCompare(b.occurredOn) || a.id.localeCompare(b.id);
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
 * ⭐ (F6 round 4) ONLY A CHARGE TAKES A REVERSAL. An expired hold that is money
 * out (a charge) may take a pending credit; an expired CREDIT expires alone and
 * never takes a charge — an orphan "Restaurant Transaction" credit whose hold a
 * tipped final replaced must not take a real 3-day-old purchase of the same
 * amount with it (finding 10: that purchase counted nowhere).
 * One to one, deterministic: holds pair oldest first (then id); each takes,
 * among the credits still free, a fuzzy-equal description first
 * (`descriptionsFuzzyEqual`, both real), then the closest date, the oldest,
 * then id. A row in a pair is never in another.
 *
 * Pure: the caller chooses the rows (all the pending rows that can pair with
 * the ones it asks about — see `findSupersededPendingForRange`). Non-pending
 * rows in `rows` are ignored.
 */
export function expiredHolds(
  rows: readonly ExpiredHoldRow[],
  todayISO: string,
  replacedIds: ReadonlySet<string>,
): ExpiredHolds {
  const expiredIds = new Set<string>();
  const holdOf = new Map<string, string>();
  const live = rows.filter((r) => r.pending && r.plaidAccountId && !replacedIds.has(r.id));
  // Candidate reversals — pending CREDITS only — by account and amount in cents.
  const creditsByKey = new Map<string, ExpiredHoldRow[]>();
  for (const r of live) {
    if (!(r.amount > 0)) continue;
    const key = `${r.plaidAccountId}|${cents(r.amount)}`;
    const list = creditsByKey.get(key);
    if (list) list.push(r);
    else creditsByKey.set(key, [r]);
  }
  const holds = live
    .filter((r) => isExpiredByAge(r, todayISO))
    .sort((a, b) => a.occurredOn.localeCompare(b.occurredOn) || a.id.localeCompare(b.id));
  const taken = new Set<string>();
  for (const hold of holds) {
    expiredIds.add(hold.id);
    // (F6 round 4) Only an expired CHARGE takes a reversal; a credit expires alone.
    if (!(hold.amount < 0)) continue;
    const last = addDaysISO(hold.occurredOn, REVERSAL_MAX_DAYS);
    let best: ExpiredHoldRow | null = null;
    for (const r of creditsByKey.get(`${hold.plaidAccountId}|${cents(hold.amount)}`) ?? []) {
      if (taken.has(r.id)) continue;
      if (r.occurredOn < hold.occurredOn || r.occurredOn > last) continue;
      if (!best || rankReversal(r, best, hold) < 0) best = r;
    }
    if (best) {
      taken.add(best.id);
      expiredIds.add(best.id);
      holdOf.set(best.id, hold.id);
    }
  }
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
