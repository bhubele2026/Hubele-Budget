/**
 * (#642 / #666) Shared transfer / card-payment heuristic.
 *
 * Originally this heuristic auto-flagged any transaction whose Plaid
 * `personal_finance_category.primary` was TRANSFER_IN/TRANSFER_OUT/
 * LOAN_PAYMENTS, or whose description matched a list of canonical
 * transfer phrasings (e.g. "Online Transfer to SAV", "payment - thank
 * you"), as `isTransfer=true` so it would be excluded from spending
 * buckets.
 *
 * (#666) Per user request, auto-detection is disabled. The user wants
 * full manual control: a transaction only becomes a transfer when they
 * explicitly assign it to the system "Transfer" category. The
 * constants below are intentionally empty so:
 *   - `categorize()` in `autoCategorize.ts` always returns
 *     `isTransfer: false` for new rows on Plaid sync / XLSX import.
 *   - The dashboard's defensive bucket predicate
 *     (`isTxnInBucket` in `dashboard.tsx`) no longer hides rows whose
 *     description "looks like" a transfer.
 *   - The startup card-payment reclassify sweep
 *     (`runStartupCardPaymentReclassify`) walks empty pattern lists,
 *     short-circuits, and is a no-op on every boot.
 *   - The Unplanned-bucket write guards in `routes/transactions.ts`
 *     never reject a user's tag attempt.
 *
 * Existing rows whose `isTransfer=true` was set by the previous
 * heuristic are left alone (the user can clear them individually via
 * the Transfer chip's X). The manual "pick the Transfer category"
 * path in `routes/transactions.ts` continues to set `isTransfer=true`
 * + `isTransferUserOverridden=true`, which is the only auto-flagging
 * path that remains.
 */

export const TRANSFER_PFC_PRIMARY: ReadonlySet<string> = new Set();

export const TRANSFER_DESC_PATTERNS: readonly string[] = [];

/**
 * (#666) Always returns false. Kept as an exported function so existing
 * call sites compile unchanged; with the constants above empty, this
 * is a constant-false predicate.
 */
export function isHeuristicTransfer(
  _description?: string | null | undefined,
  _pfcPrimary?: string | null,
): boolean {
  return false;
}
