import { Router, type IRouter } from "express";
import { HealthCheckResponse, GetVersionResponse } from "@workspace/api-zod";
import { APP_VERSION } from "../lib/version";
import { getJobsHealth } from "../jobs/boss";
import { getAiStatus } from "../ai/client";
import { getSmsConfig } from "../lib/sms";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// (AI-0) Render's health check. It answers 200 whenever the process serves:
// job, AI and SMS state are reported (booleans and counts, never secrets)
// but never fail the check — a stuck queue must not get the web service
// restarted. The job counts are cached 30 s and bounded to ~2 s.
router.get("/healthz", async (_req, res) => {
  let jobs: Awaited<ReturnType<typeof getJobsHealth>>;
  try {
    jobs = await getJobsHealth();
  } catch (err) {
    logger.warn({ err }, "healthz: jobs state unavailable");
    jobs = { mode: "off", started: false, failedLast24h: null, dlq: null };
  }
  const data = HealthCheckResponse.parse({
    status: "ok",
    version: APP_VERSION,
    jobs,
    ai: getAiStatus(),
    sms: getSmsConfig(),
    plaid: { webhookUrlSet: Boolean(process.env.PLAID_WEBHOOK_URL?.trim()) },
  });
  res.json(data);
});

// (#823) Per-deploy build identifier. The web bundle bakes the same
// value at build time; a client poller compares the two and prompts the
// user to reload when they differ so they stop having to hard-refresh
// after a deploy to pick up the new bundle. No auth — GET only.
router.get("/version", (_req, res) => {
  const data = GetVersionResponse.parse({ version: APP_VERSION });
  res.json(data);
});

export default router;
