import { and, asc, eq, inArray } from "drizzle-orm";
import { db, forecastResolutionsTable, forecastSettingsTable, transactionsTable } from "@workspace/db";
import {
  addDaysISO,
  inForecast,
  isBankRow,
  rowInMatchWindow,
  rowPaysPlanInFull,
  rowWithinMatchAmount,
} from "@workspace/avalanche-core";
import { householdTodayISO } from "./householdClock";
import { resolveSnapshotAccount } from "./resolveSnapshotAccount";

/**
 * ⭐ EDITING A ONE-TIME BILL KEEPS ITS ANSWERS — AND NEVER MARKS IT PAID SILENTLY
 * (owner decision 9).
 *
 * Resolutions are keyed on `<itemId>|<occurrenceDate>`, and a one-time bill has
 * exactly one occurrence: its `anchor_date`. `PATCH /recurring-items/:id` used to
 * overwrite that date and leave every answer behind on the old one — and
 * `resolutionRemap` never maps one-time bills — so a paid bill moved from the
 * 20th to the 25th came back unpaid.
 *
 * When a PATCH changes a one-time bill's date, amount or kind (it stays
 * one-time), the route calls `moveOneTimeResolutions` in the SAME transaction as
 * the item update, with the item and its answers locked (`FOR UPDATE`):
 *   - every answer on the old date moves to the new date: matched, partial,
 *     skipped, missed, dismissed, "Not this", a pending review. So does an answer
 *     written on the date a Forecast "Move" sent the bill to (pre-PR6);
 *   - a Forecast "Move" (`rescheduled`) on the old date — or one left on the new
 *     date — is DELETED: the edit now carries the date;
 *   - a `matched` / `partial` pair is re-checked around the new due date:
 *       · its row must sit inside the matcher's CANDIDATE date window
 *         (`rowInMatchWindow`: 10 days before to 14 after) and have the plan's sign;
 *       · (round 3) when the signed amount changed, a MATCH stays paid only if its
 *         row pays the new amount in full (`rowPaysPlanInFull`: short by at most
 *         max($1, 1%), over by at most max($25, 10%) — the proof that takes a plan
 *         off the curve). A date-only move keeps the match the user accepted;
 *       · a PARTIAL still pays part when its row leaves more than $1 of the new
 *         amount unpaid (the ledger's remainder rule) and, when the amount changed,
 *         the new amount is within max($25, 25%) of the old one — a bill re-amounted
 *         into a clearly different bill (round 3) is not silently credited;
 *       · a pair that no longer pays becomes `needs_review` (a match) or
 *         `needs_review_partial` (a partial), keeping `matched_txn_id` — but only
 *         when Forecast Review can show it: the new date inside the register
 *         (first of last month .. today + the forecast horizon) and the row a
 *         checking row in the forecast. Otherwise the match is CLEARED and the
 *         bill is unresolved on its new date — never an answer nobody can give;
 *       · a pair whose bank row no longer exists is cleared;
 *       · a pending review never turns paid on its own, wherever the bill moves;
 *   - ONE DECISION PER KEY. An answer already stranded on the new date (an older
 *     edit, or a frequency change) is re-checked the same way; a live answer that
 *     still holds wins, then a stranded pair that still pays, then the live
 *     pending review, then a stranded pending review Review can show. The rest
 *     are deleted (a stranded skip or miss is never adopted).
 * The result (`carried`, `needsReview`, `cleared`) goes back in the PATCH
 * response, and the Bills page says it in its toast (round 3).
 * Every reader treats both review statuses as UNRESOLVED: the plan is on the
 * curve (or overdue by the usual rules), the row counts in Review, Bills does not
 * count it paid. Forecast Review answers them with Confirm (→ `matched`), Not
 * this (→ `not_match`) and, for a partial first, Partial (→ `partial`).
 * A bill paused, archived, deleted or no longer one-time drops its pending
 * reviews (`clearPendingReviews`): nothing could show them any more.
 * Bank transaction rows are only read, never written. Recurring (non-one-time)
 * bills are not re-checked here: `resolutionRemap` maps their answers at read time.
 */

export const NEEDS_REVIEW_STATUS = "needs_review";
export const NEEDS_REVIEW_PARTIAL_STATUS = "needs_review_partial";

export function isNeedsReviewStatus(status: string): boolean {
  return status === NEEDS_REVIEW_STATUS || status === NEEDS_REVIEW_PARTIAL_STATUS;
}

/** Statuses that decide a plan occurrence. At most one survives on a key. */
const DECISION_STATUSES: ReadonlySet<string> = new Set([
  "matched",
  "partial",
  "skipped",
  "missed",
  "dismissed",
  NEEDS_REVIEW_STATUS,
  NEEDS_REVIEW_PARTIAL_STATUS,
]);
/** Decisions that name a bank row. */
const PAIR_STATUSES: ReadonlySet<string> = new Set(["matched", "partial", NEEDS_REVIEW_STATUS, NEEDS_REVIEW_PARTIAL_STATUS]);

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type ItemFields = { frequency: string; anchorDate: string | null; kind: string; amount: string };

/** The signed plan amount `expandItem` puts on the curve: income positive, everything else negative. */
export function planAmountOf(item: { kind: string; amount: string | number }): number {
  const amount = Math.abs(Number(item.amount) || 0);
  return item.kind === "income" ? amount : -amount;
}

export type OneTimeEdit = { from: string; to: string; planAmount: number; previousPlanAmount: number };

/** The edit to re-check when a one-time bill stays one-time and its date or signed amount changed; null otherwise. */
export function oneTimeEdit(before: ItemFields, after: ItemFields): OneTimeEdit | null {
  if (before.frequency !== "onetime" || after.frequency !== "onetime") return null;
  if (!before.anchorDate || !after.anchorDate) return null;
  const planAmount = planAmountOf(after);
  const previousPlanAmount = planAmountOf(before);
  if (before.anchorDate === after.anchorDate && previousPlanAmount === planAmount) return null;
  return { from: before.anchorDate, to: after.anchorDate, planAmount, previousPlanAmount };
}

/**
 * Drops an item's pending reviews (`needs_review`, `needs_review_partial`) when
 * nothing can show them any more — the bill stopped being one-time (review M2c),
 * was paused or archived, or was deleted (round 3). Each would otherwise keep
 * claiming its bank row. The row goes back to Review unclaimed.
 */
export async function clearPendingReviews(
  tx: Tx | typeof db,
  householdId: string,
  itemIds: string | readonly string[],
): Promise<number> {
  const ids = typeof itemIds === "string" ? [itemIds] : [...itemIds];
  if (ids.length === 0) return 0;
  const gone = await tx
    .delete(forecastResolutionsTable)
    .where(
      and(
        eq(forecastResolutionsTable.householdId, householdId),
        inArray(forecastResolutionsTable.recurringItemId, ids),
        inArray(forecastResolutionsTable.status, [NEEDS_REVIEW_STATUS, NEEDS_REVIEW_PARTIAL_STATUS]),
      ),
    )
    .returning({ id: forecastResolutionsTable.id });
  return gone.length;
}

/** What an edit did to a one-time bill's answers — returned in the PATCH response as `moveResult`. */
export type OneTimeMoveResult = {
  /** Answers kept on the bill as they were: a match still paying it, a skip, a rejection. */
  carried: number;
  /** Bank-row pairs that now wait for an answer in Forecast Review. */
  needsReview: number;
  /** The bill's own matches removed — Review could not show them, or their row is gone. The bill shows unpaid. */
  cleared: number;
};

type PaidRow = {
  occurredOn: string;
  amount: number;
  source: string | null;
  plaidAccountId: string | null;
  forecastFlag: boolean | null;
};

type ReviewContext = {
  todayISO: string;
  registerFromISO: string;
  registerToISO: string;
  checkingExternalId: string | null;
};

function firstOfLastMonthISO(todayISO: string): string {
  const [y, m] = todayISO.split("-").map(Number);
  const d = new Date(y!, m! - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

/**
 * What Forecast Review can show: the `/forecast` bundle expands plans from the
 * first of last month to today + the horizon, and keeps a pair only when its row
 * is a checking row in the forecast (the same account resolution the bundle uses).
 */
async function loadReviewContext(householdId: string, ownerUserId: string): Promise<ReviewContext> {
  const [settings] = await db
    .select({
      daysAhead: forecastSettingsTable.daysAhead,
      bankSnapshotAccountId: forecastSettingsTable.bankSnapshotAccountId,
      bankSnapshotMask: forecastSettingsTable.bankSnapshotMask,
    })
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, ownerUserId));
  const { externalId } = await resolveSnapshotAccount({
    householdId,
    bankSnapshotAccountId: settings?.bankSnapshotAccountId ?? null,
    bankSnapshotMask: settings?.bankSnapshotMask ?? null,
  });
  const todayISO = householdTodayISO();
  return {
    todayISO,
    registerFromISO: firstOfLastMonthISO(todayISO),
    registerToISO: addDaysISO(todayISO, settings?.daysAhead || 90),
    checkingExternalId: externalId,
  };
}

/** A partial still pays PART of the plan: same sign, and more than $1 left unpaid (the ledger's remainder rule). */
function stillPartial(planAmount: number, paid: number): boolean {
  if (Math.sign(planAmount) !== Math.sign(paid)) return false;
  const remainder = Math.round((planAmount - paid) * 100) / 100;
  return Math.abs(remainder) > 1 && Math.sign(remainder) === Math.sign(planAmount);
}

function toReviewStatus(status: string): string {
  if (status === "matched") return NEEDS_REVIEW_STATUS;
  if (status === "partial") return NEEDS_REVIEW_PARTIAL_STATUS;
  return status;
}

export async function moveOneTimeResolutions(
  tx: Tx,
  ctx: { householdId: string; ownerUserId: string },
  itemId: string,
  edit: OneTimeEdit,
): Promise<OneTimeMoveResult> {
  const { householdId, ownerUserId } = ctx;
  const { from, to, planAmount, previousPlanAmount } = edit;
  const dateMoved = from !== to;
  const amountChanged = planAmount !== previousPlanAmount;

  // (Review L2) The item row is already locked by the route; lock its answers too,
  // so a concurrent Review answer cannot land between this read and the writes.
  const own = await tx
    .select({
      id: forecastResolutionsTable.id,
      status: forecastResolutionsTable.status,
      occurrenceDate: forecastResolutionsTable.occurrenceDate,
      matchedTxnId: forecastResolutionsTable.matchedTxnId,
      rescheduledTo: forecastResolutionsTable.rescheduledTo,
    })
    .from(forecastResolutionsTable)
    .where(
      and(
        eq(forecastResolutionsTable.householdId, householdId),
        eq(forecastResolutionsTable.recurringItemId, itemId),
      ),
    )
    .orderBy(asc(forecastResolutionsTable.createdAt), asc(forecastResolutionsTable.id))
    .for("update");

  const reschedules = own.filter((r) => r.status === "rescheduled" && r.occurrenceDate === from);
  const movedTo = new Set(reschedules.map((r) => r.rescheduledTo).filter((d): d is string => !!d));
  // The date the bill is due after the edit: the new date, or — when only the
  // amount or kind changed — where a Forecast Move put it.
  const dueISO = dateMoved ? to : (reschedules.find((r) => r.rescheduledTo)?.rescheduledTo ?? to);
  const onLiveDate = (d: string | null) => d != null && (d === from || movedTo.has(d));
  const live = own.filter((r) => r.status !== "rescheduled" && onLiveDate(r.occurrenceDate));
  const stranded = dateMoved
    ? own.filter((r) => r.status !== "rescheduled" && r.occurrenceDate === to && !onLiveDate(r.occurrenceDate))
    : [];
  const replacedMoves = dateMoved
    ? own.filter((r) => r.status === "rescheduled" && (r.occurrenceDate === from || r.occurrenceDate === to))
    : [];

  const pairTxnIds = [
    ...new Set(
      [...live, ...stranded].filter((r) => PAIR_STATUSES.has(r.status) && r.matchedTxnId).map((r) => r.matchedTxnId!),
    ),
  ];
  const rows = new Map<string, PaidRow>();
  if (pairTxnIds.length > 0) {
    const found = await tx
      .select({
        id: transactionsTable.id,
        occurredOn: transactionsTable.occurredOn,
        amount: transactionsTable.amount,
        source: transactionsTable.source,
        plaidAccountId: transactionsTable.plaidAccountId,
        forecastFlag: transactionsTable.forecastFlag,
      })
      .from(transactionsTable)
      .where(and(eq(transactionsTable.householdId, householdId), inArray(transactionsTable.id, pairTxnIds)));
    for (const t of found) {
      rows.set(t.id, {
        occurredOn: t.occurredOn,
        amount: Number(t.amount) || 0,
        source: t.source ?? null,
        plaidAccountId: t.plaidAccountId ?? null,
        forecastFlag: t.forecastFlag ?? null,
      });
    }
  }

  let review: ReviewContext | undefined;
  const reviewCanShow = async (row: PaidRow): Promise<boolean> => {
    review ??= await loadReviewContext(householdId, ownerUserId);
    return (
      dueISO >= review.registerFromISO &&
      dueISO <= review.registerToISO &&
      inForecast({ occurredOn: row.occurredOn, forecastFlag: row.forecastFlag }, review.todayISO) &&
      isBankRow(row.source, row.plaidAccountId, review.checkingExternalId)
    );
  };
  const stillPays = (status: string, row: PaidRow): boolean => {
    if (status !== "matched" && status !== "partial") return false;
    if (!rowInMatchWindow(dueISO, row.occurredOn)) return false;
    if (Math.sign(row.amount) !== Math.sign(planAmount)) return false;
    if (status === "matched") return !amountChanged || rowPaysPlanInFull(planAmount, row.amount);
    return (
      stillPartial(planAmount, row.amount) && (!amountChanged || rowWithinMatchAmount(previousPlanAmount, planAmount))
    );
  };

  type Kept = { id: string; occurrenceDate: string | null; was: string; status: string; rank: number };
  const kept: Kept[] = [];
  const deletes: string[] = replacedMoves.map((r) => r.id);
  let cleared = 0;
  const keep = (r: (typeof own)[number], status: string, rank: number) =>
    kept.push({ id: r.id, occurrenceDate: r.occurrenceDate, was: r.status, status, rank });

  for (const r of live) {
    if (!DECISION_STATUSES.has(r.status)) continue;
    if (!PAIR_STATUSES.has(r.status)) {
      keep(r, r.status, 0);
      continue;
    }
    const row = r.matchedTxnId ? rows.get(r.matchedTxnId) : undefined;
    if (row && stillPays(r.status, row)) keep(r, r.status, 0);
    else if (row && (await reviewCanShow(row))) keep(r, toReviewStatus(r.status), 2);
    else {
      // (Review L1) its bank row is gone; (M2a/b) Review could never show the question.
      deletes.push(r.id);
      cleared++;
    }
  }
  for (const r of stranded) {
    if (!DECISION_STATUSES.has(r.status)) continue;
    const row = r.matchedTxnId ? rows.get(r.matchedTxnId) : undefined;
    if (row && stillPays(r.status, row)) keep(r, r.status, 1);
    else if (row && isNeedsReviewStatus(r.status) && (await reviewCanShow(row))) keep(r, r.status, 3);
    else deletes.push(r.id);
  }

  // (Review M1) One decision per key on the new date.
  let winners = kept;
  if (dateMoved && kept.length > 1) {
    const best = kept.reduce((a, b) => (b.rank < a.rank ? b : a));
    winners = [best];
    for (const k of kept) if (k !== best) deletes.push(k.id);
  }

  const inHousehold = eq(forecastResolutionsTable.householdId, householdId);
  for (const k of winners) {
    const date = dateMoved ? to : k.occurrenceDate;
    if (date === k.occurrenceDate && k.status === k.was) continue;
    await tx
      .update(forecastResolutionsTable)
      .set({ occurrenceDate: date, status: k.status })
      .where(and(inHousehold, eq(forecastResolutionsTable.id, k.id)));
  }
  const rejections = live.filter((r) => r.status === "not_match");
  const rekey = rejections.filter((r) => dateMoved && r.occurrenceDate !== to).map((r) => r.id);
  if (rekey.length > 0) {
    await tx
      .update(forecastResolutionsTable)
      .set({ occurrenceDate: to })
      .where(and(inHousehold, inArray(forecastResolutionsTable.id, rekey)));
  }
  if (deletes.length > 0) {
    await tx.delete(forecastResolutionsTable).where(and(inHousehold, inArray(forecastResolutionsTable.id, deletes)));
  }
  const needsReview = winners.filter((k) => isNeedsReviewStatus(k.status)).length;
  return { carried: winners.length - needsReview + rejections.length, needsReview, cleared };
}
