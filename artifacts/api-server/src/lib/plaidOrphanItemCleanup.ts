import { and, eq, inArray } from "drizzle-orm";
import { db, plaidAccountsTable, plaidItemsTable } from "@workspace/db";
import { isSyntheticPlaidItem, isValidPlaidAccessToken, plaid } from "./plaid";
import { logger as defaultLogger } from "./logger";

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

export type RemovedOrphan = {
  userId: string;
  itemRowId: string;
  itemId: string;
  institutionName: string | null;
};

export type OrphanBackfillSummary = {
  scannedOrphans: number;
  removedOrphans: number;
  skippedNoHealthySibling: number;
  removedDetails: RemovedOrphan[];
};

/**
 * (#650) Sweep for orphan plaid_items rows: rows whose stored access_token
 * is valid (so the hourly scheduler keeps polling them) AND have zero
 * attached plaid_accounts AND have a healthy sibling row at the same
 * institution for the same user. These are leftovers from re-link flows
 * where the survivor (the row that owns the actual accounts) was chosen
 * elsewhere but the duplicate item rows were never reaped — they keep
 * burning Plaid /transactions/sync quota every hour for nothing.
 *
 * Safe by construction:
 *   - Requires a healthy sibling (valid token, has accounts) for the
 *     same user + same institution. A user with a single Chase login is
 *     never affected.
 *   - Skips synthetic seed items.
 *   - Skips items with malformed tokens (the existing
 *     plaidMalformedSiblingCleanup sweep handles those).
 *   - Best-effort: per-row failures are logged and the sweep continues.
 *   - itemRemove() is best-effort; if it fails we still local-delete so
 *     the wasteful polling stops.
 */
export async function backfillOrphanPlaidItems(opts: {
  log?: Logger;
  /**
   * Test-only scope: when provided, restrict the sweep to these user
   * IDs so integration tests don't accidentally touch rows belonging
   * to other test files sharing the same DB under `singleFork: true`.
   * Production callers omit this and walk every plaid_items row.
   */
  userIds?: string[];
} = {}): Promise<OrphanBackfillSummary> {
  const log = opts.log ?? defaultLogger;
  const items =
    opts.userIds && opts.userIds.length > 0
      ? await db
          .select()
          .from(plaidItemsTable)
          .where(inArray(plaidItemsTable.userId, opts.userIds))
      : await db.select().from(plaidItemsTable);

  const byUser = new Map<string, typeof items>();
  for (const it of items) {
    const arr = byUser.get(it.userId);
    if (arr) arr.push(it);
    else byUser.set(it.userId, [it]);
  }

  let scannedOrphans = 0;
  let removedOrphans = 0;
  let skippedNoHealthySibling = 0;
  const removedDetails: RemovedOrphan[] = [];

  for (const [userId, userItems] of byUser) {
    const acctCounts = new Map<string, number>();
    for (const it of userItems) {
      const rows = await db
        .select({ id: plaidAccountsTable.id })
        .from(plaidAccountsTable)
        .where(
          and(
            eq(plaidAccountsTable.itemId, it.id),
            eq(plaidAccountsTable.userId, userId),
          ),
        );
      acctCounts.set(it.id, rows.length);
    }

    for (const orphan of userItems) {
      if (isSyntheticPlaidItem(orphan)) continue;
      if (!isValidPlaidAccessToken(orphan.accessToken)) continue;
      if ((acctCounts.get(orphan.id) ?? 0) > 0) continue;
      scannedOrphans += 1;

      const healthy = userItems.find((other) => {
        if (other.id === orphan.id) return false;
        if (isSyntheticPlaidItem(other)) return false;
        if (!isValidPlaidAccessToken(other.accessToken)) return false;
        if ((acctCounts.get(other.id) ?? 0) === 0) return false;
        // Institution match: prefer the authoritative Plaid institution_id
        // when both rows have one. Only fall back to institution_slug when
        // at least one side is missing institution_id, otherwise different
        // institutions that happen to share a generic slug could collide.
        if (orphan.institutionId && other.institutionId) {
          return orphan.institutionId === other.institutionId;
        }
        if (
          orphan.institutionSlug &&
          other.institutionSlug &&
          orphan.institutionSlug === other.institutionSlug
        ) {
          return true;
        }
        return false;
      });
      if (!healthy) {
        skippedNoHealthySibling += 1;
        continue;
      }

      try {
        try {
          await plaid().itemRemove({ access_token: orphan.accessToken });
        } catch (err) {
          log.warn(
            {
              err,
              userId,
              orphanItemRowId: orphan.id,
              orphanPlaidItemId: orphan.itemId,
              institutionName: orphan.institutionName,
            },
            "[plaid-orphan-cleanup] upstream itemRemove failed — proceeding with local delete to stop wasted polling",
          );
        }

        await db
          .delete(plaidItemsTable)
          .where(
            and(
              eq(plaidItemsTable.id, orphan.id),
              eq(plaidItemsTable.userId, userId),
            ),
          );

        removedOrphans += 1;
        removedDetails.push({
          userId,
          itemRowId: orphan.id,
          itemId: orphan.itemId,
          institutionName: orphan.institutionName,
        });
        log.info(
          {
            userId,
            survivorItemRowId: healthy.id,
            removedItemRowId: orphan.id,
            removedPlaidItemIdExternal: orphan.itemId,
            institutionName: orphan.institutionName,
          },
          "[plaid-orphan-cleanup] removed orphan plaid_item with no accounts and a healthy sibling",
        );
      } catch (err) {
        log.warn(
          {
            err,
            userId,
            orphanItemRowId: orphan.id,
            survivorItemRowId: healthy.id,
            institutionName: orphan.institutionName,
          },
          "[plaid-orphan-cleanup] removal of orphan row failed — will retry on next boot",
        );
      }
    }
  }

  return {
    scannedOrphans,
    removedOrphans,
    skippedNoHealthySibling,
    removedDetails,
  };
}
