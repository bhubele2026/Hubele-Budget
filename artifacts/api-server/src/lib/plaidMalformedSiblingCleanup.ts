import { and, eq, inArray, or, type SQL } from "drizzle-orm";
import {
  db,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import { isAccessTokenForCurrentEnv, isSyntheticPlaidItem } from "./plaid";
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
 * (#406) Local-only cleanup of unusable sibling `plaid_items` rows for a
 * given user + institution. Mirrors the inline block under the (#401)
 * comment in `routes/plaid.ts`: any other row for the same user and
 * institution whose stored access_token is unusable for the current
 * server is treated as a stale leftover from before the upstream guard
 * existed and is removed locally — debt rows pointing at its accounts
 * are reset to manual source, then the accounts and the item itself
 * are deleted. We never touch a healthy sibling, so a user with two
 * legitimate logins for the same institution is left alone.
 *
 * (#659) "Unusable" means EITHER the token fails the format guard
 * (malformed) OR its env-prefix doesn't match the current `PLAID_ENV`
 * (env-mismatch — production scenario where a fresh re-link mints a
 * brand-new `item_id`, so the upsert in `/plaid/exchange` doesn't
 * conflict with the old sandbox-prefixed row and a ghost duplicate
 * lingers in `plaid_items` forever). `isAccessTokenForCurrentEnv`
 * collapses both checks: it requires `isValidPlaidAccessToken` first,
 * then enforces the env match.
 *
 * Skipping the upstream Plaid `/item/remove` is safe because the token
 * is unusable: Plaid would reject it (400 on malformed,
 * INVALID_ACCESS_TOKEN on env-mismatch) anyway, and the only side
 * effect is the local Settings + dashboard banner cleanup we want.
 */
type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function cleanupMalformedTokenSiblings(opts: {
  userId: string;
  // (#659) Required for per-exchange callers so the cleanup is scoped
  // to the household the relink belongs to (per task contract). The
  // backfill scan still resolves household indirectly via the row's
  // own `householdId`. Optional here so the existing callers that
  // already scope by user only (ie tests + backfill) keep working.
  householdId?: string;
  survivorItemRowId: string;
  institutionId: string | null;
  institutionSlug: string | null;
  log?: Logger;
  // (#659) Optional drizzle transaction client. When the caller is
  // already inside `db.transaction(...)` (eg the /plaid/exchange
  // atomic upsert+cleanup block), passing the tx here makes every
  // statement below participate in the same transaction so a failure
  // anywhere rolls back BOTH the survivor insert AND any partial
  // sibling deletes — the user never sees a half-cleaned state.
  tx?: DbClient;
}): Promise<{ cleaned: CleanedSibling[] }> {
  const {
    userId,
    householdId,
    survivorItemRowId,
    institutionId,
    institutionSlug,
  } = opts;
  const log = opts.log ?? defaultLogger;
  const dbc: DbClient = opts.tx ?? db;
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

  // (#659) Per-task contract: cleanup must be scoped to the same
  // household + same institution. When the caller passes
  // `householdId`, prefer it over `userId` so a multi-household /
  // shared-household relink only sweeps orphans inside the right
  // household. We keep `userId` in the WHERE as a defense-in-depth
  // belt: the same user is always a member of the household they
  // re-linked from, and the join keeps the existing test fixtures
  // (which always pair a user with their own household) green.
  const scope: SQL[] = [eq(plaidItemsTable.userId, userId)];
  if (householdId) scope.push(eq(plaidItemsTable.householdId, householdId));
  const sameInstitutionRows = await dbc
    .select()
    .from(plaidItemsTable)
    .where(and(...scope, institutionFilter));

  for (const stale of sameInstitutionRows) {
    if (stale.id === survivorItemRowId) continue;
    if (isSyntheticPlaidItem(stale)) continue;
    // (#659) Treat env-mismatched tokens as unusable too — see the
    // function-level comment. `isAccessTokenForCurrentEnv` is `true`
    // only when the token is well-formed AND its env-prefix matches
    // the current PLAID_ENV, so a sandbox-prefixed token on a
    // production server (or a malformed one) both fall through here.
    if (isAccessTokenForCurrentEnv(stale.accessToken)) continue;

    const staleAccts = await dbc
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
      await dbc
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
    await dbc
      .delete(plaidAccountsTable)
      .where(
        and(
          eq(plaidAccountsTable.itemId, stale.id),
          eq(plaidAccountsTable.userId, userId),
        ),
      );
    await dbc
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
        householdId: householdId ?? null,
        survivorItemRowId,
        cleanedItemRowId: stale.id,
        cleanedPlaidItemIdExternal: stale.itemId,
        institutionName: stale.institutionName,
      },
      "[plaid-malformed-sibling] auto-archived stale unusable-token row",
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
export type BackfillCleanedDetail = {
  userId: string;
  itemRowId: string;
  itemId: string;
  institutionName: string | null;
};

export async function backfillMalformedTokenSiblings(): Promise<{
  scannedMalformed: number;
  cleanedSiblings: number;
  skippedNoHealthySibling: number;
  cleanedDetails: BackfillCleanedDetail[];
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
  const cleanedDetails: BackfillCleanedDetail[] = [];
  // Avoid running the helper twice for the same (user, institution)
  // when two stale rows share an institution — the first call will
  // already sweep both of them via the survivor-driven scan.
  const handled = new Set<string>();

  for (const [userId, userItems] of byUser) {
    for (const stale of userItems) {
      if (isSyntheticPlaidItem(stale)) continue;
      // (#659) Backfill scope mirrors the per-exchange helper above:
      // a stored token is "stale" if it's malformed OR env-mismatched
      // for the current PLAID_ENV. The production Chase ghost row
      // (`access-sandbox-…` on a production server) is the canonical
      // env-mismatch case this widening picks up.
      if (isAccessTokenForCurrentEnv(stale.accessToken)) continue;
      scannedMalformed += 1;

      const healthy = userItems.find((other) => {
        if (other.id === stale.id) return false;
        if (isSyntheticPlaidItem(other)) return false;
        // (#659) The survivor must be a token we could actually sync
        // against — well-formed AND for the current PLAID_ENV.
        if (!isAccessTokenForCurrentEnv(other.accessToken)) return false;
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
        for (const c of cleaned) {
          cleanedDetails.push({
            userId,
            itemRowId: c.itemRowId,
            itemId: c.itemId,
            institutionName: c.institutionName,
          });
        }
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

  return {
    scannedMalformed,
    cleanedSiblings,
    skippedNoHealthySibling,
    cleanedDetails,
  };
}
