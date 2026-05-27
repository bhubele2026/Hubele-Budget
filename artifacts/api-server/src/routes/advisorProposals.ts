import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import { confirmProposal, cancelProposal } from "../lib/advisorTools";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.post("/advisor/proposals/:proposalId/confirm", requireAuth, async (req, res): Promise<void> => {
  const { proposalId } = req.params;
  if (typeof proposalId !== "string" || !proposalId) {
    res.status(400).json({ error: "proposalId required" });
    return;
  }
  const ctx = {
    householdId: req.householdId!,
    householdOwnerId: req.householdOwnerId!,
    actorUserId: req.userId!,
  };
  try {
    const result = await confirmProposal(proposalId, ctx);
    if (!result.ok) {
      res.status(400).json({ error: result.error ?? "Confirmation failed" });
      return;
    }
    res.json({
      ok: true,
      toolName: result.toolName,
      summary: typeof result.result === "object" ? null : String(result.result),
      auditLogId: result.auditLogId,
    });
  } catch (err) {
    logger.error({ err, proposalId }, "advisor: confirm failed");
    res.status(500).json({ error: "Confirmation failed" });
  }
});

router.post("/advisor/proposals/:proposalId/cancel", requireAuth, async (req, res): Promise<void> => {
  const { proposalId } = req.params;
  if (typeof proposalId !== "string" || !proposalId) {
    res.status(400).json({ error: "proposalId required" });
    return;
  }
  const ctx = {
    householdId: req.householdId!,
    householdOwnerId: req.householdOwnerId!,
    actorUserId: req.userId!,
  };
  try {
    const result = await cancelProposal(proposalId, ctx);
    if (!result.ok) {
      res.status(400).json({ error: result.error ?? "Cancel failed" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, proposalId }, "advisor: cancel failed");
    res.status(500).json({ error: "Cancel failed" });
  }
});

export default router;
