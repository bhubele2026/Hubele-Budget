import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import {
  buildHouseholdContext,
  chat,
  generateNudge,
  getCachedNudge,
  setCachedNudge,
  isAdvisorEnabled,
  MAX_MESSAGE_CHARS,
  type ChatHistoryEntry,
} from "../lib/advisor";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// GET /api/advisor/nudge — cached (1h TTL) AI observation for the dashboard
router.get("/advisor/nudge", requireAuth, async (req, res): Promise<void> => {
  logger.info({
    hasKey: !!process.env.ANTHROPIC_API_KEY,
    keyLen: process.env.ANTHROPIC_API_KEY?.length ?? 0,
    advisorEnabledFlag: process.env.ADVISOR_ENABLED ?? "(unset)",
  }, "advisor: env check");
  if (!isAdvisorEnabled()) {
    res.json({ enabled: false });
    return;
  }
  const householdId = req.householdId!;
  const householdOwnerId = req.householdOwnerId!;

  const cached = getCachedNudge(householdId);
  if (cached) {
    res.json({
      enabled: true,
      severity: cached.result.severity,
      message: cached.result.message,
      source: cached.result.source,
      generatedAt: new Date(cached.generatedAt).toISOString(),
    });
    return;
  }

  try {
    const ctx = await buildHouseholdContext(householdId, householdOwnerId);
    const result = await generateNudge(ctx);
    const entry = setCachedNudge(householdId, result);
    res.json({
      enabled: true,
      severity: result.severity,
      message: result.message,
      source: result.source,
      generatedAt: new Date(entry.generatedAt).toISOString(),
    });
  } catch (err) {
    logger.warn({ err, householdId }, "advisor: nudge generation failed");
    res.json({ enabled: true, severity: "info", message: "", source: "empty" });
  }
});

// POST /api/advisor/chat — stateless chat, client passes history each turn
router.post("/advisor/chat", requireAuth, async (req, res): Promise<void> => {
  if (!isAdvisorEnabled()) {
    res.status(503).json({ error: "Advisor not configured on this server" });
    return;
  }

  const body = req.body;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    res.status(400).json({ error: `message exceeds ${MAX_MESSAGE_CHARS} characters` });
    return;
  }

  const history: ChatHistoryEntry[] = [];
  if (Array.isArray(body.history)) {
    for (const m of body.history) {
      if (!m || typeof m !== "object") continue;
      const role = m.role;
      const content = typeof m.content === "string" ? m.content : "";
      if ((role === "user" || role === "assistant") && content) {
        history.push({ role, content });
      }
    }
  }

  const householdId = req.householdId!;
  const householdOwnerId = req.householdOwnerId!;

  try {
    const ctx = await buildHouseholdContext(householdId, householdOwnerId);
    const result = await chat(ctx, history, message);
    res.json({
      message: result.message,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      },
    });
  } catch (err) {
    logger.error({ err, householdId }, "advisor: chat failed");
    res.status(502).json({ error: "Advisor request failed" });
  }
});

export default router;
