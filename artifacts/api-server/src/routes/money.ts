import { Router, type IRouter } from "express";
import { UpdateAllowancePlanBody, UpdateAllowancePlanParams } from "@workspace/api-zod";
import { addDaysISO } from "@workspace/avalanche-core";
import { requireAuth } from "../middlewares/requireAuth";
import { buildMoneyPosition } from "../lib/moneyPosition";
import {
  loadAllowancePlans,
  suggestWeeklyCap,
  toAllowancePlanView,
} from "../lib/allowancePlans";
import { writeOwnerAllowancePlan } from "../lib/allowancePlanWriter";

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
