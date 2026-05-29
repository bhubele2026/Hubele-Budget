import { Router, type IRouter } from "express";
import { HealthCheckResponse, GetVersionResponse } from "@workspace/api-zod";
import { APP_VERSION } from "../lib/version";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
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
