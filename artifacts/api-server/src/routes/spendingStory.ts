// Spending story — GET /reports/spending-story.
//
// Mirrors forecastInsights.ts: build deterministic spending facts (via
// buildSpendingFacts + buildSpendingStoryFacts), hash the narration-relevant
// inputs, serve cached Fable 5 lens reads when the hash is unchanged, else
// regenerate. `?refresh=true` forces a new call. In-memory cache per household +
// window. Every number is server-computed; the model only writes language.

import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { requireAuth } from "../middlewares/requireAuth";
import { buildSpendingFacts } from "../lib/spendingFacts";
import {
  buildSpendingStoryFacts,
  generateSpendingStory,
  type SpendingStoryRow,
} from "../lib/spendingStory";

const router: IRouter = Router();

const cache = new Map<string, { hash: string; story: SpendingStoryRow }>();

router.get(
  "/reports/spending-story",
  requireAuth,
  async (req, res): Promise<void> => {
    const householdId = req.householdId!;
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const forceRefresh =
      req.query.refresh === "true" || req.query.refresh === "1";

    const facts = await buildSpendingFacts(householdId, from, to);
    const derived = buildSpendingStoryFacts(facts);
    const factsHash = createHash("sha256")
      .update(JSON.stringify(derived.hashInput))
      .digest("hex");

    const cacheKey = `${householdId}:${from ?? ""}:${to ?? ""}`;
    const cached = cache.get(cacheKey);
    if (!forceRefresh && cached && cached.hash === factsHash) {
      res.json({ ...cached.story, source: "cache" });
      return;
    }

    const story = await generateSpendingStory(derived);
    cache.set(cacheKey, { hash: factsHash, story });
    res.json({ ...story, source: "fresh" });
  },
);

export default router;
