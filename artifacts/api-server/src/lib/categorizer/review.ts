// (PR-A) The review queue: open decisions (provisional | queue, unresolved,
// not undone), oldest first, and what a person can do with one.
import { and, asc, count, eq, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { db, categoryDecisionsTable, merchantMemoryTable, transactionsTable } from "@workspace/db";
import { merchantSignature } from "../merchantNameExtract";
import { rowsWithSignature, type RetroactiveCandidates } from "./memory";
import { categoryBelongs, recordHandFiling, setCategoryByHand } from "./userDecisions";

const OPEN = and(
  inArray(categoryDecisionsTable.band, ["provisional", "queue"]),
  isNull(categoryDecisionsTable.resolvedAt),
  isNull(categoryDecisionsTable.undoneAt),
);

/** (V1) How many decisions wait in the household's review queue. */
export async function openReviewCount(householdId: string): Promise<number> {
  const [{ total }] = (await db
    .select({ total: count() })
    .from(categoryDecisionsTable)
    .where(and(eq(categoryDecisionsTable.householdId, householdId), OPEN))) as [{ total: number }];
  return Number(total);
}

/**
 * (V1) A provisional model suggestion nobody answered for this many days, whose
 * charge still carries it and is not locked, counts as accepted — silently.
 */
export const SILENT_ACCEPT_DAYS = 14;

/**
 * ⭐ (V1) Silent acceptance. A model decision that is provisional (written and
 * flagged), unresolved and not undone, decided at least SILENT_ACCEPT_DAYS ago,
 * whose transaction STILL carries that category and is NOT locked by a person,
 * becomes resolution 'accepted', resolved_via 'silent'. Nothing else moves: the
 * transaction is not written, no memory is learned (memory is a person's act),
 * the lock stays off. A changed category or a locked row is never settled.
 * Idempotent: a settled decision is no longer open. Returns how many settled.
 */
export async function settleSilentAcceptances(householdId: string, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SILENT_ACCEPT_DAYS * 86_400_000);
  const rows = await db
    .update(categoryDecisionsTable)
    .set({ resolution: "accepted", resolvedAt: now, resolvedVia: "silent" })
    .where(
      and(
        eq(categoryDecisionsTable.householdId, householdId),
        eq(categoryDecisionsTable.source, "model"),
        eq(categoryDecisionsTable.band, "provisional"),
        isNull(categoryDecisionsTable.resolution),
        isNull(categoryDecisionsTable.resolvedAt),
        isNull(categoryDecisionsTable.undoneAt),
        lte(categoryDecisionsTable.createdAt, cutoff),
        sql`${categoryDecisionsTable.categoryId} IS NOT NULL`,
        sql`EXISTS (
          SELECT 1 FROM ${transactionsTable}
           WHERE ${transactionsTable.id} = ${categoryDecisionsTable.transactionId}
             AND ${transactionsTable.householdId} = ${householdId}
             AND ${transactionsTable.categoryId} = ${categoryDecisionsTable.categoryId}
             AND ${transactionsTable.categoryLockedByUser} = false
        )`,
      ),
    )
    .returning({ id: categoryDecisionsTable.id });
  return rows.length;
}

export interface ReviewItem {
  decisionId: string;
  transactionId: string;
  occurredOn: string;
  description: string;
  amount: string;
  account: string | null;
  currentCategoryId: string | null;
  suggestedCategoryId: string | null;
  confidence: number;
  band: string;
  source: string;
  explanation: string;
  createdAt: string;
  flags: { novelMerchant: boolean; amountAnomaly: boolean; splitNeedsRebalance: boolean };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** > 3× the merchant's median over ≥ 3 earlier rows, or > $500 with none. */
export function amountAnomaly(amount: number, priors: readonly number[]): boolean {
  const a = Math.abs(amount);
  if (priors.length >= 3) return a > 3 * median(priors.map(Math.abs));
  if (priors.length === 0) return a > 500;
  return false;
}

export async function listReviewQueue(
  householdId: string,
  limit: number,
): Promise<{ items: ReviewItem[]; total: number }> {
  const rows = await db
    .select({
      decisionId: categoryDecisionsTable.id,
      transactionId: categoryDecisionsTable.transactionId,
      suggestedCategoryId: categoryDecisionsTable.categoryId,
      confidence: categoryDecisionsTable.confidence,
      band: categoryDecisionsTable.band,
      source: categoryDecisionsTable.source,
      explanation: categoryDecisionsTable.explanation,
      createdAt: categoryDecisionsTable.createdAt,
      occurredOn: transactionsTable.occurredOn,
      description: transactionsTable.description,
      amount: transactionsTable.amount,
      account: transactionsTable.account,
      currentCategoryId: transactionsTable.categoryId,
      splitsInvalid: transactionsTable.splitsInvalid,
      txnCreatedAt: transactionsTable.createdAt,
    })
    .from(categoryDecisionsTable)
    .innerJoin(transactionsTable, eq(transactionsTable.id, categoryDecisionsTable.transactionId))
    .where(and(eq(categoryDecisionsTable.householdId, householdId), OPEN))
    .orderBy(asc(categoryDecisionsTable.createdAt), asc(categoryDecisionsTable.id))
    .limit(limit);
  const total = await openReviewCount(householdId);
  const items: ReviewItem[] = [];
  for (const r of rows) {
    const sig = merchantSignature(r.description);
    const priors = sig
      ? (await rowsWithSignature(db, householdId, sig)).filter(
          (p) =>
            p.id !== r.transactionId &&
            (p.occurredOn < r.occurredOn ||
              (p.occurredOn === r.occurredOn && p.createdAt.getTime() < r.txnCreatedAt.getTime())),
        )
      : [];
    items.push({
      decisionId: r.decisionId,
      transactionId: r.transactionId,
      occurredOn: r.occurredOn,
      description: r.description,
      amount: r.amount,
      account: r.account,
      currentCategoryId: r.currentCategoryId,
      suggestedCategoryId: r.suggestedCategoryId,
      confidence: Number(r.confidence),
      band: r.band,
      source: r.source,
      explanation: r.explanation,
      createdAt: r.createdAt.toISOString(),
      flags: {
        novelMerchant: priors.length === 0,
        amountAnomaly: amountAnomaly(Number(r.amount), priors.map((p) => Number(p.amount))),
        splitNeedsRebalance: r.splitsInvalid,
      },
    });
  }
  return { items, total };
}

export type ReviewOutcome =
  | {
      status: 200;
      body: {
        decisionId: string;
        transactionId: string;
        resolution: "accepted" | "corrected" | "skipped";
        categoryId: string | null;
        userDecisionId: string | null;
        retroactiveCandidates: RetroactiveCandidates | null;
      };
    }
  | { status: 400 | 404 | 409; body: { error: string } };

async function openDecision(householdId: string, decisionId: string) {
  const [d] = await db
    .select()
    .from(categoryDecisionsTable)
    .where(and(eq(categoryDecisionsTable.id, decisionId), eq(categoryDecisionsTable.householdId, householdId)));
  return d ?? null;
}

/**
 * accept: the suggestion becomes the person's own filing (locked, memory);
 * a notice with no category is just acknowledged. skip: resolved, nothing
 * written. correct: the person's category, locked, memory learned.
 */
export async function resolveDecision(
  householdId: string,
  actor: string,
  decisionId: string,
  action: "accept" | "skip" | "correct",
  categoryId?: string,
): Promise<ReviewOutcome> {
  const d = await openDecision(householdId, decisionId);
  if (!d) return { status: 404, body: { error: "Not found" } };
  if (d.resolvedAt || d.undoneAt) return { status: 409, body: { error: "This decision is already resolved." } };
  const done = (
    resolution: "accepted" | "corrected" | "skipped",
    cat: string | null,
    userDecisionId: string | null,
    retro: RetroactiveCandidates | null,
  ): ReviewOutcome => ({
    status: 200,
    body: { decisionId: d.id, transactionId: d.transactionId, resolution, categoryId: cat, userDecisionId, retroactiveCandidates: retro },
  });
  const target = action === "correct" ? (categoryId ?? null) : action === "accept" ? d.categoryId : null;
  if (action === "correct" && (!target || !(await categoryBelongs(householdId, target)))) {
    return { status: 400, body: { error: "Unknown category." } };
  }
  if (action === "skip" || (action === "accept" && !target)) {
    const resolution = action === "skip" ? "skipped" : "accepted";
    await db
      .update(categoryDecisionsTable)
      .set({ resolvedAt: new Date(), resolvedBy: actor, resolution, resolvedVia: "user" })
      .where(eq(categoryDecisionsTable.id, d.id));
    return done(resolution, d.categoryId, null, null);
  }
  const set = await setCategoryByHand(householdId, d.transactionId, target!);
  if (!set) return { status: 404, body: { error: "Not found" } };
  const resolution = action === "accept" ? "accepted" : "corrected";
  const filed = await recordHandFiling(householdId, actor, d.transactionId, {
    previousCategoryId: set.previousCategoryId,
    categoryId: target,
    answering: { decisionId: d.id, resolution },
  });
  return done(resolution, target, filed?.decisionId ?? null, filed?.retroactiveCandidates ?? null);
}

/**
 * (V1) Why a decision cannot be undone right now, or null when it can. The one
 * rule both `undoDecision` and the settings view's `undoable` use: not already
 * undone, not the `locked` marker, an automatic decision never moves a locked
 * row, and a decision that wrote a category only while the row still holds it.
 */
export function undoRefusal(
  d: { source: string; band: string; categoryId: string | null; undoneAt: Date | null },
  t: { categoryId: string | null; locked: boolean },
): { status: 400 | 409; error: string } | null {
  if (d.undoneAt) return { status: 409, error: "Already undone." };
  if (d.source === "locked") return { status: 400, error: "Nothing to undo." };
  if (d.source !== "user" && t.locked) return { status: 409, error: "You filed this one yourself; it does not move." };
  const wrote = d.source === "user" || (d.band !== "queue" && d.categoryId != null);
  if (wrote && t.categoryId !== d.categoryId) return { status: 409, error: "This charge changed since; nothing was undone." };
  return null;
}

/**
 * ⭐ Undo: restore `previous_category_id`, clear provisional, stamp
 * `undone_at`, disable the memory the decision created. Refuses a locked row
 * for an automatic decision (locked rows never move) and a row whose category
 * changed since. Undoing a person's own decision restores the lock it had
 * before (true when an earlier live hand decision exists).
 */
export async function undoDecision(
  householdId: string,
  decisionId: string,
): Promise<{ status: 200; body: { decisionId: string; transactionId: string; categoryId: string | null } } | { status: 400 | 404 | 409; body: { error: string } }> {
  const d = await openDecision(householdId, decisionId);
  if (!d) return { status: 404, body: { error: "Not found" } };
  if (d.undoneAt) return { status: 409, body: { error: "Already undone." } };
  if (d.source === "locked") return { status: 400, body: { error: "Nothing to undo." } };
  return db.transaction(async (tx) => {
    const [t] = await tx
      .select({
        categoryId: transactionsTable.categoryId,
        locked: transactionsTable.categoryLockedByUser,
        refundOfTxnId: transactionsTable.refundOfTxnId,
      })
      .from(transactionsTable)
      .where(and(eq(transactionsTable.id, d.transactionId), eq(transactionsTable.householdId, householdId)))
      .for("update");
    if (!t) return { status: 404 as const, body: { error: "Not found" } };
    const refused = undoRefusal(d, t);
    if (refused) return { status: refused.status, body: { error: refused.error } };
    const wrote = d.source === "user" || (d.band !== "queue" && d.categoryId != null);
    const set: Record<string, unknown> = { categoryProvisional: false };
    if (wrote) set.categoryId = d.previousCategoryId;
    if (d.source === "user") {
      const [earlier] = await tx
        .select({ id: categoryDecisionsTable.id })
        .from(categoryDecisionsTable)
        .where(
          and(
            eq(categoryDecisionsTable.transactionId, d.transactionId),
            ne(categoryDecisionsTable.id, d.id),
            isNull(categoryDecisionsTable.undoneAt),
            lt(categoryDecisionsTable.createdAt, d.createdAt),
            or(
              eq(categoryDecisionsTable.source, "locked"),
              and(eq(categoryDecisionsTable.source, "user"), sql`${categoryDecisionsTable.categoryId} IS NOT NULL`),
            ),
          ),
        )
        .limit(1);
      set.categoryLockedByUser = !!earlier && d.previousCategoryId != null;
    }
    if (d.source === "refund" && t.refundOfTxnId) set.refundOfTxnId = null;
    await tx
      .update(transactionsTable)
      .set(set)
      .where(and(eq(transactionsTable.id, d.transactionId), eq(transactionsTable.householdId, householdId)));
    await tx
      .update(categoryDecisionsTable)
      .set({ undoneAt: new Date() })
      .where(eq(categoryDecisionsTable.id, d.id));
    if (d.createdMemoryId) {
      await tx
        .update(merchantMemoryTable)
        .set({ disabledAt: new Date() })
        .where(and(eq(merchantMemoryTable.id, d.createdMemoryId), eq(merchantMemoryTable.householdId, householdId)));
    }
    return { status: 200 as const, body: { decisionId: d.id, transactionId: d.transactionId, categoryId: wrote ? d.previousCategoryId : t.categoryId } };
  });
}
