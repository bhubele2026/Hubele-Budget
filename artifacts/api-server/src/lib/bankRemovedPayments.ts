// ⭐ (PR-I round 2, review HIGH-2; owner rule "the forecast may read low, never
// high") AN ANSWER ABOUT A PAYMENT THE BANK TOOK BACK CLOSES NOTHING.
//
// A bill matched (or partly matched) to a bank row stays closed while that row
// counts. When the bank removes the row (`bank_removed`, `bankRemoved.ts`), cash
// adds the payment back — so a match that kept the bill closed would read HIGH
// by the bill: the money is still in the account AND the bill is off the curve.
// Every reader that closes a bill from `forecast_resolutions` (the ledger, the
// GET /forecast bundle, the review count) therefore drops a pair answer on a
// removed row, and the bill returns to the curve and to Review.
//
// EXCEPT a removed PENDING row a live posted row replaced
// (`findSupersededPending`, the pairing cash reads): the charge still happened,
// on the posted row, which takes the claim — the bill stays paid.

import { db } from "@workspace/db";
import { loadBankRemovedIds } from "./bankRemoved";
import { findSupersededPending, type DbReader } from "./supersededPending";

/** The pair answers a bank row backs: a match, a partial, or either put in review. */
const PAIR_ANSWER_STATUSES: ReadonlySet<string> = new Set([
  "matched",
  "partial",
  "needs_review",
  "needs_review_partial",
]);

/**
 * The household's rows whose payment the bank took back: every bank-removed
 * row, except a pending row a live posted row replaced (whole-ledger pairing,
 * so the ledger, the bundle and the review count agree). One small read when
 * the household has no marker.
 */
export async function loadRemovedPaymentIds(
  householdId: string,
  opts: { bankRemoved?: ReadonlySet<string>; reader?: DbReader } = {},
): Promise<Set<string>> {
  const reader = opts.reader ?? db;
  const removed = opts.bankRemoved ?? (await loadBankRemovedIds(householdId, reader));
  if (removed.size === 0) return new Set();
  const { replacedIds } = await findSupersededPending(householdId, reader);
  return new Set([...removed].filter((id) => !replacedIds.has(id)));
}

/** True when `r` is a pair answer about a payment the bank took back: it closes and claims nothing. */
export function answersRemovedPayment(
  r: { status: string; matchedTxnId: string | null },
  removedPaymentIds: ReadonlySet<string>,
): boolean {
  return !!r.matchedTxnId && removedPaymentIds.has(r.matchedTxnId) && PAIR_ANSWER_STATUSES.has(r.status);
}
