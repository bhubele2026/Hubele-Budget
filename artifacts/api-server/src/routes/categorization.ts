// (PR-A) Categorization engine v2: run, review queue, corrections, undo, splits.
import { Router, type IRouter } from "express";
import {
  AcceptCategorizationDecisionParams,
  CorrectCategorizationDecisionBody,
  CorrectCategorizationDecisionParams,
  DeleteTransactionSplitsParams,
  GetTransactionSplitsParams,
  ListCategoryDecisionsQueryParams,
  ListCategorizationReviewQueryParams,
  ReplaceTransactionSplitsBody,
  ReplaceTransactionSplitsParams,
  RunCategorizationBody,
  SkipCategorizationDecisionParams,
  UndoCategoryDecisionParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { isAiEnabled } from "../ai/client";
import { enqueueCategorize, enqueueCategorizeChunks, openQueueTxnIds } from "../jobs/handlers/categorize";
import { runCategorizationBacklog, runCategorizationBatch } from "../lib/categorizer";
import {
  backlogOf,
  listReviewQueue,
  resolveDecision,
  settleSilentAcceptances,
  undoDecision,
  unreviewedCount,
} from "../lib/categorizer/review";
import { listDecisionHistory } from "../lib/categorizer/userDecisions";
import { deleteSplits, getSplits, replaceSplits } from "../lib/categorizer/splits";

const router: IRouter = Router();

router.post("/categorization/run", requireAuth, async (req, res): Promise<void> => {
  // Owner only: the signed-in user must be the household's owner.
  if (!req.householdOwnerId || (req.actualUserId ?? req.userId) !== req.householdOwnerId) {
    res.status(403).json({ error: "Forbidden: owner only" });
    return;
  }
  const parsed = RunCategorizationBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const householdId = req.householdId!;
  // (V7) `scope: "all"` files the whole backlog: every row from the household's
  // oldest, in bounded slices (runCategorizationBacklog). `since` is ignored then.
  const all = parsed.data.scope === "all";
  const since = parsed.data.since
    ? typeof parsed.data.since === "string"
      ? parsed.data.since
      : (parsed.data.since as Date).toISOString().slice(0, 10)
    : undefined;
  // Settle first (as the job does), so `unreviewed` below is current.
  await settleSilentAcceptances(householdId);
  const out = all
    ? await runCategorizationBacklog(householdId)
    : await runCategorizationBatch(householdId, { since, trigger: "manual" });
  // (AI-1) The model pass runs as a job over everything unresolved: the rows
  // no deterministic stage could decide, plus the open review-queue rows.
  // (V7) The backlog run hands over every such id, in jobs of MAX_JOB_IDS.
  let modelQueued = 0;
  if (isAiEnabled()) {
    const ids = [...new Set([...out.ambiguous, ...(await openQueueTxnIds(householdId, all ? null : undefined))])];
    if (ids.length > 0) {
      if (all) {
        modelQueued = await enqueueCategorizeChunks(householdId, req.householdOwnerId!, ids, "user");
      } else {
        await enqueueCategorize(householdId, req.householdOwnerId!, ids, "user");
        modelQueued = ids.length;
      }
    }
  }
  const live = out.decisions.filter((d) => d.source !== "locked");
  res.json({
    decided: live.filter((d) => d.band !== "queue" && d.categoryId).length,
    // (V7) Only the decisions that need a person (band queue, no category written).
    queued: live.filter((d) => d.band === "queue").length,
    ambiguous: out.ambiguous.length,
    modelQueued,
    filed: live.filter((d) => d.band === "auto" && d.categoryId).length,
    suggested: live.filter((d) => d.band === "provisional" && d.categoryId).length,
    unreviewed: await unreviewedCount(householdId),
    remaining: (await backlogOf(householdId)).unfiled,
  });
});

router.get("/categorization/review", requireAuth, async (req, res): Promise<void> => {
  const parsed = ListCategorizationReviewQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  res.json(await listReviewQueue(req.householdId!, parsed.data.limit ?? 20));
});

router.post(
  "/categorization/review/:decisionId/accept",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = AcceptCategorizationDecisionParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const out = await resolveDecision(req.householdId!, req.userId!, params.data.decisionId, "accept");
    res.status(out.status).json(out.body);
  },
);

router.post(
  "/categorization/review/:decisionId/skip",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = SkipCategorizationDecisionParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const out = await resolveDecision(req.householdId!, req.userId!, params.data.decisionId, "skip");
    res.status(out.status).json(out.body);
  },
);

router.post(
  "/categorization/review/:decisionId/correct",
  requireAuth,
  async (req, res): Promise<void> => {
    const params = CorrectCategorizationDecisionParams.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const body = CorrectCategorizationDecisionBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const out = await resolveDecision(
      req.householdId!,
      req.userId!,
      params.data.decisionId,
      "correct",
      body.data.categoryId,
    );
    res.status(out.status).json(out.body);
  },
);

// (PR-A2) How one charge was filed: its decisions, newest first, at most 20.
router.get("/category-decisions", requireAuth, async (req, res): Promise<void> => {
  const q = ListCategoryDecisionsQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }
  const out = await listDecisionHistory(req.householdId!, q.data.transactionId);
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

router.post("/category-decisions/:id/undo", requireAuth, async (req, res): Promise<void> => {
  const params = UndoCategoryDecisionParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const out = await undoDecision(req.householdId!, params.data.id);
  res.status(out.status).json(out.body);
});

router.get("/transactions/:id/splits", requireAuth, async (req, res): Promise<void> => {
  const params = GetTransactionSplitsParams.safeParse(req.params);
  const out = params.success ? await getSplits(req.householdId!, params.data.id) : null;
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

router.post("/transactions/:id/splits", requireAuth, async (req, res): Promise<void> => {
  const params = ReplaceTransactionSplitsParams.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const body = ReplaceTransactionSplitsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const out = await replaceSplits(req.householdId!, req.userId!, params.data.id, body.data.splits);
  res.status(out.status).json(out.body);
});

router.delete("/transactions/:id/splits", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteTransactionSplitsParams.safeParse(req.params);
  if (!params.success || !(await deleteSplits(req.householdId!, req.userId!, params.data.id))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).end();
});

export default router;
