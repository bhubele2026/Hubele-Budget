import type { Job } from "pg-boss";
import { and, eq, inArray } from "drizzle-orm";
import { db, householdsTable, wishlistItemsTable, type WishlistItem } from "@workspace/db";
import { evaluateAfford, householdDateOf, type AffordVerdict } from "@workspace/avalanche-core";
import { buildAffordBaseline } from "../../lib/afford";
import { householdTodayISO } from "../../lib/householdClock";
import { logger } from "../../lib/logger";
import { emit } from "../emit";
import { QUEUES } from "../queues";

// (PR-F1) The wish list, re-read every night: queue `wishlist.evaluate`.
//
//   { householdId, ownerUserId }  one household: every PENDING item with an
//                                 amount is evaluated as if bought today
//                                 ("Can we afford this?", `evaluateAfford`) and
//                                 the answer stored in `last_evaluation`.
//   { fanout: true }              the daily 03:45 America/Chicago tick: one job
//                                 per household with a pending item.
//
// Idempotent per household day: an item already evaluated today is skipped,
// so a retry (or a second tick) writes nothing new. `POST /wishlist/:id/evaluate`
// runs one item now, whatever its last evaluation.
//
// The baseline is read ONCE per household and every item is evaluated against
// it — each answer is "this item alone", never items stacked on one another.
// Nothing here moves money: the only write is the evaluation itself.

export const WISHLIST_EVALUATE_CRON = "45 3 * * *";
export const WISHLIST_EVALUATE_TZ = "America/Chicago";

/** What `last_evaluation` holds. Money is `toFixed(2)`. */
export interface WishlistEvaluation {
  evaluatedAt: string;
  verdict: AffordVerdict;
  safeToSpendNowAfter: string | null;
  availableUntilPaydayAfter: string | null;
}

export interface WishlistEvaluateJobData {
  householdId?: string;
  ownerUserId?: string;
  fanout?: boolean;
}

/** The household day an evaluation was made on, or null for anything unreadable. */
function evaluatedOn(v: unknown): string | null {
  const at = (v as { evaluatedAt?: unknown } | null)?.evaluatedAt;
  if (typeof at !== "string") return null;
  const d = new Date(at);
  return Number.isFinite(d.getTime()) ? householdDateOf(d) : null;
}

const evaluable = (w: WishlistItem): boolean => w.amount !== null && Number(w.amount) > 0;

/**
 * Evaluate a household's wish list (or one item of it) and store each answer.
 * `itemId` + `force` is the "evaluate now" route; the job passes neither.
 */
export async function evaluateWishlist(
  householdId: string,
  ownerUserId: string,
  opts: { itemId?: string; force?: boolean; now?: Date } = {},
): Promise<{ evaluated: number; skipped: number; results: Map<string, WishlistEvaluation> }> {
  const now = opts.now ?? new Date();
  const today = householdTodayISO(now);
  const rows = await db
    .select()
    .from(wishlistItemsTable)
    .where(
      opts.itemId
        ? and(eq(wishlistItemsTable.householdId, householdId), eq(wishlistItemsTable.id, opts.itemId))
        : and(eq(wishlistItemsTable.householdId, householdId), eq(wishlistItemsTable.decision, "pending")),
    );
  const due = rows.filter((w) => evaluable(w) && (opts.force || evaluatedOn(w.lastEvaluation) !== today));
  const results = new Map<string, WishlistEvaluation>();
  if (due.length === 0) return { evaluated: 0, skipped: rows.length, results };

  const baseline = await buildAffordBaseline(householdId, ownerUserId);
  for (const w of due) {
    const r = evaluateAfford(baseline, { amount: Number(w.amount), dateISO: null, categoryId: w.categoryId });
    const evaluation: WishlistEvaluation = {
      evaluatedAt: now.toISOString(),
      verdict: r.verdict,
      safeToSpendNowAfter: r.proposed.safeToSpendNow,
      availableUntilPaydayAfter: r.proposed.availableUntilPayday,
    };
    await db
      .update(wishlistItemsTable)
      .set({ lastEvaluation: evaluation })
      .where(and(eq(wishlistItemsTable.id, w.id), eq(wishlistItemsTable.householdId, householdId)));
    results.set(w.id, evaluation);
  }
  return { evaluated: due.length, skipped: rows.length - due.length, results };
}

/** Households with at least one pending wish, with their owners. */
export async function householdsWithPendingWishes(): Promise<Array<{ householdId: string; ownerUserId: string }>> {
  const pending = await db
    .selectDistinct({ householdId: wishlistItemsTable.householdId })
    .from(wishlistItemsTable)
    .where(eq(wishlistItemsTable.decision, "pending"));
  if (pending.length === 0) return [];
  return db
    .select({ householdId: householdsTable.id, ownerUserId: householdsTable.ownerUserId })
    .from(householdsTable)
    .where(inArray(householdsTable.id, pending.map((p) => p.householdId)));
}

export function wishlistEvaluateSendOptions(householdId: string) {
  return { singletonKey: `wish:${householdId}`, singletonSeconds: 600 } as const;
}

export async function handleWishlistEvaluateJobs(
  jobs: Job<WishlistEvaluateJobData>[],
): Promise<{ households: number; evaluated: number; fannedOut: number }> {
  let households = 0;
  let evaluated = 0;
  let fannedOut = 0;
  for (const job of jobs) {
    const data = job.data ?? {};
    if (data.fanout) {
      for (const h of await householdsWithPendingWishes()) {
        await emit(QUEUES.wishlistEvaluate, { householdId: h.householdId, ownerUserId: h.ownerUserId }, wishlistEvaluateSendOptions(h.householdId));
        fannedOut++;
      }
      continue;
    }
    if (!data.householdId || !data.ownerUserId) {
      logger.warn({ jobId: job.id }, "wishlist.evaluate job without a household; dropped");
      continue;
    }
    const r = await evaluateWishlist(data.householdId, data.ownerUserId);
    households++;
    evaluated += r.evaluated;
  }
  return { households, evaluated, fannedOut };
}
