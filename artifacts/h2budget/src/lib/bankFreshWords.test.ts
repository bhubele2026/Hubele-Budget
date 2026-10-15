import { describe, it, expect } from "vitest";
import { bankFreshWords, freshKindOf, updatedWords, FRESH_STATUS } from "./bankFreshWords";
import { STATE_WORD } from "@/pages/next/dashboard/bankState";

const NOW = Date.parse("2026-10-14T17:00:00Z");

describe("bank freshness words: one set, one instant", () => {
  it("'Updated' is the server's instant and nothing else; null when never fetched", () => {
    expect(updatedWords("2026-10-14T16:00:00Z", NOW)).toBe("Updated 1 h ago");
    expect(updatedWords(null, NOW)).toBeNull();
  });
  it("the server's stale flag and reason pick the kind; an unknown reason is plain 'out of date'", () => {
    expect(freshKindOf(false, null)).toBe("ok");
    expect(freshKindOf(true, "refresh_failed")).toBe("failed");
    expect(freshKindOf(true, "manual_old")).toBe("manual_old");
    expect(freshKindOf(true, "old")).toBe("stale");
    expect(freshKindOf(true, null)).toBe("stale");
  });
  it("up to date says only 'Updated …'; a failed sync leads with its status and the alarm", () => {
    expect(bankFreshWords({ kind: "ok", fetchedAt: "2026-10-14T16:00:00Z", now: NOW })).toMatchObject({ status: null, updated: "Updated 1 h ago", alarm: false });
    expect(bankFreshWords({ kind: "failed", fetchedAt: "2026-10-04T16:00:00Z", now: NOW })).toMatchObject({ status: "Last sync failed", updated: "Updated 10 d ago", alarm: true });
  });
  it("the header's connection words are the same status words as the tile and the Banking page", () => {
    expect(STATE_WORD.failed).toBe(FRESH_STATUS.failed);
    expect(STATE_WORD.stale).toBe(FRESH_STATUS.stale);
    expect(STATE_WORD.reauth).toBe(FRESH_STATUS.reauth);
  });
});
