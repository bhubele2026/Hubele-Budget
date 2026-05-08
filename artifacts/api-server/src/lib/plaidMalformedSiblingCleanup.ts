import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import {
  db,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import { isSyntheticPlaidItem, isValidPlaidAccessToken } from "./plaid";
import { logger as defaultLogger } from "./logger";

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

export type CleanedSibling = {
  itemRowId: string;
  itemId: string;
  institutionName: string | null;
};

/**
 * (#406) Local-only cleanup of malformed-token sibling `plaid_items` rows
 * for a given user + institution. Mirrors the inline block under the
 * (#401) comment in `routes/plaid.ts`: any other row for the same user
 * and institution that fails the malformed-token guard is treated as a
 * stale leftover from before the upstream guard existed and is removed
 * locally — debt rows pointing at its accounts are reset to manual
 * source, then the accounts and the item itself are deleted. We never
 * touch a healthy sibling, so a user with two legitimate logins for the
 * same institution is left alone.
 *
 * Skipping the upstream Plaid `/item/remove` is safe because the token
 * is malformed: Plaid would 400 on it anyway, and the only side effect
 * is the local Settings + dashboard banner cleanup we want.
 */
export async function cleanupMalformedTokenSiblings(opts: {
  userId: string;
  survivorItemRowId: string;
  institutionId: string | null;
  institutionSlug: string | null;
  log?: Logger;
}): Promise<{ cleaned: CleanedSibling[] }> {
  const { userId, survivorItemRowId, institutionId, institutionSlug } = opts;
  const log = opts.log ?? defaultLogger;
  const cleaned: CleanedSibling[] = [];

  // Need at least one of institutionId / institutionSlug to scope the
  // sibling search; otherwise we'd match every row for this user and
  // could nuke unrelated banks. When both are available, OR them so a
  // stale row that only carries the slug (older link metadata) is
  // still found alongside one that carries institution_id — we miss
  // duplicates if we only ever filter on the survivor's id field.
  const filters: SQL[] = [];
  if (institutionId) filters.push(eq(plaidItemsTable.institutionId, institutionId));
  if (institutionSlug) filters.push(eq(plaidItemsTable.institutionSlug, institutionSlug));
  if (filters.length === 0) return { cleaned };
  const institutionFilter: SQL | undefined =
    filters.length === 1 ? filters[0] : or(...filters);
  if (!institutionFilter) return { cleaned };

  const sameInstitutionRows = await db
    .select()
    .from(plaidItemsTable)
    .where(and(eq(plaidItemsTable.userId, userId), institutionFilter));

  for (const stale of sameInstitutionRows) {
    if (stale.id === survivorItemRowId) continue;
    if (isSyntheticPlaidItem(stale)) continue;
    if (isValidPlaidAccessToken(stale.accessToken)) continue;

    const staleAccts = await db
      .select({ id: plaidAccountsTable.id })
      .from(plaidAccountsTable)
      .where(
        and(
          eq(plaidAccountsTable.itemId, stale.id),
          eq(plaidAccountsTable.userId, userId),
        ),
      );
    const staleAcctIds = staleAccts.map((a) => a.id);
    if (staleAcctIds.length > 0) {
      await db
        .update(debtsTable)
        .set({
          balanceSource: "manual",
          aprSource: "manual",
          minPaymentSource: "manual",
          plaidLastSyncedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(debtsTable.userId, userId),
            inArray(debtsTable.plaidAccountId, staleAcctIds),
          ),
        );
    }
    await db
      .delete(plaidAccountsTable)
      .where(
        and(
          eq(plaidAccountsTable.itemId, stale.id),
          eq(plaidAccountsTable.userId, userId),
        ),
      );
    await db
      .delete(plaidItemsTable)
      .where(
        and(
          eq(plaidItemsTable.id, stale.id),
          eq(plaidItemsTable.userId, userId),
        ),
      );
    cleaned.push({
      itemRowId: stale.id,
      itemId: stale.itemId,
      institutionName: stale.institutionName,
    });
    log.info(
      {
        userId,
        survivorItemRowId,
        cleanedItemRowId: stale.id,
        cleanedPlaidItemIdExternal: stale.itemId,
        institutionName: stale.institutionName,
      },
      "[plaid-malformed-sibling] auto-archived stale malformed-token row",
    );
  }

  return { cleaned };
}

/**
 * (#406) One-shot backfill: walk every `plaid_items` row, find each one
 * whose stored access_token fails the malformed-token guard AND has a
 * healthy sibling row for the same user + same institution, and run the
 * same local cleanup the exchange handler now does. Idempotent — once
 * the duplicate rows are gone, subsequent runs are no-ops. Best-effort
 * per malformed row: a single per-row failure is logged and the sweep
 * continues so one stuck row never blocks recovery for the rest.
 */
export async function backfillMalformedTokenSiblings(): Promise<{
  scannedMalformed: number;
  cleanedSiblings: number;
  skippedNoHealthySibling: number;
}> {
  const items = await db.select().from(plaidItemsTable);
  // Group by user so we can find a healthy sibling without re-querying
  // for every malformed row.
  const byUser = new Map<string, typeof items>();
  for (const it of items) {
    const arr = byUser.get(it.userId);
    if (arr) arr.push(it);
    else byUser.set(it.userId, [it]);
  }

  let scannedMalformed = 0;
  let cleanedSiblings = 0;
  let skippedNoHealthySibling = 0;
  // Avoid running the helper twice for the same (user, institution)
  // when two stale rows share an institution — the first call will
  // already sweep both of them via the survivor-driven scan.
  const handled = new Set<string>();

  for (const [userId, userItems] of byUser) {
    for (const stale of userItems) {
      if (isSyntheticPlaidItem(stale)) continue;
      if (isValidPlaidAccessToken(stale.accessToken)) continue;
      scannedMalformed += 1;

      const healthy = userItems.find((other) => {
        if (other.id === stale.id) return false;
        if (isSyntheticPlaidItem(other)) return false;
        if (!isValidPlaidAccessToken(other.accessToken)) return false;
        if (
          stale.institutionId &&
          other.institutionId &&
          stale.institutionId === other.institutionId
        ) {
          return true;
        }
        if (
          stale.institutionSlug &&
          other.institutionSlug &&
          stale.institutionSlug === other.institutionSlug
        ) {
          return true;
        }
        return false;
      });
      if (!healthy) {
        skippedNoHealthySibling += 1;
        continue;
      }

      const key = `${userId}|${healthy.institutionId ?? ""}|${healthy.institutionSlug ?? ""}|${healthy.id}`;
      if (handled.has(key)) continue;
      handled.add(key);

      try {
        const { cleaned } = await cleanupMalformedTokenSiblings({
          userId,
          survivorItemRowId: healthy.id,
          institutionId: healthy.institutionId,
          institutionSlug: healthy.institutionSlug,
        });
        cleanedSiblings += cleaned.length;
      } catch (err) {
        defaultLogger.warn(
          {
            err,
            userId,
            survivorItemRowId: healthy.id,
            staleItemRowId: stale.id,
            institutionName: stale.institutionName,
          },
          "[plaid-malformed-sibling-backfill] cleanup of stale row failed — will retry on next boot",
        );
      }
    }
  }

  return { scannedMalformed, cleanedSiblings, skippedNoHealthySibling };
}
