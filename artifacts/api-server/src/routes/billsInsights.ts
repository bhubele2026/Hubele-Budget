// Bills insights — GET /bills/insights-summary.
//
// Mirrors the banking insights endpoint: build deterministic bill facts, hash
// the narration-relevant inputs, serve cached Fable 5 captions when the hash is
// unchanged, else regenerate. `?refresh=true` forces a new call. In-memory cache
// per household + month (captions are cheap; the facts hash keeps them honest).

import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { requireAuth } from "../middlewares/requireAuth";
import {
  buildBillsFacts,
  generateBillsInsightsSummary,
  type BillsInsightsSummaryRow,
} from "../lib/billsInsights";

const router: IRouter = Router();

const cache = new Map<string, { hash: string; summary: BillsInsightsSummaryRow }>();

router.get(
  "/bills/insights-summary",
  requireAuth,
  async (req, res): Promise<void> => {
    const householdId = req.householdId!;
    const monthISO =
      typeof req.query.month === "string" ? req.query.month : undefined;
    const forceRefresh =
      req.query.refresh === "true" || req.query.refresh === "1";

    const facts = await buildBillsFacts(householdId, monthISO);
    const factsHash = createHash("sha256")
      .update(JSON.stringify(facts.hashInput))
      .digest("hex");
    const cacheKey = `${householdId}:${monthISO ?? "cur"}`;

    const cached = cache.get(cacheKey);
    if (!forceRefresh && cached && cached.hash === factsHash) {
      res.json({ ...cached.summary, source: "cache" });
      return;
    }

    const summary = await generateBillsInsightsSummary(facts);
    cache.set(cacheKey, { hash: factsHash, summary });
    res.json({ ...summary, source: "fresh" });
  },
);

export default router;
