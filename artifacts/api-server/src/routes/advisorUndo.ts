import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import { undoToolCall } from "../lib/advisorTools";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.post("/advisor/undo/:auditLogId", requireAuth, async (req, res): Promise<void> => {
  const { auditLogId } = req.params;
  if (!auditLogId || typeof auditLogId !== "string") {
    res.status(400).json({ error: "auditLogId required" });
    return;
  }
  const householdId = req.householdId!;
  const householdOwnerId = req.householdOwnerId!;
  const actorUserId = req.userId!;
  try {
    const result = await undoToolCall(auditLogId, {
      householdId,
      householdOwnerId,
      actorUserId,
    });
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, auditLogId, householdId }, "advisor: undo failed");
    res.status(500).json({ error: "Undo failed" });
  }
});

export default router;
