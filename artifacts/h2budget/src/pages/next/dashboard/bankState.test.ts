import { describe, it, expect } from "vitest";
import { bankLines, connectionState } from "./bankState";

/**
 * (Q5 fix) A bank's dot and words are the SERVER's freshness (`PlaidItemDetail.freshness`), never the web's own
 * reading of lastSyncError / lastSyncedAt. Synthetic items.
 */
const NOW = Date.parse("2026-10-14T17:00:00Z");
const fresh = (state: string, o: Record<string, unknown> = {}) => ({
  state, stale: state !== "ok", staleReason: state === "stale" ? "old" : state === "refresh_failed" || state === "needs_reconnect" ? "refresh_failed" : null,
  fetchedAt: "2026-10-14T16:00:00Z", lastContactAt: "2026-10-14T16:00:00Z", lastFailureAt: null, ...o,
});
const item = (o: Record<string, unknown> = {}) =>
  ({ id: "i1", itemId: "pi-1", institutionName: "Chase", institutionSlug: "chase", lastSyncedAt: "2026-10-14T16:00:00Z", lastSyncError: null, lastSyncErrorCode: null, accounts: [], ...o }) as never;

describe("bank state is the server's freshness", () => {
  it("(a) never synced by the web's old reading (lastSyncedAt null) but the server heard from the bank: fine, synced 1 h ago", () => {
    const it = item({ lastSyncedAt: null, freshness: fresh("ok") });
    expect(connectionState(it, NOW)).toBe("ok");
    expect(bankLines([it], NOW)[0]).toMatchObject({ state: "ok", words: "synced 1 h ago" });
  });
  it("(b) a liability refresh wrote lastSyncError while the balance feed is fine: not 'last sync failed'", () => {
    const it = item({ lastSyncError: "Liability refresh failed: timeout", freshness: fresh("ok") });
    expect(connectionState(it, NOW)).toBe("ok");
    expect(bankLines([it], NOW)[0]!.words).toBe("synced 1 h ago");
  });
  it("(c) an unrecovered balance failure whose lastSyncError a later transactions success cleared: still failed, never green", () => {
    const it = item({ lastSyncError: null, freshness: fresh("refresh_failed") });
    expect(connectionState(it, NOW)).toBe("failed");
    expect(bankLines([it], NOW)[0]).toMatchObject({ state: "failed", words: "last sync failed" });
  });
  it("needs_reconnect, stale and never read from the state, not the error code", () => {
    expect(bankLines([item({ freshness: fresh("needs_reconnect") })], NOW)[0]).toMatchObject({ state: "reauth", words: "needs reconnecting" });
    expect(bankLines([item({ freshness: fresh("stale", { fetchedAt: "2026-10-11T16:00:00Z" }) })], NOW)[0]!.words).toBe("out of date · synced 3 d ago");
    expect(bankLines([item({ freshness: fresh("never", { fetchedAt: null }) })], NOW)[0]).toMatchObject({ state: "never", words: "not synced yet" });
  });
  it("a connection the server sent no freshness for is unknown, never green", () => {
    expect(connectionState(item(), NOW)).toBe("never");
  });
});
