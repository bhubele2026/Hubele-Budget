// Forecast insights — GET /forecast/insights-summary.
//
// Mirrors the banking/bills insights endpoints: build deterministic cash-flow
// facts (via computeCashSignal), hash the narration-relevant inputs, serve
// cached Fable 5 captions when the hash is unchanged, else regenerate.
// `?refresh=true` forces a new call. In-memory cache per household.

import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { requireAuth } from "../middlewares/requireAuth";
import {
  buildForecastFacts,
  generateForecastInsightsSummary,
  type ForecastInsightsSummaryRow,
} from "../lib/forecastInsights";

const router: IRouter = Router();

const cache = new Map<string, { hash: string; summary: ForecastInsightsSummaryRow }>();

router.get(
  "/forecast/insights-summary",
  requireAuth,
  async (req, res): Promise<void> => {
    const householdId = req.householdId!;
    const forceRefresh =
      req.query.refresh === "true" || req.query.refresh === "1";

    const facts = await buildForecastFacts(householdId, req.householdOwnerId!);
    const factsHash = createHash("sha256")
      .update(JSON.stringify(facts.hashInput))
      .digest("hex");

    const cached = cache.get(householdId);
    if (!forceRefresh && cached && cached.hash === factsHash) {
      res.json({ ...cached.summary, source: "cache" });
      return;
    }

    const summary = await generateForecastInsightsSummary(facts);
    cache.set(householdId, { hash: factsHash, summary });
    res.json({ ...summary, source: "fresh" });
  },
);

export default router;
