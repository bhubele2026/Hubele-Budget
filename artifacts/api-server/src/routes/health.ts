import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { scanOrphanTransactionsByHousehold } from "../lib/startupOrphanTransactionRepair";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// (#796) Operator-facing health probe: how many households still have
// orphaned transactions (a non-null `plaid_account_id` with no surviving
// `plaid_accounts` row) AFTER the startup repair sweep has run. Returns
// per-household counts (no transaction-level PII) plus the totals so
// support can confirm the wipe-repair converged. Live query — always
// reflects current DB state, so it doubles as the post-deploy
// verification surface for the boot-time `runStartupOrphanTransactionRepair`.
router.get("/healthz/orphan-transactions", async (_req, res) => {
  try {
    const { total, households } = await scanOrphanTransactionsByHousehold();
    res.json({
      orphanTransactions: total,
      affectedHouseholds: households.length,
      households,
    });
  } catch (err) {
    res.status(500).json({
      error: "failed to scan orphaned transactions",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
