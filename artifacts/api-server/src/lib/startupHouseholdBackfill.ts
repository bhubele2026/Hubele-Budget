import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

/**
 * (#623 follow-up) One-shot startup pass: run the shared-household
 * backfill against whatever database the api-server boots against.
 *
 * Why this exists: the schema for the household refactor is applied
 * automatically by Replit's Publish flow (it diffs dev → prod and
 * applies the SQL), but the Publish flow does NOT run our data
 * backfill (`scripts/backfill_households.sql`). After the first deploy
 * the production schema had `transactions.household_id` etc. but
 * every existing row was NULL, so the new household-scoped routes
 * filtered to zero rows for the owner and any invited spouse.
 *
 * This helper executes the same SQL as `scripts/backfill_households.sql`
 * inline at boot, wrapped in a single transaction to match the
 * script's BEGIN/COMMIT atomicity (a mid-run failure rolls everything
 * back instead of leaving the DB partially backfilled). Every
 * statement is gated on `IS NULL` / `ON CONFLICT DO NOTHING`, so
 * re-running on subsequent boots — or on a database that's already
 * converged — is a no-op.
 */
export async function runStartupHouseholdBackfill(): Promise<{
  ran: boolean;
  reason?: string;
  updated?: Record<string, number>;
}> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO households (owner_user_id)
        SELECT DISTINCT user_id
        FROM (
          SELECT id AS user_id FROM profiles
          UNION SELECT user_id FROM debts
          UNION SELECT user_id FROM debt_balance_history
          UNION SELECT user_id FROM avalanche_settings
          UNION SELECT user_id FROM budget_categories
          UNION SELECT user_id FROM budget_months
          UNION SELECT user_id FROM budget_lines
          UNION SELECT user_id FROM recurring_items
          UNION SELECT user_id FROM transactions
          UNION SELECT user_id FROM plaid_items
          UNION SELECT user_id FROM plaid_accounts
          UNION SELECT user_id FROM plaid_sync_attempts
          UNION SELECT user_id FROM plaid_consent_reminders_sent
          UNION SELECT user_id FROM mapping_rules
          UNION SELECT user_id FROM monthly_snapshots
          UNION SELECT user_id FROM settings
          UNION SELECT user_id FROM import_batches
          UNION SELECT user_id FROM forecast_resolutions
          UNION SELECT user_id FROM forecast_closed_months
          UNION SELECT user_id FROM forecast_settings
          UNION SELECT user_id FROM dashboard_budgets
        ) AS u
        WHERE user_id IS NOT NULL AND user_id <> ''
        ON CONFLICT (owner_user_id) DO NOTHING;
      `);

      await tx.execute(sql`
        INSERT INTO household_members (user_id, household_id, role)
        SELECT h.owner_user_id, h.id, 'owner'
        FROM households h
        ON CONFLICT (user_id) DO NOTHING;
      `);

      // Hard-coded allowlist; never interpolated from user input.
      const tables = [
        "debts",
        "debt_balance_history",
        "avalanche_settings",
        "budget_categories",
        "budget_months",
        "budget_lines",
        "recurring_items",
        "transactions",
        "plaid_items",
        "plaid_accounts",
        "plaid_sync_attempts",
        "plaid_consent_reminders_sent",
        "mapping_rules",
        "monthly_snapshots",
        "settings",
        "import_batches",
        "forecast_resolutions",
        "forecast_closed_months",
        "forecast_settings",
        "dashboard_budgets",
      ] as const;

      const updated: Record<string, number> = {};
      for (const t of tables) {
        const res = await tx.execute(
          sql.raw(
            `UPDATE ${t} SET household_id = h.id FROM households h ` +
              `WHERE h.owner_user_id = ${t}.user_id AND ${t}.household_id IS NULL;`,
          ),
        );
        const count =
          (res as unknown as { rowCount?: number }).rowCount ?? 0;
        if (count > 0) updated[t] = count;
      }

      if (Object.keys(updated).length === 0) {
        return { ran: true, reason: "noop_already_converged" };
      }
      logger.info({ updated }, "Startup household backfill stamped rows");
      return { ran: true, updated };
    });
  } catch (err) {
    logger.error({ err }, "Startup household backfill failed");
    return { ran: false, reason: "error" };
  }
}
