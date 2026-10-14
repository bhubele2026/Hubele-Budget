/**
 * ⭐ (S4) WHICH ANSWERS DECIDE A BANK ROW — one rule for every screen.
 *
 * A `forecast_resolutions` row that names a bank row (`matched_txn_id`) is the
 * household's answer about that row. Two questions were answered in two places
 * with their own copy of the rule:
 *   - "is this row still waiting for an answer?" — the Review badge
 *     (`computeReviewCount`, api-server/src/lib/reviewCount.ts);
 *   - "what does the Forecast register call this row?" — the bank line's status
 *     (`buildRegister`, h2budget/src/lib/forecastMatch.ts).
 * Both now read these two functions, moved verbatim (no figure changes), and the
 * banking review (`GET /banking/review`) reads them too.
 *
 *   - `not_match` ("Not this") rejects ONE plan/row pairing. It decides neither
 *     the plan nor the row: the row is still waiting.
 *   - `needs_review` / `needs_review_partial` (an edited one-time bill put the
 *     pair in question) wait for the household's answer too.
 *   - Every other answer that names the row decides it.
 */

/** What the Forecast register calls a bank row. */
export type BankLineStatus = "pending_bank" | "matched" | "ignored_unforecasted";

/** The pair statuses an edited one-time bill puts in question (they wait for an answer). */
export function isNeedsReviewResolution(status: string): boolean {
  return status === "needs_review" || status === "needs_review_partial";
}

/**
 * Does a resolution that names a bank row decide it? Everything but "Not this"
 * and a pair waiting for review. (The Review badge's rule, moved from
 * `computeReviewCount`.)
 */
export function resolutionResolvesRow(status: string): boolean {
  return status !== "not_match" && !isNeedsReviewResolution(status);
}

/**
 * The bank line's status from the answer that decides it (the register's rule,
 * moved from `buildRegister`): a match or a partial payment is "matched"; marked
 * not in the plan ("ignored_unforecasted", or the older "unplanned") is
 * "ignored_unforecasted"; anything else — no answer at all — is still pending.
 */
export function bankLineStatusOf(status: string | null | undefined): BankLineStatus {
  if (status === "matched" || status === "partial") return "matched";
  if (status === "ignored_unforecasted" || status === "unplanned") return "ignored_unforecasted";
  return "pending_bank";
}
