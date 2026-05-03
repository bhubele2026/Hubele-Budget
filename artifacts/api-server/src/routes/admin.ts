import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

const USER_TABLES = [
  "avalanche_settings",
  "budget_categories",
  "budget_lines",
  "budget_months",
  "dashboard_budgets",
  "debt_balance_history",
  "debts",
  "forecast_closed_months",
  "forecast_resolutions",
  "forecast_settings",
  "import_batches",
  "mapping_rules",
  "monthly_snapshots",
  "plaid_accounts",
  "plaid_items",
  "recurring_items",
  "settings",
  "transactions",
] as const;

const CLERK_ID = /^user_[A-Za-z0-9]+$/;

router.post("/admin/remap-user", async (req, res): Promise<void> => {
  const token = req.header("x-admin-token");
  const expected = process.env.ADMIN_REMAP_TOKEN;
  if (!expected || token !== expected) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const { from, to } = (req.body ?? {}) as { from?: string; to?: string };
  if (!from || !to || !CLERK_ID.test(from) || !CLERK_ID.test(to)) {
    res.status(400).json({ error: "from/to must be valid clerk user ids" });
    return;
  }
  if (from === to) {
    res.status(400).json({ error: "from and to are identical" });
    return;
  }

  // Order matters for FKs: child tables before parents.
  const DELETE_ORDER = [
    "debt_balance_history",
    "forecast_resolutions",
    "forecast_closed_months",
    "forecast_settings",
    "dashboard_budgets",
    "budget_lines",
    "budget_months",
    "budget_categories",
    "mapping_rules",
    "transactions",
    "import_batches",
    "monthly_snapshots",
    "recurring_items",
    "debts",
    "plaid_accounts",
    "plaid_items",
    "avalanche_settings",
    "settings",
  ];

  const counts: Record<string, number> = {};
  await db.transaction(async (tx) => {
    // Wipe destination user's auto-seeded data first.
    for (const t of DELETE_ORDER) {
      await tx.execute(sql.raw(`DELETE FROM ${t} WHERE user_id = '${to}'`));
    }
    // Now reassign all source rows to destination.
    for (const t of USER_TABLES) {
      const r = await tx.execute(
        sql.raw(
          `UPDATE ${t} SET user_id = '${to}' WHERE user_id = '${from}'`,
        ),
      );
      counts[t] = (r as unknown as { rowCount?: number }).rowCount ?? 0;
    }
    await tx.execute(sql.raw(`DELETE FROM profiles WHERE id = '${to}'`));
    const p = await tx.execute(
      sql.raw(`UPDATE profiles SET id = '${to}' WHERE id = '${from}'`),
    );
    counts["profiles"] = (p as unknown as { rowCount?: number }).rowCount ?? 0;
  });

  res.json({ ok: true, from, to, counts });
});

export default router;
