import type { PlaidItemDetail } from "@workspace/api-client-react";
import { isSyntheticPlaidItem } from "@/lib/plaidReauth";
import { agoShort } from "@/lib/accountFreshness";
import { FRESH_STATUS } from "@/lib/bankFreshWords";

// (WP3) `agoShort` moved to `lib/accountFreshness.ts` with the account
// freshness stamps; re-exported so existing callers keep their import.
export { agoShort };

export type AccountState = "ok" | "stale" | "reauth" | "failed" | "never";

/**
 * (Q5 fix) A bank connection's state is the SERVER's (`PlaidItemDetail.freshness`,
 * computeBankFreshness' rule: needs_reconnect · refresh_failed · never · stale · ok).
 * The browser holds no second rule: it used to read `lastSyncError` / `lastSyncedAt`,
 * which disagreed with the confidence line beside it (a liability refresh error, a
 * transactions success after a balance failure, a webhook-only sync). A connection
 * the server sent no freshness for is "never" (unknown, never green). `now` is unused;
 * the argument stays so callers keep their shape.
 */
export function connectionState(item: PlaidItemDetail, _now?: number): AccountState {
  switch (item.freshness?.state) {
    case "needs_reconnect": return "reauth";
    case "refresh_failed": return "failed";
    case "stale": return "stale";
    case "ok": return "ok";
    default: return "never";
  }
}

/** (Round 3) The words are `lib/bankFreshWords`' — one set for the header, the tile and the Banking page. */
export const STATE_WORD: Record<AccountState, string> = {
  ok: FRESH_STATUS.ok, stale: FRESH_STATUS.stale, reauth: FRESH_STATUS.reauth, failed: FRESH_STATUS.failed, never: FRESH_STATUS.never,
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
    // (Round 3) The connection's own time wears its own word, "synced": "Updated …" is the balance line's (the server's
    // fetchedAt for the checking balance, which a typed balance keeps at its own time).
    const ago = agoShort(it.freshness?.fetchedAt ?? null, now);
    const words =
      state === "ok" ? (ago ? `synced ${ago}` : STATE_WORD.ok.toLowerCase())
        : state === "stale" ? `${STATE_WORD.stale.toLowerCase()}${ago ? ` · synced ${ago}` : ""}`
          : STATE_WORD[state].toLowerCase();
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
