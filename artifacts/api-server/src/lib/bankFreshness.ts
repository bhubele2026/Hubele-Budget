import { and, desc, eq } from "drizzle-orm";
import {
  db,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  plaidSyncAttemptsTable,
} from "@workspace/db";
import { BANK_FEED_DEAD_CODES } from "./plaidReauthCodes";
import { resolveSnapshotAccount } from "./resolveSnapshotAccount";

/**
 * ⭐ IS THE BANK BALANCE STALE? One answer, decided on the server.
 *
 * Screens that show cash today used to judge freshness for themselves, from a
 * timestamp, or not at all. A refresh that failed an hour ago looked exactly
 * like a fresh balance until someone noticed the numbers were wrong. This reads
 * what we already store — the snapshot, the Plaid item behind its account, and
 * that item's refresh attempts — and returns one verdict, which the spine and
 * `/forecast/bank-balance-explain` both serve.
 *
 *   refresh_failed  The feed behind the snapshot account failed and has not
 *                   recovered, or needs a reconnect. Immediate, for either
 *                   source: a typed-in balance rolls forward over Plaid rows
 *                   too, and those stop arriving.
 *   old             A Plaid snapshot older than 48 hours.
 *   manual_old      A typed-in balance older than 7 days.
 *
 * ⚠️ NEVER READ FAILURE FROM `plaid_items.last_sync_error`. The liabilities
 * refresh writes that column too, so a credit-card hiccup would mark the bank
 * stale. Failure comes from `transactions` and `balance` attempts, and from the
 * error CODES that mean the feed is gone (`BANK_FEED_DEAD_CODES`).
 *
 * ⚠️ READ-ONLY AND FREE. No Plaid call: this sits on the spine's path.
 */

export const PLAID_SNAPSHOT_STALE_MS = 48 * 60 * 60 * 1000;
export const MANUAL_SNAPSHOT_STALE_MS = 7 * 24 * 60 * 60 * 1000;

export type BankStaleReason = "refresh_failed" | "old" | "manual_old";

export interface BankFreshness {
  /** Where the snapshot came from; null when there is no snapshot. */
  source: "plaid" | "manual" | null;
  /** Last successful sync of the Plaid item behind the snapshot account. */
  lastContactAt: string | null;
  /** Newest `transactions` or `balance` failure not yet followed by a success of the same kind. */
  lastFailureAt: string | null;
  stale: boolean;
  staleReason: BankStaleReason | null;
}

/** The rule itself, with no I/O. Failure outranks age. */
export function staleReasonFor(args: {
  source: "plaid" | "manual";
  snapshotAt: Date | null;
  lastFailureAt: Date | null;
  feedDead: boolean;
  now: Date;
}): BankStaleReason | null {
  if (args.lastFailureAt || args.feedDead) return "refresh_failed";
  if (!args.snapshotAt) return null;
  const ageMs = args.now.getTime() - args.snapshotAt.getTime();
  if (args.source === "plaid") return ageMs > PLAID_SNAPSHOT_STALE_MS ? "old" : null;
  return ageMs > MANUAL_SNAPSHOT_STALE_MS ? "manual_old" : null;
}

async function newestAttempt(
  itemRowId: string,
  kind: "transactions" | "balance",
): Promise<{ success: boolean; attemptedAt: Date } | null> {
  const [row] = await db
    .select({
      success: plaidSyncAttemptsTable.success,
      attemptedAt: plaidSyncAttemptsTable.attemptedAt,
    })
    .from(plaidSyncAttemptsTable)
    .where(
      and(
        eq(plaidSyncAttemptsTable.plaidItemId, itemRowId),
        eq(plaidSyncAttemptsTable.kind, kind),
      ),
    )
    .orderBy(desc(plaidSyncAttemptsTable.attemptedAt))
    .limit(1);
  return row ?? null;
}

export async function computeBankFreshness(
  householdId: string,
  ownerUserId: string,
  now: Date = new Date(),
): Promise<BankFreshness> {
  const [settings] = await db
    .select({
      balance: forecastSettingsTable.bankSnapshotBalance,
      at: forecastSettingsTable.bankSnapshotAt,
      source: forecastSettingsTable.bankSnapshotSource,
      accountId: forecastSettingsTable.bankSnapshotAccountId,
      mask: forecastSettingsTable.bankSnapshotMask,
    })
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, ownerUserId));

  // No snapshot is "missing", which the forecast already reports as `no_data`.
  // It is not the same thing as stale.
  if (!settings || settings.balance == null) {
    return {
      source: null,
      lastContactAt: null,
      lastFailureAt: null,
      stale: false,
      staleReason: null,
    };
  }

  // Same default as the forecast bundle: anything not from Plaid was typed in.
  const source = settings.source === "plaid" ? "plaid" : "manual";

  let lastContactAt: Date | null = null;
  let lastFailureAt: Date | null = null;
  let feedDead = false;

  // The same account resolution the roll-forward uses, so "the feed behind the
  // balance" is the feed that actually moves it.
  const resolved = await resolveSnapshotAccount({
    householdId,
    bankSnapshotAccountId: settings.accountId ?? null,
    bankSnapshotMask: settings.mask ?? null,
  });
  if (resolved.rowId) {
    const [acct] = await db
      .select({ itemRowId: plaidAccountsTable.itemId })
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.id, resolved.rowId));
    const [item] = acct
      ? await db
          .select({
            lastSyncedAt: plaidItemsTable.lastSyncedAt,
            lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
          })
          .from(plaidItemsTable)
          .where(eq(plaidItemsTable.id, acct.itemRowId))
      : [];
    if (acct && item) {
      lastContactAt = item.lastSyncedAt ?? null;
      feedDead =
        item.lastSyncErrorCode != null &&
        BANK_FEED_DEAD_CODES.has(item.lastSyncErrorCode);
      const newest = await Promise.all([
        newestAttempt(acct.itemRowId, "transactions"),
        newestAttempt(acct.itemRowId, "balance"),
      ]);
      // A kind whose newest attempt failed has not recovered. Report the later
      // of the two.
      for (const a of newest) {
        if (a && !a.success && (!lastFailureAt || a.attemptedAt > lastFailureAt)) {
          lastFailureAt = a.attemptedAt;
        }
      }
    }
  }

  const staleReason = staleReasonFor({
    source,
    snapshotAt: settings.at ?? null,
    lastFailureAt,
    feedDead,
    now,
  });

  return {
    source,
    lastContactAt: lastContactAt ? lastContactAt.toISOString() : null,
    lastFailureAt: lastFailureAt ? lastFailureAt.toISOString() : null,
    stale: staleReason !== null,
    staleReason,
  };
}
