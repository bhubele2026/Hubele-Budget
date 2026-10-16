import { Router, type IRouter, type RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import {
  CreateAllowancePlanBody,
  CreateWeekAdjustmentBody,
  DeleteWeekAdjustmentParams,
  EvaluateAffordBody,
  EvaluateWishlistItemParams,
  GetPeriodBreakdownQueryParams,
  UpdateAllowancePlanBody,
  UpdateAllowancePlanParams,
} from "@workspace/api-zod";
import { budgetCategoriesTable, db, householdMembersTable, householdsTable, wishlistItemsTable } from "@workspace/db";
import { AffordInputError, addDaysISO, dayOfWeekISO, evaluateAfford, weekBounds } from "@workspace/avalanche-core";
import { requireAuth } from "../middlewares/requireAuth";
import { requireHouseholdOwner } from "../middlewares/requireHouseholdOwner";
import { buildMoneyPosition } from "../lib/moneyPosition";
import {
  loadAllowancePlans,
  planPrefills,
  plansInEffect,
  suggestWeeklyCap,
  toAllowancePlanView,
} from "../lib/allowancePlans";
import {
  createOwnerAllowancePlan,
  planStartProblem,
  writeOwnerAllowancePlan,
  type AllowancePlanWriteResult,
} from "../lib/allowancePlanWriter";
import { planUnsafeBody, planWriteGate } from "../lib/planSafety";
import { planDryRun } from "../lib/planDryRun";
import { buildAffordBaseline } from "../lib/afford";
import { evaluateWishlist } from "../jobs/handlers/wishlistEvaluate";
import { buildWaysBack, deleteCarryOver, upsertCarryOver, WeekAdjustmentError } from "../lib/weekAdjustments";
import { householdTodayISO } from "../lib/householdClock";
import { buildPeriodBreakdown, PeriodBreakdownError } from "../lib/periodBreakdown";

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

/** A real calendar date (the pattern admits "2026-02-30"). */
const isCalendarDate = (iso: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(iso) && addDaysISO(iso, 0) === iso;

/**
 * ⭐ (V5) A WAY BACK WHEN THE WEEK IS OVER — how far over the week is, what is
 * left per day, the categories to trim against their usual week, and next week
 * with the overage carried. Code only (`buildWaysBack` → avalanche-core's
 * `computeWaysBack`); every amount is whole cents. Read-only.
 */
router.get("/money/ways-back", requireAuth, async (req, res): Promise<void> => {
  res.json(await buildWaysBack(req.householdId!, req.householdOwnerId!));
});

/**
 * ⭐ (S3) "WHY ARE WE OVER?" — one week's or month's allowance: the plan, what
 * counts against it, left or over, and the rows behind it by category, largest
 * first. `buildPeriodBreakdown` reads (for the current week, the money
 * position's own read) and avalanche-core's `periodBreakdown` does every sum.
 * Household-scoped; an account of another household is "Not found". Read-only.
 */
router.get("/money/period-breakdown", requireAuth, async (req, res): Promise<void> => {
  // `zod.coerce.number()` would also take "1e1" or "0x10": rowsPerGroup is plain digits.
  const rawRows = (req.query as Record<string, unknown>).rowsPerGroup;
  if (rawRows !== undefined && !(typeof rawRows === "string" && /^[0-9]{1,3}$/.test(rawRows))) {
    res.status(400).json({ error: "invalid_rows_per_group" });
    return;
  }
  const q = GetPeriodBreakdownQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }
  const { period, start, account, rowsPerGroup } = q.data;
  if (!isCalendarDate(start)) {
    res.status(400).json({ error: "start is not a calendar date" });
    return;
  }
  try {
    res.json(
      await buildPeriodBreakdown(req.householdId!, req.householdOwnerId!, {
        period,
        start,
        account: account === undefined || account === "" ? undefined : account,
        rowsPerGroup,
      }),
    );
  } catch (err) {
    if (err instanceof PeriodBreakdownError) {
      res.status(err.status).json({ error: err.code });
      return;
    }
    throw err;
  }
});

/**
 * (V5) The owner chooses to start a week lower (a carry-over): upsert on
 * (household, week, kind). The amount is whole cents and must be negative —
 * zero or more is 400 — and the week must be a Sunday, this week or later.
 * Written through the one writer (`weekAdjustments.ts`).
 */
router.post("/money/week-adjustments", requireAuth, requireHouseholdOwner, async (req, res): Promise<void> => {
  // Strict: an unknown key is a mistake, never silently ignored.
  const parsed = CreateWeekAdjustmentBody.strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { weekStart, amountCents, reason } = parsed.data;
  if (!isCalendarDate(weekStart) || dayOfWeekISO(weekStart) !== 0) {
    res.status(400).json({ error: "weekStart is not a Sunday" });
    return;
  }
  if (weekStart < weekBounds(householdTodayISO()).start) {
    res.status(400).json({ error: "weekStart is a past week" });
    return;
  }
  try {
    const view = await upsertCarryOver(req.householdId!, {
      weekStart,
      amountCents,
      reason: reason?.trim() ? reason.trim() : null,
      createdBy: req.actualUserId ?? null,
    });
    res.json(view);
  } catch (err) {
    if (err instanceof WeekAdjustmentError) {
      res.status(400).json({ error: err.code });
      return;
    }
    throw err;
  }
});

/** (V5) The owner removes a week's carry-over. 204 when removed, 404 when there was none. */
router.delete(
  "/money/week-adjustments/:weekStart",
  requireAuth,
  requireHouseholdOwner,
  async (req, res): Promise<void> => {
    const params = DeleteWeekAdjustmentParams.safeParse(req.params);
    if (!params.success || !isCalendarDate(params.data.weekStart)) {
      res.status(400).json({ error: "weekStart is not a calendar date" });
      return;
    }
    if (!(await deleteCarryOver(req.householdId!, params.data.weekStart))) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).end();
  },
);

/** (S2) The plan rows in effect now (this week's, this month's), as the API serves them. */
function inEffectView(plans: Parameters<typeof plansInEffect>[0], todayISO: string) {
  const now = plansInEffect(plans, todayISO);
  return {
    weekly: now.weekly ? toAllowancePlanView(now.weekly) : null,
    monthly: now.monthly ? toAllowancePlanView(now.monthly) : null,
  };
}

/** (S2) A refused write, in the API's words. */
const PLAN_WRITE_REFUSAL: Record<Exclude<AllowancePlanWriteResult, { ok: true }>["reason"], { status: number; error: string }> = {
  not_found: { status: 404, error: "Not found" },
  conflict: { status: 409, error: "Another plan for this member and period already starts on that date" },
  amount_not_positive: { status: 400, error: "amount must be more than 0" },
  start_not_a_sunday: { status: 400, error: "effectiveFrom is not a Sunday" },
  start_not_first_of_month: { status: 400, error: "effectiveFrom is not the 1st of a month" },
  start_in_past: { status: 400, error: "effectiveFrom is in a past week or month" },
};

/** (S2) Answer a plan write: the row written, `created`, and the plans in effect after it. */
async function sendPlanWrite(res: Parameters<RequestHandler>[1], householdId: string, todayISO: string, result: AllowancePlanWriteResult) {
  if (!result.ok) {
    const refusal = PLAN_WRITE_REFUSAL[result.reason];
    res.status(refusal.status).json({ error: refusal.error });
    return;
  }
  res.json({
    ...toAllowancePlanView(result.plan),
    created: result.created,
    inEffect: inEffectView(await loadAllowancePlans(householdId), todayISO),
  });
}

/**
 * (PR-B1) The household's allowance plans, and the suggested weekly cap with
 * its working (`deriveWeeklyLimit`). The suggestion is never written: only the
 * owner sets a cap, below. (S2) Also the plan row in effect this week and this
 * month (`plansInEffect`: a $0 row is no plan), and the amounts a plan may start
 * from (`planPrefills` — options only). Read-only.
 */
router.get("/allowance-plans", requireAuth, async (req, res): Promise<void> => {
  const todayISO = householdTodayISO();
  const [plans, suggested] = await Promise.all([
    loadAllowancePlans(req.householdId!),
    suggestWeeklyCap(req.householdId!, req.householdOwnerId!),
  ]);
  res.json({
    plans: plans.map(toAllowancePlanView),
    suggested: { weekly: suggested.suggestedWeekly, derivation: suggested.derivation },
    inEffect: inEffectView(plans, todayISO),
    prefills: await planPrefills(req.householdId!, req.householdOwnerId!, suggested.suggestedWeekly),
  });
});

/**
 * ⭐ (S2) The owner sets the household's weekly or monthly plan from this period
 * on — the confirmed "Use $450 as the weekly plan from this week". The
 * household's OWNER only. A weekly plan starts on a Sunday, a monthly one on the
 * 1st, this period or later; the amount is more than $0. Written through the one
 * writer (`createOwnerAllowancePlan`), which no job or agent may import. Past
 * weeks keep their own rows.
 */
router.post("/allowance-plans", requireAuth, async (req, res): Promise<void> => {
  if (!req.actualUserId || req.actualUserId !== req.householdOwnerId) {
    res.status(403).json({ error: "Only the household owner sets a plan" });
    return;
  }
  // Strict: an unknown key is a mistake, never silently ignored.
  const parsed = CreateAllowancePlanBody.strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { period, amount, effectiveFrom } = parsed.data;
  if (!isCalendarDate(effectiveFrom)) {
    res.status(400).json({ error: "effectiveFrom is not a calendar date" });
    return;
  }
  const todayISO = householdTodayISO();
  // (F1) The request's own mistakes answer first (400), then the gate (409).
  const problem = !(Number(amount) > 0) ? "amount_not_positive" : planStartProblem(period, effectiveFrom, todayISO);
  if (problem) {
    const refusal = PLAN_WRITE_REFUSAL[problem];
    res.status(refusal.status).json({ error: refusal.error });
    return;
  }
  // ⭐ (F1) `?dryRun=1`: the same body, nothing written — each hook occurrence the
  // plan governs before → after (with its split), the low point before → after,
  // and the gate's answer (a refused plan still shows its effect).
  const dryRun = req.query.dryRun;
  if (dryRun === "1" || dryRun === "true") {
    res.json(await planDryRun(req.householdId!, req.householdOwnerId!, { period, amount, effectiveFrom }));
    return;
  }
  // ⭐ (F1) No plan while the forecast cannot size the card payments it moves.
  const gate = await planWriteGate(req.householdId!, req.householdOwnerId!);
  if (!gate.ok) {
    res.status(409).json(planUnsafeBody(gate));
    return;
  }
  await sendPlanWrite(res, req.householdId!, todayISO, await createOwnerAllowancePlan(req.householdId!, { period, amount, effectiveFrom }, todayISO));
});

/**
 * (PR-B1) The owner sets a plan's amount (and, optionally, its start). The
 * household's OWNER only — the signed-in user must be the household's owner,
 * not merely a member of it. Writes `source = 'owner'` through the one writer
 * (`allowancePlanWriter.ts`), which no job or agent may import.
 * ⭐ (S2) A row a past week was judged against is never rewritten: the edit
 * becomes a new row from this week (or month) on (`created: true`).
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
  const todayISO = householdTodayISO();
  // ⭐ (F1) No plan while the forecast cannot size the card payments it moves.
  const gate = await planWriteGate(req.householdId!, req.householdOwnerId!);
  if (!gate.ok) {
    res.status(409).json(planUnsafeBody(gate));
    return;
  }
  await sendPlanWrite(
    res,
    req.householdId!,
    todayISO,
    await writeOwnerAllowancePlan(req.householdId!, params.data.id, { amount, effectiveFrom }, todayISO),
  );
});

export default router;
