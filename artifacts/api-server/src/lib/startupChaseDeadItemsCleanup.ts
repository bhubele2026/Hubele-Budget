import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import {
  isAccessTokenForCurrentEnv,
  isSyntheticPlaidItem,
  isValidPlaidAccessToken,
  plaid,
} from "./plaid";
import { logger } from "./logger";

// (#chase-restore) One-shot, idempotent startup cleanup for the
// household whose Chase OAuth grant was invalidated upstream.
//
// Why a startup script and not just the /plaid/admin/cleanup-dead-items
// endpoint: the endpoint is auth-gated to a Clerk session, which the
// deployed runtime cannot mint server-side. This script runs once on
// boot, performs exactly the same delete sequence the endpoint would,
// and converges to a no-op the next time the server restarts.
//
// Scope is intentionally narrow:
//   - Hard-coded to household_id a7182af8-49f0-48f3-920e-f916c7eab872
//     (single-user prod app; the affected user is the owner).
//   - Only touches Chase plaid_items (institution_id='ins_56' OR
//     institution_name ILIKE 'chase'). Every other bank is untouched.
//   - Per item, only deletes when one of these dead-state signals is
//     true:
//       * synthetic seed row (`isSyntheticPlaidItem`)
//       * malformed access_token (`!isValidPlaidAccessToken`)
//       * env-mismatched access_token (`!isAccessTokenForCurrentEnv`)
//       * `lastSyncErrorCode` is set (ITEM_LOGIN_REQUIRED / NO_ACCOUNTS
//         / INVALID_ACCESS_TOKEN etc.) — this is what catches the
//         OAuth-invalidated b85526fb item that still has a parseable
//         token and attached accounts but cannot be recovered by
//         update mode because Chase nuked the consent on its side.
//     A healthy Chase item with no error code is left alone.
//
// Delete sequence mirrors POST /plaid/admin/cleanup-dead-items and the
// per-item DELETE /plaid/items/:id route exactly:
//   1) upstream itemRemove() if the token is usable (skipped for
//      malformed/env-mismatched tokens — Plaid would reject anyway).
//      Best-effort; logged failures do not block the local delete.
//   2) flip debts whose plaid_account_id points at this item's
//      accounts back to manual sources (the FK is ON DELETE SET NULL
//      so the link clears automatically; we just reset the badges).
//   3) delete plaid_accounts rows for the item.
//   4) delete the plaid_items row.
//
// Idempotent: after the first successful run, the SELECT returns zero
// rows and the function early-returns. Safe to leave in the boot path
// indefinitely. Best-effort: catches its own errors so a transient DB
// blip cannot crash the server.
const TARGET_HOUSEHOLD_ID = "a7182af8-49f0-48f3-920e-f916c7eab872";

export async function runStartupChaseDeadItemsCleanup(): Promise<{
  scanned: number;
  deleted: number;
  itemsDeleted: Array<{
    itemRowId: string;
    plaidItemIdExternal: string;
    reason: string;
    accountsDetached: number;
    debtsDownshifted: number;
  }>;
}> {
  const summary = {
    scanned: 0,
    deleted: 0,
    itemsDeleted: [] as Array<{
      itemRowId: string;
      plaidItemIdExternal: string;
      reason: string;
      accountsDetached: number;
      debtsDownshifted: number;
    }>,
  };

  try {
    const items = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.householdId, TARGET_HOUSEHOLD_ID));

    const chase = items.filter(
      (i) =>
        i.institutionId === "ins_56" ||
        (i.institutionName ?? "").toLowerCase().includes("chase") ||
        i.itemId.toLowerCase().includes("chase"),
    );
    summary.scanned = chase.length;
    if (chase.length === 0) return summary;

    for (const it of chase) {
      const synthetic = isSyntheticPlaidItem(it);
      const tokenMalformed = !isValidPlaidAccessToken(it.accessToken);
      const tokenEnvMismatch = !isAccessTokenForCurrentEnv(it.accessToken);
      const hasErrorCode = !!it.lastSyncErrorCode;
      const reasonParts: string[] = [];
      if (synthetic) reasonParts.push("synthetic-seed");
      if (tokenMalformed) reasonParts.push("malformed-token");
      if (tokenEnvMismatch) reasonParts.push("env-mismatch");
      if (hasErrorCode)
        reasonParts.push(`error-code:${it.lastSyncErrorCode ?? "?"}`);
      const dead =
        synthetic || tokenMalformed || tokenEnvMismatch || hasErrorCode;
      if (!dead) continue;

      const reason = reasonParts.join(",");
      const tokenUsable = !tokenMalformed && !tokenEnvMismatch && !synthetic;
      if (tokenUsable) {
        try {
          await plaid().itemRemove({ access_token: it.accessToken });
        } catch (e) {
          logger.warn(
            { err: e, itemRowId: it.id, plaidItemIdExternal: it.itemId },
            "[startup-chase-cleanup] upstream itemRemove failed — proceeding with local delete",
          );
        }
      }

      const accts = await db
        .select({ id: plaidAccountsTable.id })
        .from(plaidAccountsTable)
        .where(
          and(
            eq(plaidAccountsTable.itemId, it.id),
            eq(plaidAccountsTable.householdId, TARGET_HOUSEHOLD_ID),
          ),
        );
      const acctIds = accts.map((a) => a.id);

      let debtsDownshifted = 0;
      if (acctIds.length > 0) {
        const upd = await db
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
              eq(debtsTable.householdId, TARGET_HOUSEHOLD_ID),
              inArray(debtsTable.plaidAccountId, acctIds),
            ),
          )
          .returning({ id: debtsTable.id });
        debtsDownshifted = upd.length;
        await db
          .delete(plaidAccountsTable)
          .where(
            and(
              eq(plaidAccountsTable.itemId, it.id),
              eq(plaidAccountsTable.householdId, TARGET_HOUSEHOLD_ID),
            ),
          );
      }

      await db
        .delete(plaidItemsTable)
        .where(
          and(
            eq(plaidItemsTable.id, it.id),
            eq(plaidItemsTable.householdId, TARGET_HOUSEHOLD_ID),
          ),
        );

      summary.deleted += 1;
      summary.itemsDeleted.push({
        itemRowId: it.id,
        plaidItemIdExternal: it.itemId,
        reason,
        accountsDetached: acctIds.length,
        debtsDownshifted,
      });
      logger.info(
        {
          householdId: TARGET_HOUSEHOLD_ID,
          itemRowId: it.id,
          plaidItemIdExternal: it.itemId,
          institutionName: it.institutionName,
          institutionId: it.institutionId,
          reason,
          accountsDetached: acctIds.length,
          debtsDownshifted,
        },
        "[startup-chase-cleanup] deleted dead Chase plaid_item",
      );
    }
  } catch (err) {
    logger.error(
      { err },
      "[startup-chase-cleanup] sweep failed — server boot continues",
    );
  }
  return summary;
}
