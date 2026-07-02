// Banking insights captions — GET /banking/insights-summary.
//
// Mirrors the Reports advisor endpoint: build deterministic facts, hash the
// narration-relevant inputs, return the cached captions when the hash is
// unchanged, otherwise regenerate. `?refresh=true` forces a new Anthropic
// call. The cache is in-memory per household (no schema change needed —
// captions are cheap to regenerate and the facts hash keeps them honest).

import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { requireAuth } from "../middlewares/requireAuth";
import {
  buildBankingInsightsFacts,
  generateBankingInsightsSummary,
  type BankingInsightsSummaryRow,
} from "../lib/bankingInsightsSummary";

const router: IRouter = Router();

const cache = new Map<string, { hash: string; summary: BankingInsightsSummaryRow }>();

router.get(
  "/banking/insights-summary",
  requireAuth,
  async (req, res): Promise<void> => {
    const householdId = req.householdId!;
    const forceRefresh =
      req.query.refresh === "true" || req.query.refresh === "1";

    // Deterministic facts — ground truth for every number in the captions.
    const facts = await buildBankingInsightsFacts(householdId);
    const factsHash = createHash("sha256")
      .update(JSON.stringify(facts.hashInput))
      .digest("hex");

    const cached = cache.get(householdId);
    if (!forceRefresh && cached && cached.hash === factsHash) {
      res.json({ ...cached.summary, source: "cache" });
      return;
    }

    const summary = await generateBankingInsightsSummary(facts);
    cache.set(householdId, { hash: factsHash, summary });
    res.json({ ...summary, source: "fresh" });
  },
);

export default router;
