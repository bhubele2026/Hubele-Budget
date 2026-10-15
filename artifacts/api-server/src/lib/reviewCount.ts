import { and, eq, gte, lte, ne } from "drizzle-orm";
import {
  db,
  forecastSettingsTable,
  forecastResolutionsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import { rowAnswersResolve } from "@workspace/avalanche-core";
import { inForecastWhere } from "./forecastInclusion";
import { householdTodayISO, monthBounds } from "./householdClock";
import { resolveSnapshotAccount } from "./resolveSnapshotAccount";
import { readPausedReview } from "./oneTimeBillMove";
import { countsNowhere, findSupersededPendingForRange } from "./supersededPending";

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
 */
export async function computeReviewCount(
  householdId: string,
  ownerUserId: string,
): Promise<number> {
  const [settings] = await db
    .select({
      bankSnapshotAccountId: forecastSettingsTable.bankSnapshotAccountId,
      bankSnapshotMask: forecastSettingsTable.bankSnapshotMask,
    })
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, ownerUserId));
  const { externalId: checkingExternalId } = await resolveSnapshotAccount({
    householdId,
    bankSnapshotAccountId: settings?.bankSnapshotAccountId ?? null,
    bankSnapshotMask: settings?.bankSnapshotMask ?? null,
  });

  const today = householdTodayISO();
  const { start: monthStart, end: monthEnd } = monthBounds(today);

  const [txns, supersede] = await Promise.all([
    db
      .select({
        id: transactionsTable.id,
        source: transactionsTable.source,
        plaidAccountId: transactionsTable.plaidAccountId,
      })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, householdId),
          inForecastWhere(today),
          gte(transactionsTable.occurredOn, monthStart),
          lte(transactionsTable.occurredOn, monthEnd),
        ),
      ),
    // (S6) Which pending rows a posted row replaced — exact for every row of the month.
    findSupersededPendingForRange(householdId, monthStart, monthEnd, db, { today }),
  ]);

  const stored = await db
    .select({
      matchedTxnId: forecastResolutionsTable.matchedTxnId,
      status: forecastResolutionsTable.status,
      recurringItemId: forecastResolutionsTable.recurringItemId,
    })
    .from(forecastResolutionsTable)
    .where(eq(forecastResolutionsTable.householdId, householdId));
  // (One-time bill move, round 4) A pending review on a PAUSED bill reads as the
  // user's last answer: nothing can show the question while the bill is paused,
  // and resuming it brings the review — and this count — back.
  const paused = await db
    .select({ id: recurringItemsTable.id })
    .from(recurringItemsTable)
    .where(and(eq(recurringItemsTable.householdId, householdId), ne(recurringItemsTable.active, "true")));
  const pausedItemIds = new Set(paused.map((p) => p.id));
  const resolutions = stored.map((r) => readPausedReview(r, pausedItemIds));
  // (PR5) A "Not this" (`not_match`) answer rejects one suggested plan for the
  // row; the row itself is still unreviewed.
  // (One-time bill move) Neither does a pair an edit put in question
  // (`needs_review`, `needs_review_partial`): the row waits for the user's answer.
  // (S4) The rule is avalanche-core's `resolutionResolvesRow`, moved verbatim,
  // so the banking review's "unresolved" count reads the same answer.
  // (S6) Through `rowAnswersResolve`: a posted row with no answer of its own
  // carries the answers on the pending row it replaced.
  const answersByTxn = new Map<string, string[]>();
  for (const r of resolutions) {
    if (!r.matchedTxnId) continue;
    const list = answersByTxn.get(r.matchedTxnId);
    if (list) list.push(r.status);
    else answersByTxn.set(r.matchedTxnId, [r.status]);
  }
  const resolved = (id: string): boolean => {
    const replaced = supersede.replacedBy.get(id);
    return rowAnswersResolve(answersByTxn.get(id) ?? [], replaced ? (answersByTxn.get(replaced.id) ?? []) : []);
  };

  // isBankTxn semantics: account metadata wins; amex/plaid:* without a
  // checking match are card-side; manual rows default to bank.
  let count = 0;
  for (const t of txns) {
    if (t.plaidAccountId) {
      if (!checkingExternalId || t.plaidAccountId !== checkingExternalId)
        continue;
    } else {
      const s = (t.source ?? "manual").toLowerCase();
      if (s === "amex" || s.startsWith("plaid:")) continue;
    }
    // (S6) The pending half of a pair counts once, on its posted row.
    // ⭐ (F6 round 3) An expired hold (or its reversal) counts nowhere: it never asks for review.
    if (countsNowhere(supersede, t.id)) continue;
    if (resolved(t.id)) continue;
    count++;
  }
  return count;
}
