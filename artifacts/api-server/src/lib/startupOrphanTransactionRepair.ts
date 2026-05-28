import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  db,
  debtsTable,
  plaidAccountsTable,
  transactionsTable,
} from "@workspace/db";
import { logger as defaultLogger } from "./logger";

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

/**
 * (#796) Repair households whose Plaid item (canonical example: Chase on
 * household a7182af8-49f0-48f3-920e-f916c7eab872 / h2hubele@gmail.com)
 * was destructively wiped BEFORE the live-attachment guard added in
 * task #790.
 *
 * Background: `transactions.plaid_account_id` stores Plaid's *external*
 * `account_id` text — NOT the internal `plaid_accounts.id` uuid. When a
 * pre-#790 cleanup deleted a `plaid_items` row together with its
 * `plaid_accounts` rows, every transaction that pointed at one of those
 * external account_ids was left dangling: its `plaid_account_id` no
 * longer resolves to any `plaid_accounts` row, so it vanishes from the
 * Chase / Amex source-of-truth pickers (which join transactions to
 * accounts on the external id).
 *
 * This is a one-shot, idempotent, best-effort boot sweep. It:
 *   1. Scans EVERY household for orphaned transactions (a non-null
 *      `plaid_account_id` with no surviving `plaid_accounts.account_id`
 *      match) and logs the count per household so operators can see who
 *      is still affected.
 *   2. Best-effort re-points the subset we can map safely: a debt-linked
 *      orphan transaction (`transactions.debt_id`) whose debt is still
 *      attached to a live `plaid_accounts` row. The debt FK is the only
 *      signal that survives the wipe (the original account row, and with
 *      it the mask/name we'd normally match on, is gone). When the debt's
 *      current account now owns a different external `account_id`, we
 *      rewrite the transaction's pointer onto it — the same
 *      "repoint transactions onto the survivor's external account_id"
 *      move `dedupePlaidAccounts` performs, but with the survivor located
 *      via the debt link instead of (institution, mask, name).
 *
 *      Transactions whose external account_id is already owned by the
 *      user's current item (Plaid handed back the same `account_id` on
 *      relink) self-heal: they are simply not in the orphan set anymore,
 *      so no write is needed. Checking-account orphans with no debt link
 *      cannot be mapped safely and are left in place to be reported — far
 *      better than guessing and mis-assigning a transaction to the wrong
 *      account.
 *
 * Idempotent: once every repointable orphan is fixed, subsequent boots
 * re-scan and find nothing to write. Best-effort: any failure is logged
 * and swallowed so a transient DB blip can never crash boot.
 */
export type OrphanHouseholdCount = {
  householdId: string | null;
  orphanCount: number;
};

export type OrphanTxnRepairSummary = {
  /** Total orphan transactions found across all households before repoint. */
  scannedOrphans: number;
  /** Transactions whose pointer we rewrote onto a current account. */
  repointed: number;
  /** Per-household orphan counts observed BEFORE the repoint pass. */
  households: OrphanHouseholdCount[];
  /** Per-household orphan counts still remaining AFTER the repoint pass. */
  residualHouseholds: OrphanHouseholdCount[];
};

/**
 * Reusable scan: count transactions per household whose non-null
 * `plaid_account_id` (external Plaid account_id text) no longer resolves
 * to a surviving `plaid_accounts` row. Ordered by descending count so
 * the worst-affected household sorts first. Exported so the health
 * endpoint can report the live (post-run) state without duplicating the
 * predicate.
 */
export async function scanOrphanTransactionsByHousehold(): Promise<{
  total: number;
  households: OrphanHouseholdCount[];
}> {
  const rows = await db
    .select({
      householdId: transactionsTable.householdId,
      cnt: sql<number>`count(*)::int`,
    })
    .from(transactionsTable)
    .where(
      and(
        isNotNull(transactionsTable.plaidAccountId),
        sql`not exists (select 1 from ${plaidAccountsTable}
              where ${plaidAccountsTable.accountId} = ${transactionsTable.plaidAccountId})`,
      ),
    )
    .groupBy(transactionsTable.householdId);

  const households: OrphanHouseholdCount[] = rows
    .map((r) => ({
      householdId: r.householdId,
      orphanCount: Number(r.cnt ?? 0),
    }))
    .filter((r) => r.orphanCount > 0)
    .sort((a, b) => b.orphanCount - a.orphanCount);
  const total = households.reduce((sum, r) => sum + r.orphanCount, 0);
  return { total, households };
}

export async function runStartupOrphanTransactionRepair(
  log: Logger = defaultLogger,
): Promise<OrphanTxnRepairSummary> {
  const summary: OrphanTxnRepairSummary = {
    scannedOrphans: 0,
    repointed: 0,
    households: [],
    residualHouseholds: [],
  };

  try {
    const before = await scanOrphanTransactionsByHousehold();
    summary.scannedOrphans = before.total;
    summary.households = before.households;
    for (const h of before.households) {
      log.info(
        { householdId: h.householdId, orphanCount: h.orphanCount },
        "[orphan-txn-repair] household has orphaned transactions (plaid_account_id missing from plaid_accounts)",
      );
    }

    if (before.total === 0) {
      log.info(
        {},
        "[orphan-txn-repair] no orphaned transactions found — nothing to repair",
      );
      return summary;
    }

    // Repoint candidates: orphan transactions still carrying a debt_id
    // whose debt resolves to a LIVE plaid_accounts row. The debt's
    // current account_id is the safe re-point target. We exclude rows
    // whose external id already matches the target (no write needed) and
    // rows whose external id is already owned by some live account (those
    // self-healed and are not orphans).
    const candidates = await db
      .select({
        txnId: transactionsTable.id,
        householdId: transactionsTable.householdId,
        oldExternalId: transactionsTable.plaidAccountId,
        targetExternalId: plaidAccountsTable.accountId,
      })
      .from(transactionsTable)
      .innerJoin(debtsTable, eq(transactionsTable.debtId, debtsTable.id))
      .innerJoin(
        plaidAccountsTable,
        eq(debtsTable.plaidAccountId, plaidAccountsTable.id),
      )
      .where(
        and(
          isNotNull(transactionsTable.plaidAccountId),
          sql`${plaidAccountsTable.accountId} <> ${transactionsTable.plaidAccountId}`,
          sql`not exists (select 1 from ${plaidAccountsTable} live
                where live.account_id = ${transactionsTable.plaidAccountId})`,
        ),
      );

    // Group candidate txn ids by their re-point target so we issue one
    // UPDATE per target instead of one per row.
    const byTarget = new Map<string, string[]>();
    const repointedPerHousehold = new Map<string | null, number>();
    for (const c of candidates) {
      if (!c.targetExternalId) continue;
      const arr = byTarget.get(c.targetExternalId);
      if (arr) arr.push(c.txnId);
      else byTarget.set(c.targetExternalId, [c.txnId]);
      repointedPerHousehold.set(
        c.householdId,
        (repointedPerHousehold.get(c.householdId) ?? 0) + 1,
      );
    }

    for (const [targetExternalId, txnIds] of byTarget) {
      const updated = await db
        .update(transactionsTable)
        .set({ plaidAccountId: targetExternalId })
        .where(inArray(transactionsTable.id, txnIds))
        .returning({ id: transactionsTable.id });
      summary.repointed += updated.length;
    }

    if (summary.repointed > 0) {
      for (const [householdId, count] of repointedPerHousehold) {
        log.info(
          { householdId, repointed: count },
          "[orphan-txn-repair] re-pointed debt-linked orphan transactions onto the household's current account",
        );
      }
    }

    const after = await scanOrphanTransactionsByHousehold();
    summary.residualHouseholds = after.households;
    log.info(
      {
        scannedOrphans: summary.scannedOrphans,
        repointed: summary.repointed,
        residualOrphans: after.total,
        residualHouseholds: after.households.length,
      },
      "[orphan-txn-repair] sweep complete",
    );
  } catch (err) {
    log.error(
      { err },
      "[orphan-txn-repair] sweep failed — server boot continues",
    );
  }

  return summary;
}
