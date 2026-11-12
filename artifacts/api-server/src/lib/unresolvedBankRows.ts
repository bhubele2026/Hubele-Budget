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
 * ⭐ (BANK-AUTO) THE BANK ROWS STILL WAITING FOR A MATCH — the body of
 * `computeReviewCount` (lib/reviewCount.ts), moved here VERBATIM and made to
 * return the rows instead of counting them, so the one list
 * (`GET /banking/needs-you`, lib/needsYou.ts), the badge and the auto-sort
 * (lib/bankAutoSort.ts) read the same rows by the same rule. No rule changed:
 *
 *   - bank rows only (isBankTxn semantics: account metadata wins; amex/plaid:*
 *     without a checking match are card-side; manual rows default to bank),
 *     on the account `resolveSnapshotAccount` resolves — the one the balance
 *     roll-forward uses;
 *   - in the forecast (`inForecastWhere`: dated through today, or a future row
 *     flagged for it), dated inside the range (default: the household's
 *     current calendar month, America/Chicago);
 *   - (S6) the pending half a posted row replaced is not a row, and the posted
 *     row carries the answers on that pending row when it has none of its own
 *     (`rowAnswersResolve`);
 *   - (F6 round 3) an expired hold and its reversal count nowhere;
 *   - a row an answer decides is not waiting ("Not this" and a pair waiting
 *     for review do not decide; a pending review on a PAUSED bill reads as the
 *     household's last answer).
 */
export interface UnresolvedBankRow {
  id: string;
  occurredOn: string;
  description: string;
  amount: string;
  pending: boolean;
  plaidAccountId: string | null;
  source: string;
  account: string | null;
}

export interface UnresolvedBankRows {
  today: string;
  from: string;
  to: string;
  /** The forecast account's Plaid `account_id`, when it resolves. */
  checkingExternalId: string | null;
  /** Newest first, then id. */
  rows: UnresolvedBankRow[];
}

export async function readUnresolvedBankRows(
  householdId: string,
  ownerUserId: string,
  range?: { from: string; to: string },
): Promise<UnresolvedBankRows> {
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
  const { start: monthStart, end: monthEnd } = range ? { start: range.from, end: range.to } : monthBounds(today);

  const [txns, supersede] = await Promise.all([
    db
      .select({
        id: transactionsTable.id,
        source: transactionsTable.source,
        plaidAccountId: transactionsTable.plaidAccountId,
        occurredOn: transactionsTable.occurredOn,
        description: transactionsTable.description,
        amount: transactionsTable.amount,
        pending: transactionsTable.pending,
        account: transactionsTable.account,
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
    // (S6) Which pending rows a posted row replaced — exact for every row of the range.
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
  const rows: UnresolvedBankRow[] = [];
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
    rows.push(t);
  }
  rows.sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : a.occurredOn > b.occurredOn ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return { today, from: monthStart, to: monthEnd, checkingExternalId: checkingExternalId ?? null, rows };
}
