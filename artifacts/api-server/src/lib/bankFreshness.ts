import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import {
  db,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  plaidSyncAttemptsTable,
} from "@workspace/db";
import { MANUAL_SNAPSHOT_STALE_MS, PLAID_FEED_QUIET_MS } from "@workspace/avalanche-core/freshness";
import { BANK_FEED_DEAD_CODES, PLAID_REAUTH_ERROR_CODES } from "./plaidReauthCodes";
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

// (WP1) The thresholds live in avalanche-core so the browser judges "out of
// date" by the same clock: a Plaid feed silent 48 hours (no balance re-read, no
// successful sync) is old; a typed-in balance older than 7 days is old.
// Re-exported so existing importers keep their path.
export { PLAID_FEED_QUIET_MS, MANUAL_SNAPSHOT_STALE_MS };

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

/**
 * ⭐ (Q1) WHEN THE BANK LAST TOLD US ANYTHING — the instant the age rule reads.
 * A Plaid balance: the later of its re-read (the snapshot) and the last
 * successful sync (rows landing on top of it). A typed-in balance: its own
 * time (a live feed does not refresh a typed number). Null when neither is
 * known. The spine's `bankConfidence.fetchedAt` and each Plaid item's
 * `freshness.fetchedAt` are this, so "Updated 2 h ago" and "stale" never
 * disagree.
 */
export function lastHeardAt(args: {
  source: "plaid" | "manual";
  snapshotAt: Date | null;
  lastContactAt: Date | null;
}): Date | null {
  return args.source === "plaid" ? later(args.snapshotAt, args.lastContactAt) : args.snapshotAt;
}

/**
 * (Q1) The spine's `bankConfidence.fetchedAt`: `lastHeardAt` for the bank
 * balance, from its freshness read and its snapshot's time. Null with no
 * snapshot (source null).
 */
export function bankFetchedAt(freshness: Pick<BankFreshness, "source" | "lastContactAt">, snapshotAt: string | null): string | null {
  if (!freshness.source) return null;
  const heard = lastHeardAt({
    source: freshness.source,
    snapshotAt: snapshotAt ? new Date(snapshotAt) : null,
    lastContactAt: freshness.lastContactAt ? new Date(freshness.lastContactAt) : null,
  });
  return heard ? heard.toISOString() : null;
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
  // The last time the bank told us anything (`lastHeardAt`).
  const lastHeard = lastHeardAt(args);
  if (!lastHeard) return null;
  if (args.source === "plaid") {
    return args.now.getTime() - lastHeard.getTime() > PLAID_FEED_QUIET_MS
      ? "old"
      : null;
  }
  // A live feed does not refresh a typed-in number; only its own age counts.
  return args.now.getTime() - lastHeard.getTime() > MANUAL_SNAPSHOT_STALE_MS
    ? "manual_old"
    : null;
}

/**
 * ⭐ (Q1) EACH FEED'S UNRECOVERED FAILURE, in one read for any number of
 * items: the newest `transactions` and the newest `balance` attempt of each
 * item (PRODUCT_NOT_READY skipped: a feed warming up, not failing). A kind
 * whose newest attempt failed has not recovered — a success of the OTHER kind
 * does not recover it — and the later of the two failures is reported. The
 * bank balance's freshness (`computeBankFreshness`) and every Plaid item's
 * (`plaidItemFreshness`) read it, so the rule is one.
 */
export async function unrecoveredFailureAt(itemRowIds: readonly string[]): Promise<Map<string, Date | null>> {
  const out = new Map<string, Date | null>(itemRowIds.map((id) => [id, null]));
  if (itemRowIds.length === 0) return out;
  const rows = await db
    .selectDistinctOn([plaidSyncAttemptsTable.plaidItemId, plaidSyncAttemptsTable.kind], {
      itemId: plaidSyncAttemptsTable.plaidItemId,
      kind: plaidSyncAttemptsTable.kind,
      success: plaidSyncAttemptsTable.success,
      attemptedAt: plaidSyncAttemptsTable.attemptedAt,
    })
    .from(plaidSyncAttemptsTable)
    .where(
      and(
        inArray(plaidSyncAttemptsTable.plaidItemId, [...itemRowIds]),
        inArray(plaidSyncAttemptsTable.kind, ["transactions", "balance"]),
        // Still preparing is a feed warming up, not a feed failing.
        or(
          isNull(plaidSyncAttemptsTable.errorCode),
          ne(plaidSyncAttemptsTable.errorCode, "PRODUCT_NOT_READY"),
        ),
      ),
    )
    .orderBy(plaidSyncAttemptsTable.plaidItemId, plaidSyncAttemptsTable.kind, desc(plaidSyncAttemptsTable.attemptedAt));
  for (const a of rows) {
    if (a.success) continue;
    const cur = out.get(a.itemId) ?? null;
    if (!cur || a.attemptedAt > cur) out.set(a.itemId, a.attemptedAt);
  }
  return out;
}

/** (Q1) One bank connection's state, as every screen words it. */
export type FeedState = "ok" | "stale" | "refresh_failed" | "needs_reconnect" | "never";

/**
 * ⭐ (Q1) ONE PLAID ITEM'S FRESHNESS — the bank balance's own rule
 * (`staleReasonFor`, `unrecoveredFailureAt`, `BANK_FEED_DEAD_CODES`), applied
 * to the item, so no screen judges a connection from `last_sync_error` (the
 * liabilities refresh writes that column too: a card hiccup would mark the
 * bank failed). `state`, first match wins:
 *   needs_reconnect  its last error code asks for a reconnect
 *                    (`PLAID_REAUTH_ERROR_CODES`, the Reconnect button's rule);
 *   refresh_failed   an unrecovered transactions / balance failure, or a code
 *                    that means the feed is gone;
 *   never            never synced and no balance read;
 *   stale            silent 48 hours (`PLAID_FEED_QUIET_MS`);
 *   ok.
 * `fetchedAt` = `lastHeardAt` (the later of the item's newest balance reading
 * and its last successful sync). Pure.
 */
export function plaidItemFreshness(args: {
  lastSyncedAt: Date | null;
  lastSyncErrorCode: string | null;
  lastFailureAt: Date | null;
  /** The item's newest balance reading (any of its accounts), or null. */
  snapshotAt: Date | null;
  now: Date;
}): {
  state: FeedState;
  stale: boolean;
  staleReason: BankStaleReason | null;
  fetchedAt: string | null;
  lastContactAt: string | null;
  lastFailureAt: string | null;
} {
  const code = args.lastSyncErrorCode;
  const staleReason = staleReasonFor({
    source: "plaid",
    snapshotAt: args.snapshotAt,
    lastContactAt: args.lastSyncedAt,
    lastFailureAt: args.lastFailureAt,
    feedDead: code != null && BANK_FEED_DEAD_CODES.has(code),
    now: args.now,
  });
  const heard = lastHeardAt({ source: "plaid", snapshotAt: args.snapshotAt, lastContactAt: args.lastSyncedAt });
  const state: FeedState =
    code != null && PLAID_REAUTH_ERROR_CODES.has(code)
      ? "needs_reconnect"
      : staleReason === "refresh_failed"
        ? "refresh_failed"
        : !heard
          ? "never"
          : staleReason
            ? "stale"
            : "ok";
  return {
    state,
    stale: staleReason !== null,
    staleReason,
    fetchedAt: heard ? heard.toISOString() : null,
    lastContactAt: args.lastSyncedAt ? args.lastSyncedAt.toISOString() : null,
    lastFailureAt: args.lastFailureAt ? args.lastFailureAt.toISOString() : null,
  };
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
      // A kind whose newest attempt failed has not recovered. A success of the
      // OTHER kind does not recover it. Report the later of the two failures.
      // (Q1) One read, shared with every Plaid item's freshness.
      lastFailureAt = (await unrecoveredFailureAt([acct.itemRowId])).get(acct.itemRowId) ?? null;
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
