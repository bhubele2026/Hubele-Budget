import type { PlaidItemDetail } from "@workspace/api-client-react";
import { cardOrderOf, identityOf, type AccountIdentity } from "@/lib/accountIdentity";
import { findPlaidItemsNeedingReauth } from "@/components/plaid-reauth-banner";

export interface AccountEntry {
  /** External Plaid account_id: the route param and `transaction.plaidAccountId`. */
  plaidAccountId: string;
  /** Internal plaid_accounts row id (what the Chase page and debts key on). */
  rowId: string;
  itemId: string;
  identity: AccountIdentity;
  /** One plain word for the connection: reconnect, problem, synced, never. */
  state: "reconnect" | "problem" | "synced" | "waiting";
  lastSyncedAt: string | null;
  /** Date the newest bank transaction is from, when the API says. */
  dataThrough: string | null;
  /** The item's institution, so a row from an unlinked account of the same bank can be named. */
  institutionName?: string | null;
  institutionSlug?: string | null;
  /** (WP3) The account's last balance reading, never rolled forward (GET /plaid/items). */
  snapshot?: { balance: string; at: string; source: "manual" | "plaid" } | null;
  /**
   * (WP7) A depository account by the server's own rule (`bankLedger.ts`
   * `isDepository`: subtype checking or savings, or type depository), so the
   * account page opens a ledger exactly when the server has one for it.
   */
  depository?: boolean;
}

/** (WP7) Which ledger an account's page opens. */
export type AccountView = "card" | "bank" | "loan" | "other";

/**
 * (WP7) A card opens the card ledger (the Amex page's layout, asking for that
 * card's rows); a checking, savings or other depository account at any bank
 * opens the bank ledger for THAT account (the owner's OK, 2026-10-09); a loan
 * and anything else say in words that H2 has no ledger for them yet.
 */
export function accountViewOf(e: Pick<AccountEntry, "identity" | "depository">): AccountView {
  if (e.identity.isCard) return "card";
  if (e.identity.kind === "checking" || e.identity.kind === "savings" || e.depository) return "bank";
  if (e.identity.kind === "loan") return "loan";
  return "other";
}

/** One entry per linked account, in the API's order. Pure. */
export function buildEntries(items: readonly PlaidItemDetail[] | undefined): AccountEntry[] {
  const list = items ?? [];
  const flat = list.flatMap((it) => (it.accounts ?? []).map((a) => ({ it, a })));
  const cardOrder = cardOrderOf(
    flat.map(({ it, a }) => ({
      id: a.id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype,
      institutionName: it.institutionName, institutionSlug: it.institutionSlug,
    })),
  );
  return flat.map(({ it, a }) => {
    const identity = identityOf(
      {
        id: a.id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype,
        institutionName: it.institutionName, institutionSlug: it.institutionSlug,
      },
      { cardOrder },
    );
    const reauth = findPlaidItemsNeedingReauth([it]).items.length > 0;
    const state: AccountEntry["state"] = reauth
      ? "reconnect"
      : it.lastSyncError
        ? "problem"
        : it.lastSyncedAt
          ? "synced"
          : "waiting";
    return {
      plaidAccountId: a.accountId,
      rowId: a.id,
      itemId: it.id,
      identity,
      state,
      lastSyncedAt: it.lastSyncedAt ?? null,
      dataThrough: it.lastBankTxOn ?? null,
      institutionName: it.institutionName ?? null,
      institutionSlug: it.institutionSlug ?? null,
      snapshot: a.snapshot ?? null,
      depository: a.subtype === "checking" || a.type === "depository" || a.subtype === "savings",
    };
  });
}

export const STATE_WORD: Record<AccountEntry["state"], string> = {
  reconnect: "Needs reconnect",
  problem: "Sync problem",
  synced: "Synced",
  waiting: "Waiting for first sync",
};
