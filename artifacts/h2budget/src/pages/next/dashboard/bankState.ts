import type { PlaidItemDetail } from "@workspace/api-client-react";
import { isPlaidReauthCode, isSyntheticPlaidItem } from "@/components/plaid-reconnect-button";

/** A bank's feed is "out of date" after 36 hours without a successful sync. */
export const STALE_MS = 36 * 60 * 60 * 1000;

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

/** "2 h ago", "3 d ago": short enough for a one-line freshness strip. */
export function agoShort(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const min = Math.floor(Math.max(0, now - t) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export interface BankLine {
  itemId: string;
  institution: string;
  state: AccountState;
  /** "synced 2 h ago", "needs reconnecting", "last sync failed", "not synced yet". */
  words: string;
}

/** One line per linked bank (not per account), in the API's order. Pure. */
export function bankLines(items: readonly PlaidItemDetail[] | undefined, now: number): BankLine[] {
  const out: BankLine[] = [];
  for (const it of items ?? []) {
    if (isSyntheticPlaidItem(it)) continue;
    const state = connectionState(it, now);
    const ago = agoShort(it.lastSyncedAt, now);
    const words =
      state === "reauth" ? "needs reconnecting"
        : state === "failed" ? "last sync failed"
          : state === "never" ? "not synced yet"
            : state === "stale" ? `out of date · synced ${ago}`
              : `synced ${ago}`;
    out.push({ itemId: it.id, institution: (it.institutionName ?? "").trim() || "Bank", state, words });
  }
  return out;
}
