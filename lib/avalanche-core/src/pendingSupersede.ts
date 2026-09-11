import { descriptionsFuzzyEqual } from "./descriptionMatch";
import { addDaysISO } from "./householdTime";

/** A posted row can replace a pending row dated up to this many days before it. */
export const SUPERSEDE_MAX_DAYS = 7;

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
const dayNumber = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

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
 *   - the descriptions are fuzzy-equal (`descriptionsFuzzyEqual`).
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
  return descriptionsFuzzyEqual(pending.description, posted.description);
}

/**
 * Pair posted rows with the pending rows they replaced, one to one. Posted rows
 * pick in date order (then `created_at`, then id); each takes the nearest-dated
 * qualifying pending row, then the closest amount, then the oldest, then id.
 * Returns posted row id → the pending row it replaced.
 */
export function pairPendingWithPosted(rows: readonly SupersedeRow[]): Map<string, SupersedeRow> {
  const pendings = rows.filter((r) => r.pending && r.plaidAccountId);
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
    let bestKey: [number, number, number, string] | null = null;
    for (const pending of pendings) {
      if (taken.has(pending.id) || !canSupersede(pending, posted)) continue;
      const key: [number, number, number, string] = [
        dayNumber(posted.occurredOn) - dayNumber(pending.occurredOn),
        cents(posted.amount) - cents(pending.amount),
        pending.createdAt.getTime(),
        pending.id,
      ];
      if (
        !bestKey ||
        key[0] < bestKey[0] ||
        (key[0] === bestKey[0] &&
          (key[1] < bestKey[1] ||
            (key[1] === bestKey[1] && (key[2] < bestKey[2] || (key[2] === bestKey[2] && key[3] < bestKey[3])))))
      ) {
        best = pending;
        bestKey = key;
      }
    }
    if (best) {
      taken.add(best.id);
      pairs.set(posted.id, best);
    }
  }
  return pairs;
}
