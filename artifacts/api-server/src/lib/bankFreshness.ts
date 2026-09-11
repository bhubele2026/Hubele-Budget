import { and, desc, eq, isNull, ne, or } from "drizzle-orm";
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
 *   old             A Plaid balance whose feed has gone quiet: no balance
 *                   re-read and no successful sync for 48 hours.
 *   manual_old      A typed-in balance older than 7 days.
 *
 * ⚠️ "OLD" READS THE FEED, NOT ONLY THE ANCHOR. Nothing re-reads the balance in
 * the background any more — the Plaid crons are gone and only the owner's Sync
 * calls /accounts/balance/get — but free webhook syncs keep landing rows on top
 * of it. A balance re-read three days ago plus rows that arrived an hour ago is
 * a current roll-forward. It goes old when the bank stops talking to us.
 *
 * ⚠️ NEVER READ FAILURE FROM `plaid_items.last_sync_error`. The liabilities
 * refresh writes that column too, so a credit-card hiccup would mark the bank
 * stale. Failure comes from `transactions` and `balance` attempts, and from the
 * error CODES that mean the feed is gone (`BANK_FEED_DEAD_CODES`).
 *
 * ⚠️ PRODUCT_NOT_READY IS NOT A FAILURE. Plaid answers it while a new link is
 * still preparing. The sync logs it as `success=false` so the Recent activity
 * panel shows the warm-up, but the feed is starting, not broken, so those rows
 * are skipped here.
 *
 * ⚠️ READ-ONLY AND FREE. No Plaid call: this sits on the spine's path.
 */

/** A Plaid feed silent this long (no balance re-read, no successful sync) is old. */
export const PLAID_FEED_QUIET_MS = 48 * 60 * 60 * 1000;
/** A typed-in balance older than this is old. */
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

function later(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** The rule itself, with no I/O. Failure outranks age. */
export function staleReasonFor(args: {
  source: "plaid" | "manual";
  snapshotAt: Date | null;
  lastContactAt: Date | null;
  lastFailureAt: Date | null;
  feedDead: boolean;
  now: Date;
}): BankStaleReason | null {
  if (args.lastFailureAt || args.feedDead) return "refresh_failed";
  if (args.source === "plaid") {
    // The last time the bank told us anything: a balance re-read (the snapshot)
    // or a successful sync (rows landing on top of it).
    const lastHeard = later(args.snapshotAt, args.lastContactAt);
    if (!lastHeard) return null;
    return args.now.getTime() - lastHeard.getTime() > PLAID_FEED_QUIET_MS
      ? "old"
      : null;
  }
  // A live feed does not refresh a typed-in number; only its own age counts.
  if (!args.snapshotAt) return null;
  return args.now.getTime() - args.snapshotAt.getTime() > MANUAL_SNAPSHOT_STALE_MS
    ? "manual_old"
    : null;
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
        // Still preparing is a feed warming up, not a feed failing.
        or(
          isNull(plaidSyncAttemptsTable.errorCode),
          ne(plaidSyncAttemptsTable.errorCode, "PRODUCT_NOT_READY"),
        ),
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
      // A kind whose newest attempt failed has not recovered. A success of the
      // OTHER kind does not recover it. Report the later of the two failures.
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
    lastContactAt,
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
