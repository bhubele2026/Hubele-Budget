import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { requireAuth } from "../middlewares/requireAuth";
import {
  upsertTodayHealth,
  getHealthTrend,
  computeDeltas,
} from "../lib/healthSnapshot";
import {
  generateHealthSummary,
  type HealthAdvisorSummary,
} from "../lib/healthAdvisorSummary";

const router: IRouter = Router();

// Mirror the bills/banking insights endpoints: hash the narration-relevant
// inputs and only pay the Anthropic round-trip when they change. Without
// this, the /banking hero card blocked on a live LLM call (up to 12s) on
// every cache-expired mount.
const summaryCache = new Map<
  string,
  { hash: string; summary: HealthAdvisorSummary }
>();

// GET /api/budget-health — the one "how are we doing" read.
// Computes + upserts today's health row (so the daily trend reflects the latest
// numbers even between cron runs), returns the score/status/grade + weighted
// sub-scores + drivers + a 30-day trend series + deltas + the Fable 5 narrative.
router.get("/budget-health", requireAuth, async (req, res): Promise<void> => {
  const householdId = req.householdId!;
  const ownerUserId = req.householdOwnerId ?? req.userId!;
  const forceRefresh =
    req.query.refresh === "true" || req.query.refresh === "1";

  const facts = await upsertTodayHealth(householdId, ownerUserId);
  const trend = await getHealthTrend(householdId, 30);
  const deltas = computeDeltas(facts.score, trend);

  const factsHash = createHash("sha256")
    .update(JSON.stringify({ facts, deltas }))
    .digest("hex");
  const cached = summaryCache.get(householdId);
  const summary =
    !forceRefresh && cached && cached.hash === factsHash
      ? cached.summary
      : await generateHealthSummary(facts, deltas);
  summaryCache.set(householdId, { hash: factsHash, summary });

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
