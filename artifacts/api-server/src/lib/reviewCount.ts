import { countNeedsYou } from "./needsYou";

/**
 * The Review-inbox count: unresolved BANK txns in the current calendar month
 * that are in the forecast (`inForecast`: already happened, or a future row
 * flagged for the forecast). Mirrors the client's `filterForecastTxns`/
 * `isBankTxn` semantics (h2budget/src/lib/forecastMatch.ts +
 * useReviewInboxCount) with three small queries — the layout used to pull the
 * entire ~30-query `/forecast` bundle on every route just to derive this
 * integer.
 *
 * ⚠️ THIS BODY WAS LIFTED VERBATIM OUT OF `routes/forecast.ts` — it is the same
 * code, not a second copy of it. It moved into a lib the moment a SECOND caller
 * appeared (`/api/spine`), because the badge in the nav and the badge on the
 * landing hero are the same claim and must never be able to disagree. Two
 * hand-kept implementations of "how many things need looking at" is exactly the
 * class of drift the spine exists to end. `GET /forecast/review-count` now calls
 * this; so does the spine; there is one definition.
 *
 * The bank account comes from `resolveSnapshotAccount` — the same resolution
 * the balance roll-forward uses — so a dangling snapshot pointer cannot zero
 * the badge while the curve keeps moving. "Today" and "this month" are the
 * household's (America/Chicago), so the badge doesn't jump to next month on
 * the last evening of a month on a UTC server.
 *
 * ⭐ (S6) A CHARGE IS ONE ROW TO REVIEW, even when the sync never linked its
 * pending row to its posted row. The pairs are spending's own
 * (`findSupersededPendingForRange`, as `buildSpendingFacts` and the bank
 * register read them): the pending half a posted row replaced is not counted,
 * and the posted row carries the answers on that pending row when it has none
 * of its own (`rowAnswersResolve`, the banking review's rule). Before S6 an
 * unanswered pair counted twice, and a charge answered while pending was asked
 * about again once it posted.
 *
 * ⭐ (F6 round 3) An expired hold — pending more than 7 days after its date,
 * never replaced — and its reversal count nowhere, so they never ask for review
 * (`countsNowhere`, the same read's `expiredIds`).
 *
 * ⭐ (BANK-AUTO) ONE COUNT. The body above moved, verbatim, into
 * `readUnresolvedBankRows` (lib/unresolvedBankRows.ts) — the rows still waiting
 * for a match — and this count is now the ONE LIST's (`countNeedsYou`,
 * lib/needsYou.ts, what `GET /banking/needs-you` returns as `count`): those
 * rows, plus every charge the categorization review queue holds that is not
 * one of them (a charge on both counts once). Before, the badge counted the
 * match rows only and the web added the queue's own total beside it; now every
 * badge is this one number. Rows the forecast ledger had already paired leave
 * it when the bank auto-sort (lib/bankAutoSort.ts) matches them.
 */
export async function computeReviewCount(
  householdId: string,
  ownerUserId: string,
): Promise<number> {
  return countNeedsYou(householdId, ownerUserId);
}
