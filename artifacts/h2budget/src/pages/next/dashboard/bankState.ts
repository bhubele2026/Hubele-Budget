import type { PlaidItemDetail } from "@workspace/api-client-react";
import { isPlaidReauthCode, isSyntheticPlaidItem } from "@/components/plaid-reconnect-button";
import { agoShort } from "@/lib/accountFreshness";
import { PLAID_FEED_QUIET_MS } from "@workspace/avalanche-core/freshness";

// (WP3) `agoShort` moved to `lib/accountFreshness.ts` with the account
// freshness stamps; re-exported so existing callers keep their import.
export { agoShort };

/**
 * A bank's feed is "out of date" after 48 hours without a successful sync —
 * the server's own threshold (`computeBankFreshness`), one constant for both
 * (`@workspace/avalanche-core/freshness`). (WP3) It was 36 hours here, so for
 * twelve hours a day this line said "out of date" while the balance beside it
 * was served as fresh.
 */
export const STALE_MS = PLAID_FEED_QUIET_MS;

export type AccountState = "ok" | "stale" | "reauth" | "failed" | "never";

/** The words an account's connection state uses. Reauth reuses the app's own reason copy. */
export function connectionState(item: PlaidItemDetail, now: number): AccountState {
  if (isPlaidReauthCode(item.lastSyncErrorCode)) return "reauth";
  if (item.lastSyncError) return "failed";
  if (!item.lastSyncedAt) return "never";
  return now - Date.parse(item.lastSyncedAt) > STALE_MS ? "stale" : "ok";
}

export const STATE_WORD: Record<AccountState, string> = {
  ok: "Up to date", stale: "Out of date", reauth: "Needs reconnecting", failed: "Last sync failed", never: "Not synced yet",
};

export interface BankLine {
  itemId: string;
  institution: string;
  state: AccountState;
  /** "synced 2 h ago", "needs reconnecting", "last sync failed", "not synced yet". */
  words: string;
}

/** One line per linked bank (not per account), in the API's order. Two items
 *  at the same institution are told apart by their first account's name. Pure. */
export function bankLines(items: readonly PlaidItemDetail[] | undefined, now: number): BankLine[] {
  const out: BankLine[] = [];
  const real = (items ?? []).filter((it) => !isSyntheticPlaidItem(it));
  const seen = new Map<string, number>();
  for (const it of real) {
    const k = (it.institutionName ?? "").trim().toLowerCase();
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const it of real) {
    const state = connectionState(it, now);
    const ago = agoShort(it.lastSyncedAt, now);
    const words =
      state === "reauth" ? "needs reconnecting"
        : state === "failed" ? "last sync failed"
          : state === "never" ? "not synced yet"
            : state === "stale" ? `out of date · synced ${ago}`
              : `synced ${ago}`;
    const inst = (it.institutionName ?? "").trim() || "Bank";
    const first = it.accounts?.[0];
    const shared = (seen.get((it.institutionName ?? "").trim().toLowerCase()) ?? 0) > 1;
    const which = shared && first ? [first.name?.trim(), first.mask ? `••${first.mask.slice(-4)}` : null].filter(Boolean).join(" ") : "";
    out.push({ itemId: it.id, institution: which ? `${inst} ${which}` : inst, state, words });
  }
  return out;
}

/** Whether any real bank is linked (the synthetic workbook item does not count). */
export function hasLinkedBank(items: readonly PlaidItemDetail[] | undefined): boolean {
  return (items ?? []).some((it) => !isSyntheticPlaidItem(it));
}
