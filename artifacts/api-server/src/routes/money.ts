import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  EvaluateAffordBody,
  EvaluateWishlistItemParams,
  UpdateAllowancePlanBody,
  UpdateAllowancePlanParams,
} from "@workspace/api-zod";
import { budgetCategoriesTable, db, householdMembersTable, householdsTable, wishlistItemsTable } from "@workspace/db";
import { AffordInputError, addDaysISO, evaluateAfford } from "@workspace/avalanche-core";
import { requireAuth } from "../middlewares/requireAuth";
import { buildMoneyPosition } from "../lib/moneyPosition";
import {
  loadAllowancePlans,
  suggestWeeklyCap,
  toAllowancePlanView,
} from "../lib/allowancePlans";
import { writeOwnerAllowancePlan } from "../lib/allowancePlanWriter";
import { buildAffordBaseline } from "../lib/afford";
import { evaluateWishlist } from "../jobs/handlers/wishlistEvaluate";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const router: IRouter = Router();

/**
 * ⭐ (PR-B1) THE MONEY POSITION — safe to spend now, until payday and this week.
 * `buildMoneyPosition` does the reading and avalanche-core's `computePosition`
 * does every sum; this handler only serves it. The spine's `position` is the
 * same call (`spineParity.integration.test.ts`). Read-only.
 */
router.get("/money/position", requireAuth, async (req, res): Promise<void> => {
  res.json(await buildMoneyPosition(req.householdId!, req.householdOwnerId!));
});

/**
 * ⭐ (PR-F1) "CAN WE AFFORD THIS?" — one purchase against the money position:
 * the figures before and after, the category it is filed to, the debt plan and
 * a verdict. Stateless and read-only: `buildAffordBaseline` reads the household
 * once and avalanche-core's `evaluateAfford` does every sum. A category or a
 * member from another household is "Not found", never evaluated.
 */
router.post("/money/afford", requireAuth, async (req, res): Promise<void> => {
  // Strict: an unknown key is a mistake, never silently ignored.
  const parsed = EvaluateAffordBody.strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { amount, date, categoryId, member } = parsed.data;
  if (date && addDaysISO(date, 0) !== date) {
    res.status(400).json({ error: "date is not a calendar date" });
    return;
  }
  const hh = req.householdId!;
  if (categoryId !== undefined) {
    const [cat] = UUID_RE.test(categoryId)
      ? await db
          .select({ id: budgetCategoriesTable.id })
          .from(budgetCategoriesTable)
          .where(and(eq(budgetCategoriesTable.id, categoryId), eq(budgetCategoriesTable.householdId, hh)))
      : [];
    if (!cat) {
      res.status(404).json({ error: "Not found" });
      return;
    }
  }
  if (member !== undefined) {
    const [inHousehold] = await db
      .select({ userId: householdMembersTable.userId })
      .from(householdMembersTable)
      .where(and(eq(householdMembersTable.householdId, hh), eq(householdMembersTable.userId, member)));
    const [owns] = inHousehold
      ? [inHousehold]
      : await db
          .select({ userId: householdsTable.ownerUserId })
          .from(householdsTable)
          .where(and(eq(householdsTable.id, hh), eq(householdsTable.ownerUserId, member)));
    if (!owns) {
      res.status(404).json({ error: "Not found" });
      return;
    }
  }
  const baseline = await buildAffordBaseline(hh, req.householdOwnerId!);
  try {
    res.json(evaluateAfford(baseline, { amount, dateISO: date ?? null, categoryId: categoryId ?? null, member: member ?? null }));
  } catch (err) {
    if (err instanceof AffordInputError) {
      res.status(400).json({ error: err.code });
      return;
    }
    throw err;
  }
});

/**
 * (PR-F1) Evaluate one wish-list item now ("as if bought today") and store the
 * answer in its `last_evaluation` — what the nightly `wishlist.evaluate` job
 * does for every pending item. Household-scoped; an item with no amount has
 * nothing to evaluate.
 */
router.post("/wishlist/:id/evaluate", requireAuth, async (req, res): Promise<void> => {
  const params = EvaluateWishlistItemParams.safeParse(req.params);
  if (!params.success || !UUID_RE.test(params.data.id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const hh = req.householdId!;
  const [item] = await db
    .select({ id: wishlistItemsTable.id, amount: wishlistItemsTable.amount })
    .from(wishlistItemsTable)
    .where(and(eq(wishlistItemsTable.id, params.data.id), eq(wishlistItemsTable.householdId, hh)));
  if (!item) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (item.amount === null || !(Number(item.amount) > 0)) {
    res.status(400).json({ error: "The item has no amount to evaluate" });
    return;
  }
  const r = await evaluateWishlist(hh, req.householdOwnerId!, { itemId: item.id, force: true });
  res.json({ itemId: item.id, lastEvaluation: r.results.get(item.id)! });
});

/**
 * (PR-B1) The household's allowance plans, and the suggested weekly cap with
 * its working (`deriveWeeklyLimit`). The suggestion is never written: only the
 * owner sets a cap, below. Read-only.
 */
router.get("/allowance-plans", requireAuth, async (req, res): Promise<void> => {
  const [plans, suggested] = await Promise.all([
    loadAllowancePlans(req.householdId!),
    suggestWeeklyCap(req.householdId!, req.householdOwnerId!),
  ]);
  res.json({
    plans: plans.map(toAllowancePlanView),
    suggested: { weekly: suggested.suggestedWeekly, derivation: suggested.derivation },
  });
});

/**
 * (PR-B1) The owner sets a plan's amount (and, optionally, its start). The
 * household's OWNER only — the signed-in user must be the household's owner,
 * not merely a member of it. Writes `source = 'owner'` through the one writer
 * (`allowancePlanWriter.ts`), which no job or agent may import.
 */
router.put("/allowance-plans/:id", requireAuth, async (req, res): Promise<void> => {
  if (!req.actualUserId || req.actualUserId !== req.householdOwnerId) {
    res.status(403).json({ error: "Only the household owner sets a plan" });
    return;
  }
  const params = UpdateAllowancePlanParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateAllowancePlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { amount, effectiveFrom } = parsed.data;
  // The pattern admits "2026-02-30"; a real calendar date maps to itself.
  if (effectiveFrom && addDaysISO(effectiveFrom, 0) !== effectiveFrom) {
    res.status(400).json({ error: "effectiveFrom is not a calendar date" });
    return;
  }
  // A plan id is a uuid; anything else names no plan.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.data.id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const result = await writeOwnerAllowancePlan(req.householdId!, params.data.id, { amount, effectiveFrom });
  if (!result.ok) {
    if (result.reason === "conflict") {
      res.status(409).json({ error: "Another plan for this member and period already starts on that date" });
    } else {
      res.status(404).json({ error: "Not found" });
    }
    return;
  }
  res.json(toAllowancePlanView(result.plan));
});

export default router;
