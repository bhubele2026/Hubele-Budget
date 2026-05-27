// (#754) Shared upsert helper for `plaid_accounts` rows.
//
// This file is the single source of truth for "given one Plaid /accounts
// payload entry, materialize the right plaid_accounts row". Two callers
// use it:
//
//   1. POST /plaid/exchange — the link / re-link path. Walks every
//      account in the freshly minted item and persists it.
//   2. POST /plaid/sync (via `refreshPlaidAccountsForItem`) — the
//      "Refresh from Plaid" button. Refreshes the account directory
//      BEFORE `pruneOrphanPlaidTransactionsForHousehold` runs, so a row
//      that was previously deleted by the old dedupe bug gets recreated
//      from Plaid's truth and its historical transactions stop looking
//      like orphans.
//
// The tiered candidate selection is the #754 fix: two physical cards can
// legitimately share a mask under the same institution (e.g. Amex
// Platinum Card® ··1009 and Amex Delta SkyMiles® Gold Card ··1009).
// Matching candidates on mask alone routes the second card's ingest onto
// the first card's row and silently overwrites it. Selection is strictly
// tiered to stay deterministic when the candidate set is mixed:
//   Tier 1 (preferred): incoming has a name AND a candidate's normalized
//     name equals it exactly.
//   Tier 2 (legacy fallback): no Tier 1 hits AND incoming has a name —
//     adopt only candidates whose name is empty (rows that pre-date name
//     capture).
//   Tier 3 (incoming has no name at all): allow every mask match. We
//     can't disambiguate further without a name, and this preserves the
//     legacy re-link path.
import { and, eq } from "drizzle-orm";
import {
  db,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import { plaid } from "./plaid";

export interface PlaidApiAccount {
  account_id: string;
  name?: string | null;
  official_name?: string | null;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
}

export type PlaidAccountUpsertOutcome =
  | "inserted"
  | "updated-same-item"
  | "updated-cross-item"
  | "noop-no-changes";

export interface PlaidAccountUpsertResult {
  outcome: PlaidAccountUpsertOutcome;
  rowId: string;
  accountId: string;
}

interface UpsertOpts {
  householdId: string;
  userId: string;
  itemRowId: string;
  // Resolved institutionName for the target item — used to disambiguate
  // cross-item candidates so we only collapse re-links onto the same
  // institution's prior row.
  institutionName: string | null;
  account: PlaidApiAccount;
}

function normalizeName(name: string | null | undefined): string {
  return (name ?? "").toLowerCase().trim();
}

export async function upsertPlaidAccountFromApi(
  opts: UpsertOpts,
): Promise<PlaidAccountUpsertResult> {
  const { householdId, userId, itemRowId, institutionName, account: a } = opts;

  // Step 1: look for candidates by mask.
  let chosen: { id: string; itemId: string } | null = null;
  if (a.mask) {
    const candidates = await db
      .select({
        id: plaidAccountsTable.id,
        accountId: plaidAccountsTable.accountId,
        itemId: plaidAccountsTable.itemId,
        name: plaidAccountsTable.name,
        officialName: plaidAccountsTable.officialName,
        institutionName: plaidItemsTable.institutionName,
      })
      .from(plaidAccountsTable)
      .leftJoin(
        plaidItemsTable,
        eq(plaidAccountsTable.itemId, plaidItemsTable.id),
      )
      .where(
        and(
          eq(plaidAccountsTable.householdId, householdId),
          eq(plaidAccountsTable.mask, a.mask),
        ),
      );

    const incomingName = normalizeName(a.name ?? a.official_name);
    let candidatesByName: typeof candidates;
    if (incomingName === "") {
      // Tier 3: nameless incoming — allow every mask match.
      candidatesByName = candidates;
    } else {
      const exact = candidates.filter(
        (c) => normalizeName(c.name ?? c.officialName) === incomingName,
      );
      if (exact.length > 0) {
        // Tier 1: prefer exact-name matches.
        candidatesByName = exact;
      } else {
        // Tier 2: fall back to empty-name legacy rows only.
        candidatesByName = candidates.filter(
          (c) => normalizeName(c.name ?? c.officialName) === "",
        );
      }
    }

    const targetInstitution = (institutionName ?? "").toLowerCase();
    const sameItem = candidatesByName.find((c) => c.itemId === itemRowId);
    const crossItem = candidatesByName.find(
      (c) =>
        c.itemId !== itemRowId &&
        (c.institutionName ?? "").toLowerCase() === targetInstitution &&
        targetInstitution !== "",
    );
    const existing = sameItem ?? crossItem ?? null;
    if (existing) {
      await db
        .update(plaidAccountsTable)
        .set({
          itemId: itemRowId,
          accountId: a.account_id,
          name: a.name ?? null,
          officialName: a.official_name ?? null,
          type: a.type ?? null,
          subtype: a.subtype ?? null,
        })
        .where(eq(plaidAccountsTable.id, existing.id));
      chosen = { id: existing.id, itemId: existing.itemId };
      return {
        outcome:
          existing.itemId === itemRowId
            ? "updated-same-item"
            : "updated-cross-item",
        rowId: existing.id,
        accountId: a.account_id,
      };
    }
  }

  // Step 2: nothing matched on (mask, name) — try plain accountId upsert
  // so a re-arrival with the same Plaid account_id (e.g. mask never
  // captured) still collapses onto its row instead of inserting a
  // sibling. The `plaid_accounts_account_uq` unique index makes this
  // safe.
  const inserted = await db
    .insert(plaidAccountsTable)
    .values({
      userId,
      householdId,
      itemId: itemRowId,
      accountId: a.account_id,
      name: a.name ?? null,
      officialName: a.official_name ?? null,
      mask: a.mask ?? null,
      type: a.type ?? null,
      subtype: a.subtype ?? null,
    })
    .onConflictDoUpdate({
      target: plaidAccountsTable.accountId,
      set: {
        itemId: itemRowId,
        name: a.name ?? null,
        officialName: a.official_name ?? null,
        mask: a.mask ?? null,
        type: a.type ?? null,
        subtype: a.subtype ?? null,
      },
    })
    .returning({ id: plaidAccountsTable.id });
  const rowId = inserted[0]?.id ?? "";
  return {
    outcome: chosen ? "updated-same-item" : "inserted",
    rowId,
    accountId: a.account_id,
  };
}

export interface RefreshAccountsResult {
  itemRowId: string;
  upserted: number;
  inserted: number;
  updated: number;
  error: string | null;
}

interface RefreshLogger {
  warn: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
}

/**
 * Refresh the plaid_accounts directory for a single item from Plaid's
 * truth. Idempotent — safe to call on every /plaid/sync click.
 *
 * IMPORTANT: callers must invoke this BEFORE
 * `pruneOrphanPlaidTransactionsForHousehold` so a previously-deleted
 * account row gets recreated and its transactions stop looking like
 * orphans (which the prune would otherwise delete on the next sync).
 *
 * Best-effort: any failure (Plaid error, invalid token, etc.) is logged
 * and swallowed by returning `error`. Callers should NOT fail the whole
 * sync on a refresh failure — transactionsSync can still run for items
 * whose directory is already accurate.
 */
export async function refreshPlaidAccountsForItem(opts: {
  userId: string;
  itemRowId: string;
  logger?: RefreshLogger;
}): Promise<RefreshAccountsResult> {
  const { userId, itemRowId, logger } = opts;
  const result: RefreshAccountsResult = {
    itemRowId,
    upserted: 0,
    inserted: 0,
    updated: 0,
    error: null,
  };
  const [item] = await db
    .select({
      id: plaidItemsTable.id,
      accessToken: plaidItemsTable.accessToken,
      householdId: plaidItemsTable.householdId,
      institutionName: plaidItemsTable.institutionName,
      lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
    })
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.id, itemRowId));
  if (!item) {
    result.error = "item not found";
    return result;
  }
  if (!item.householdId) {
    result.error = "item has no householdId";
    return result;
  }
  if (!item.accessToken) {
    result.error = "item has no accessToken";
    return result;
  }
  // Skip items that are already known to be unreachable. They'll
  // re-enter the upsert path on re-link via /plaid/exchange.
  if (item.lastSyncErrorCode === "INVALID_ACCESS_TOKEN") {
    result.error = "INVALID_ACCESS_TOKEN — skipping account refresh";
    return result;
  }

  let acctResp;
  try {
    acctResp = await plaid().accountsGet({ access_token: item.accessToken });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.error = `accountsGet failed: ${msg}`;
    logger?.warn?.(
      { err: e, plaidItemRowId: itemRowId },
      "[upsertPlaidAccount] accountsGet failed during refresh — directory may stay stale this cycle",
    );
    return result;
  }

  for (const a of acctResp.data.accounts) {
    try {
      const r = await upsertPlaidAccountFromApi({
        householdId: item.householdId,
        userId,
        itemRowId: item.id,
        institutionName: item.institutionName ?? null,
        account: a,
      });
      result.upserted += 1;
      if (r.outcome === "inserted") result.inserted += 1;
      else result.updated += 1;
    } catch (e) {
      logger?.warn?.(
        {
          err: e,
          plaidItemRowId: itemRowId,
          accountId: a.account_id,
          accountName: a.name,
          mask: a.mask,
        },
        "[upsertPlaidAccount] upsert failed for one account — skipping",
      );
    }
  }
  return result;
}
