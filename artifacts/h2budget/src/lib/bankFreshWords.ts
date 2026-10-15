import { agoShort } from "@/lib/accountFreshness";

/**
 * (Q5 round 3) HOW FRESH IS THE BANK — ONE SET OF WORDS, ONE INSTANT.
 *
 * Every surface that says how fresh the bank is (the dashboard header, the Banking
 * tile, the Banking page, the balance "Why?") builds its words here, from the
 * SERVER's state (`PlaidItemDetail.freshness`, `spine.bankConfidence`, the review's
 * `freshness`: one rule, they agree). "Updated …" is the server's `fetchedAt` and
 * nothing else; a connection's own time wears a different word ("synced …").
 * Nothing here decides staleness or picks a "later of" instant.
 */
export type FreshKind = "ok" | "stale" | "failed" | "reauth" | "never" | "manual_old";

/** The status, in a few words. "Up to date" is the calm state and is not shown on its own. */
export const FRESH_STATUS: Record<FreshKind, string> = {
  ok: "Up to date",
  stale: "Out of date",
  failed: "Last sync failed",
  reauth: "Needs reconnecting",
  never: "Not synced yet",
  manual_old: "Needs an update",
};

/** The server's stale flag + reason → one kind (an unknown reason is plain "out of date"). */
export function freshKindOf(stale: boolean | undefined, reason: string | null | undefined): FreshKind {
  if (!stale) return "ok";
  if (reason === "refresh_failed") return "failed";
  if (reason === "manual_old") return "manual_old";
  return "stale";
}

/** "Updated 2 h ago" — the server's instant; null when nothing was ever fetched. */
export function updatedWords(fetchedAt: string | null | undefined, now: number): string | null {
  const ago = agoShort(fetchedAt, now);
  return ago ? `Updated ${ago}` : null;
}

export interface BankFresh {
  kind: FreshKind;
  /** Null when the bank is up to date (the calm state says only "Updated …"). */
  status: string | null;
  updated: string | null;
  /** Only a failed sync or a lost connection takes the alarm colour. */
  alarm: boolean;
}

export function bankFreshWords(i: { kind: FreshKind; fetchedAt: string | null | undefined; now: number }): BankFresh {
  return {
    kind: i.kind,
    status: i.kind === "ok" ? null : FRESH_STATUS[i.kind],
    updated: updatedWords(i.fetchedAt, i.now),
    alarm: i.kind === "failed" || i.kind === "reauth",
  };
}
