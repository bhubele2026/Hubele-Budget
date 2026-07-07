import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import {
  upsertTodayHealth,
  getHealthTrend,
  computeDeltas,
} from "../lib/healthSnapshot";
import { generateHealthSummary } from "../lib/healthAdvisorSummary";

const router: IRouter = Router();

// GET /api/budget-health — the one "how are we doing" read.
// Computes + upserts today's health row (so the daily trend reflects the latest
// numbers even between cron runs), returns the score/status/grade + weighted
// sub-scores + drivers + a 30-day trend series + deltas + the Fable 5 narrative.
router.get("/budget-health", requireAuth, async (req, res): Promise<void> => {
  const householdId = req.householdId!;
  const ownerUserId = req.householdOwnerId ?? req.userId!;

  const facts = await upsertTodayHealth(householdId, ownerUserId);
  const trend = await getHealthTrend(householdId, 30);
  const deltas = computeDeltas(facts.score, trend);
  const summary = await generateHealthSummary(facts, deltas);

  res.json({
    score: facts.score,
    status: facts.status,
    grade: facts.grade,
    dimensions: facts.dimensions,
    drivers: facts.drivers,
    facts: facts.facts,
    trend,
    deltas,
    summary,
  });
});

export default router;
