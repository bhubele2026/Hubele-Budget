/**
 * One-shot cleanup: clear `forecast_flag = true` on every transaction whose
 * account isn't the user's configured Chase checking account.
 *
 * Background (task #120): #118 made the Forecast page filter out non-checking
 * rows at read time but intentionally left the underlying flag alone on
 * legacy Amex / credit-card rows. Those rows are now invisible on Forecast
 * but still render a "Sent · pending in Forecast" badge on the Transactions
 * page and pollute any query that reads `forecast_flag` directly. This
 * script aligns the data with what the UI now shows.
 *
 * Per-user logic mirrors the read filter in
 *   `artifacts/api-server/src/routes/forecast.ts` (`isBankRow`)
 *   `artifacts/api-server/src/lib/cashSignal.ts`  (`isBankRow`)
 *
 *   - Look up the user's `forecast_settings.bank_snapshot_account_id`
 *     (uuid into plaid_accounts), resolve the external Plaid account_id.
 *   - A row is "bank checking" iff:
 *       * plaid_account_id == configured external account_id, OR
 *       * plaid_account_id IS NULL AND source NOT IN ('amex') AND
 *         source NOT LIKE 'plaid:%'  (i.e. legitimate manual checking row).
 *   - Everything else with `forecast_flag = true` gets cleared to false.
 *
 * Going forward this state is impossible: `plaidSync.ts` only sets
 * `forecastFlag = true` when the Plaid txn's `account_id` matches the
 * configured checking account, and the Forecast read paths re-filter at
 * query time.
 *
 * Usage (from anywhere):
 *   ./scripts/node_modules/.bin/tsx \
 *     artifacts/api-server/scripts/clear-non-checking-forecast-flag.ts          # dry run
 *   ./scripts/node_modules/.bin/tsx \
 *     artifacts/api-server/scripts/clear-non-checking-forecast-flag.ts --apply
 */

import { and, eq, ne, or, sql } from "drizzle-orm";
import {
  db,
  forecastSettingsTable,
  plaidAccountsTable,
  transactionsTable,
} from "@workspace/db";

const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;

async function main(): Promise<void> {
  console.log(
    `[clear-forecast-flag] mode=${DRY_RUN ? "DRY-RUN" : "APPLY"}`,
  );

  // Find every user that currently has at least one forecast_flag=true row.
  // Iterating by user (rather than a single global UPDATE) lets us honor
  // each user's own configured checking account.
  const userRows = await db
    .selectDistinct({ userId: transactionsTable.userId })
    .from(transactionsTable)
    .where(eq(transactionsTable.forecastFlag, true));
  console.log(
    `[clear-forecast-flag] users with forecast_flag=true rows: ${userRows.length}`,
  );

  let totalCleared = 0;

  for (const { userId } of userRows) {
    const [settings] = await db
      .select()
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, userId));

    let configuredCheckingExternalId: string | null = null;
    if (settings?.bankSnapshotAccountId) {
      const [acct] = await db
        .select({ accountId: plaidAccountsTable.accountId })
        .from(plaidAccountsTable)
        .where(eq(plaidAccountsTable.id, settings.bankSnapshotAccountId));
      configuredCheckingExternalId = acct?.accountId ?? null;
    }

    // A non-checking row (the cleanup target) is one where:
    //   - plaid_account_id is set AND differs from configured checking, OR
    //     (if no checking is configured at all, ALL plaid rows are
    //     non-checking — matches the read filter's behavior), OR
    //   - plaid_account_id IS NULL but source identifies it as a
    //     credit-card import ('amex' or 'plaid:%').
    const nonCheckingPlaidCond = configuredCheckingExternalId
      ? and(
          sql`${transactionsTable.plaidAccountId} IS NOT NULL`,
          ne(transactionsTable.plaidAccountId, configuredCheckingExternalId),
        )
      : sql`${transactionsTable.plaidAccountId} IS NOT NULL`;

    // Case-insensitive to mirror the runtime read filter, which lowercases
    // `source` before comparing — protects against any legacy casing like
    // `Amex` / `Plaid:*` that might have slipped through earlier imports.
    const nonCheckingManualCond = and(
      sql`${transactionsTable.plaidAccountId} IS NULL`,
      or(
        sql`lower(${transactionsTable.source}) = 'amex'`,
        sql`lower(${transactionsTable.source}) LIKE 'plaid:%'`,
      ),
    );

    const whereCond = and(
      eq(transactionsTable.userId, userId),
      eq(transactionsTable.forecastFlag, true),
      or(nonCheckingPlaidCond, nonCheckingManualCond),
    );

    if (DRY_RUN) {
      const rows = await db
        .select({
          id: transactionsTable.id,
          source: transactionsTable.source,
          plaidAccountId: transactionsTable.plaidAccountId,
        })
        .from(transactionsTable)
        .where(whereCond);
      totalCleared += rows.length;
      console.log(
        `[clear-forecast-flag] user=${userId} configuredCheckingExternalId=${configuredCheckingExternalId ?? "<none>"} would-clear=${rows.length}`,
      );
      for (const r of rows.slice(0, 5)) {
        console.log(
          `  - ${r.id} source=${r.source ?? "null"} plaidAccountId=${r.plaidAccountId ?? "null"}`,
        );
      }
      if (rows.length > 5) {
        console.log(`  … +${rows.length - 5} more`);
      }
    } else {
      const updated = await db
        .update(transactionsTable)
        .set({ forecastFlag: false })
        .where(whereCond)
        .returning({ id: transactionsTable.id });
      totalCleared += updated.length;
      console.log(
        `[clear-forecast-flag] user=${userId} configuredCheckingExternalId=${configuredCheckingExternalId ?? "<none>"} cleared=${updated.length}`,
      );
    }
  }

  console.log(
    `\n[clear-forecast-flag] result: rowsAffected=${totalCleared} (${DRY_RUN ? "dry-run, nothing written" : "applied"})`,
  );

  await db.$client.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await db.$client.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
