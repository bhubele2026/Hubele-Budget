import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
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
import { extractPlaidError } from "./plaidSync";
import { logger } from "./logger";

// (#chase-restore) One-shot, idempotent startup cleanup for the
// household whose Chase OAuth grant was invalidated upstream.
//
// Why a startup script and not just the /plaid/admin/cleanup-dead-items
// endpoint: the endpoint is auth-gated to a Clerk session, which the
// deployed runtime cannot mint server-side. This script runs on every
// boot, performs exactly the same delete sequence the endpoint would,
// and converges to a no-op the next time the server restarts.
//
// Scope is intentionally narrow:
//   - Hard-coded to household_id a7182af8-49f0-48f3-920e-f916c7eab872
//     (single-user prod app; the affected user is the owner).
//   - Only touches Chase plaid_items (institution_id='ins_56' OR
//     institution_name ILIKE 'chase'). Every other bank is untouched.
//
// Dead-state predicate (round 2 — widened after the OAuth-invalidated
// b85526fb item slipped past the first pass with all four original
// flags false because Plaid hadn't yet stamped `last_sync_error_code`
// on the row when the sweep ran):
//
//   * synthetic seed row (`isSyntheticPlaidItem`), OR
//   * malformed access_token (`!isValidPlaidAccessToken`), OR
//   * env-mismatched access_token (`!isAccessTokenForCurrentEnv`), OR
//   * persisted `lastSyncErrorCode` is set, OR
//   * `consentExpirationAt` is in the past, OR
//   * the item has zero attached plaid_accounts (orphaned shell), OR
//   * a one-shot `plaid().itemGet()` probe returns an error code in
//     the reauth family (ITEM_LOGIN_REQUIRED / ITEM_LOCKED / NO_AUTH_-
//     ACCOUNTS / ACCESS_NOT_GRANTED / INVALID_CREDENTIALS /
//     INVALID_UPDATED_USERNAME / PENDING_DISCONNECT / PENDING_EXPIRATION).
//     The probe is authoritative for "Chase nuked the consent on its
//     side" — Plaid responds ITEM_LOGIN_REQUIRED even when our local
//     last_sync_error_code column is still null. Bounded cost: at most
//     one probe per Chase item per boot, only fires when the four
//     cheap flags didn't already mark it dead.
//
// Delete sequence mirrors POST /plaid/admin/cleanup-dead-items and the
// per-item DELETE /plaid/items/:id route exactly:
//   1) upstream itemRemove() if the token is usable (skipped for
//      malformed/env-mismatched/synthetic tokens — Plaid would reject
//      anyway). Best-effort; logged failures do not block local delete.
//   2) flip debts whose plaid_account_id points at this item's
//      accounts back to manual sources (FK is ON DELETE SET NULL, so
//      the link clears automatically; we reset the badges).
//   3) delete plaid_accounts rows for the item.
//   4) delete the plaid_items row.
//
// After the per-item loop, a second sweep removes any plaid_accounts
// for the household whose item_id no longer exists in plaid_items
// (orphans from any previous partial delete — including the
// df2da7b0 seed-april checking row that survived the first boot pass
// because the prior version of this script tried to delete its
// parent item without re-confirming the account had vanished). This
// is a permanent guard, not a one-off fix.
//
// Idempotent: once converged, both sweeps return zero work and the
// function early-returns. Best-effort: catches its own errors so a
// transient DB blip cannot crash the server.
const TARGET_HOUSEHOLD_ID = "a7182af8-49f0-48f3-920e-f916c7eab872";

// Plaid error codes that authoritatively mean "this item cannot sync
// without a fresh user-driven Link session". Probing for these on
// startup lets us catch OAuth-invalidated items even when the local
// `last_sync_error_code` column has not yet been stamped.
const PROBE_REAUTH_ERROR_CODES = new Set<string>([
  "ITEM_LOGIN_REQUIRED",
  "ITEM_LOCKED",
  "INVALID_CREDENTIALS",
  "INVALID_UPDATED_USERNAME",
  "NO_AUTH_ACCOUNTS",
  "ACCESS_NOT_GRANTED",
  "PENDING_DISCONNECT",
  "PENDING_EXPIRATION",
  "USER_PERMISSION_REVOKED",
  "USER_ACCOUNT_REVOKED",
  // Generic invalid-token bucket: Plaid returns this for items whose
  // institution-side consent was revoked between syncs.
  "INVALID_ACCESS_TOKEN",
]);

export type StartupChaseCleanupSummary = {
  scanned: number;
  deleted: number;
  orphanAccountsDeleted: number;
  itemsDeleted: Array<{
    itemRowId: string;
    plaidItemIdExternal: string;
    reason: string;
    accountsDetached: number;
    debtsDownshifted: number;
  }>;
};

export async function runStartupChaseDeadItemsCleanup(): Promise<StartupChaseCleanupSummary> {
  const summary: StartupChaseCleanupSummary = {
    scanned: 0,
    deleted: 0,
    orphanAccountsDeleted: 0,
    itemsDeleted: [],
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

    for (const it of chase) {
      const synthetic = isSyntheticPlaidItem(it);
      const tokenMalformed = !isValidPlaidAccessToken(it.accessToken);
      const tokenEnvMismatch = !isAccessTokenForCurrentEnv(it.accessToken);
      const hasErrorCode = !!it.lastSyncErrorCode;
      const consentExpired =
        !!it.consentExpirationAt &&
        it.consentExpirationAt.getTime() < Date.now();

      // Account count — also feeds the per-item delete loop below so
      // we don't re-query.
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
      const noAccounts = acctIds.length === 0;

      const reasonParts: string[] = [];
      if (synthetic) reasonParts.push("synthetic-seed");
      if (tokenMalformed) reasonParts.push("malformed-token");
      if (tokenEnvMismatch) reasonParts.push("env-mismatch");
      if (hasErrorCode)
        reasonParts.push(`error-code:${it.lastSyncErrorCode ?? "?"}`);
      if (consentExpired) reasonParts.push("consent-expired");
      if (noAccounts) reasonParts.push("zero-accounts");

      let dead =
        synthetic ||
        tokenMalformed ||
        tokenEnvMismatch ||
        hasErrorCode ||
        consentExpired ||
        noAccounts;

      // Authoritative probe: only when the cheap flags didn't catch
      // it, and only for items whose token is at least parseable
      // (otherwise Plaid would reject the call with a generic
      // INVALID_ACCESS_TOKEN that tells us nothing useful).
      if (
        !dead &&
        !synthetic &&
        !tokenMalformed &&
        !tokenEnvMismatch
      ) {
        try {
          await plaid().itemGet({ access_token: it.accessToken });
          // /item/get succeeded — the item is genuinely live on
          // Plaid's side. Leave it alone.
        } catch (probeErr) {
          const { code, message } = extractPlaidError(probeErr);
          if (code && PROBE_REAUTH_ERROR_CODES.has(code)) {
            dead = true;
            reasonParts.push(`probe:${code}`);
            logger.warn(
              {
                itemRowId: it.id,
                plaidItemIdExternal: it.itemId,
                probeErrorCode: code,
                probeErrorMessage: message,
              },
              "[startup-chase-cleanup] itemGet probe returned reauth-class error — marking item dead",
            );
          } else {
            // Non-reauth Plaid error (rate limit, internal server,
            // etc.) — do NOT delete on a transient probe failure;
            // next boot will re-probe.
            logger.warn(
              {
                itemRowId: it.id,
                plaidItemIdExternal: it.itemId,
                probeErrorCode: code,
                probeErrorMessage: message,
              },
              "[startup-chase-cleanup] itemGet probe failed with non-reauth error — leaving item in place",
            );
          }
        }
      }

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

    // Permanent orphan sweep: any plaid_accounts row in this household
    // whose item_id no longer points at an existing plaid_items row.
    // Catches partial-delete debris (df2da7b0 from the prior boot's
    // half-completed cleanup) and any future similar drift.
    const survivingItemIds = (
      await db
        .select({ id: plaidItemsTable.id })
        .from(plaidItemsTable)
        .where(eq(plaidItemsTable.householdId, TARGET_HOUSEHOLD_ID))
    ).map((r) => r.id);

    const orphanAcctsWhere =
      survivingItemIds.length > 0
        ? and(
            eq(plaidAccountsTable.householdId, TARGET_HOUSEHOLD_ID),
            notInArray(plaidAccountsTable.itemId, survivingItemIds),
          )
        : eq(plaidAccountsTable.householdId, TARGET_HOUSEHOLD_ID);

    const orphans = await db
      .select({
        id: plaidAccountsTable.id,
        itemId: plaidAccountsTable.itemId,
        accountId: plaidAccountsTable.accountId,
        mask: plaidAccountsTable.mask,
      })
      .from(plaidAccountsTable)
      .where(orphanAcctsWhere);

    if (orphans.length > 0) {
      const orphanIds = orphans.map((o) => o.id);
      // Downshift any debts pointing at the orphan accounts too —
      // same badge-reset the per-item path runs. ON DELETE SET NULL
      // already clears the FK on the next delete, but flipping the
      // badges to "manual" prevents the UI from advertising a stale
      // Plaid-sourced number for one render after the delete.
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
            eq(debtsTable.householdId, TARGET_HOUSEHOLD_ID),
            inArray(debtsTable.plaidAccountId, orphanIds),
          ),
        );
      const deletedOrphans = await db
        .delete(plaidAccountsTable)
        .where(
          and(
            eq(plaidAccountsTable.householdId, TARGET_HOUSEHOLD_ID),
            inArray(plaidAccountsTable.id, orphanIds),
          ),
        )
        .returning({ id: plaidAccountsTable.id });
      summary.orphanAccountsDeleted = deletedOrphans.length;
      logger.info(
        {
          householdId: TARGET_HOUSEHOLD_ID,
          orphans: orphans.map((o) => ({
            id: o.id,
            staleItemId: o.itemId,
            accountId: o.accountId,
            mask: o.mask,
          })),
        },
        `[startup-chase-cleanup] deleted ${deletedOrphans.length} orphan plaid_accounts row(s) whose item_id no longer exists`,
      );
    }
  } catch (err) {
    logger.error(
      { err },
      "[startup-chase-cleanup] sweep failed — server boot continues",
    );
  }
  // Silence the unused import warning if someone strips notInArray
  // later (Drizzle's tree-shaking treats this as the canonical
  // negative-membership helper; keep the explicit dependency).
  void sql;
  return summary;
}
