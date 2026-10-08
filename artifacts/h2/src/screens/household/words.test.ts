import { describe, it, expect } from "vitest";
import type { PlaidItemDetail, PlaidSyncResult } from "@workspace/api-client-react";
import {
  accountLine,
  apiMessage,
  bankErrorWords,
  isReauthCode,
  itemStatus,
  itemsNeedingReconnect,
  lastSyncedWords,
  postLinkWords,
  reconnectReason,
  summarizeSync,
  syncResultWords,
} from "./words";

const item = (over: Partial<PlaidItemDetail> = {}): PlaidItemDetail =>
  ({ id: "i1", itemId: "plaid-1", institutionName: "Sample Bank", institutionSlug: "sample-bank", accounts: [], ...over }) as PlaidItemDetail;

describe("itemStatus — one word per bank", () => {
  it("working", () => expect(itemStatus(item())).toMatchObject({ kind: "ok", word: "Working", detail: null }));
  it("a re-auth code reads Needs reconnect, with the reason", () => {
    const s = itemStatus(item({ lastSyncErrorCode: "ITEM_LOGIN_REQUIRED", lastSyncError: "login required" }));
    expect(s.kind).toBe("reconnect");
    expect(s.word).toBe("Needs reconnect");
    expect(s.detail).toMatch(/login expired/);
  });
  it("a seed row is never asked to reconnect", () => {
    expect(itemStatus(item({ itemId: "seed-1", lastSyncErrorCode: "INVALID_ACCESS_TOKEN" })).kind).not.toBe("reconnect");
    expect(itemsNeedingReconnect([item({ itemId: "seed-1", lastSyncErrorCode: "INVALID_ACCESS_TOKEN" })])).toEqual([]);
  });
  it("preparing, and a stopped feed with the bank's own words (no Plaid: prefix)", () => {
    expect(itemStatus(item({ stillPreparing: true })).word).toBe("Preparing");
    const s = itemStatus(item({ lastSyncError: "Plaid: the bank is down" }));
    expect(s).toMatchObject({ kind: "stopped", word: "Feed stopped", detail: "the bank is down" });
  });
  it("a re-auth wins over preparing", () => {
    expect(itemStatus(item({ stillPreparing: true, lastSyncErrorCode: "PENDING_EXPIRATION" })).kind).toBe("reconnect");
  });
});

describe("words", () => {
  it("re-auth codes", () => {
    for (const c of ["ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "PENDING_DISCONNECT", "INVALID_ACCESS_TOKEN"]) expect(isReauthCode(c)).toBe(true);
    expect(isReauthCode("RATE_LIMIT")).toBe(false);
    expect(isReauthCode(null)).toBe(false);
  });
  it("a dated reason names the day", () => {
    expect(reconnectReason("PENDING_EXPIRATION", { consentExpirationAt: "2026-10-20T17:00:00Z", institutionName: "Sample Bank" })).toBe(
      "Sample Bank will expire on Oct 20. Reconnect to keep it linked.",
    );
  });
  it("last synced and account lines", () => {
    const now = new Date("2026-10-07T15:00:00Z");
    expect(lastSyncedWords(item({ lastSyncedAt: "2026-10-07T14:48:00Z" }), now)).toBe("Synced 12 minutes ago");
    expect(lastSyncedWords(item({ lastSyncedAt: null }), now)).toBe("Not synced yet");
    expect(accountLine({ id: "a", accountId: "x", name: "Checking", mask: "0100", subtype: "checking" })).toBe("Checking · ending 0100 · checking");
    expect(bankErrorWords("")).toBe("The bank did not answer.");
  });
  it("api messages: the server's words, else the fallback", () => {
    expect(apiMessage({ data: { error: "That is 3 test texts today. Try again tomorrow." } }, "x")).toBe("That is 3 test texts today. Try again tomorrow.");
    expect(apiMessage({ status: 403 }, "x")).toMatch(/owner/);
    expect(apiMessage(new Error("boom"), "fallback")).toBe("fallback");
  });
});

describe("the sync result — the new-row count in words", () => {
  const res = (items: Array<Record<string, unknown>>) => ({ items }) as unknown as PlaidSyncResult;
  it("counts across items and names updated rows", () => {
    const s = summarizeSync(res([{ added: 2, modified: 1, removed: 0 }, { added: 1, modified: 0, removed: 3 }]));
    expect(s).toMatchObject({ added: 3, modified: 1, removed: 3 });
    expect(syncResultWords(s)).toBe("3 new, 1 updated");
  });
  it("nothing new, still preparing, and an error", () => {
    expect(syncResultWords(summarizeSync(res([{ added: 0, modified: 0, removed: 0 }])))).toBe("Up to date. No new transactions.");
    expect(syncResultWords(summarizeSync(res([{ added: 0, modified: 0, removed: 0, stillPreparing: true }])))).toMatch(/still preparing/);
    const e = summarizeSync(res([{ added: 0, modified: 0, removed: 0, error: "Plaid: bad login", kind: "reauth" }]));
    expect(e.reauth).toBe(true);
    expect(syncResultWords(e)).toBe("bad login");
  });
  it("a missing result is zero, not a crash", () => expect(summarizeSync(undefined).added).toBe(0));
});

describe("post-link words", () => {
  const base = { attempt: 2, total: 9, bank: "Sample Bank", added: 0, modified: 0, error: null, needsReconnect: false } as const;
  it("each phase", () => {
    expect(postLinkWords({ ...base, phase: "preparing" }).title).toBe("Linked Sample Bank");
    expect(postLinkWords({ ...base, phase: "polling" }).detail).toBe("Checking. Try 2 of 9.");
    expect(postLinkWords({ ...base, phase: "ready", added: 5, modified: 1 }).title).toBe("Ready. 5 added, 1 updated.");
    expect(postLinkWords({ ...base, phase: "ready" }).title).toBe("No new transactions yet");
    expect(postLinkWords({ ...base, phase: "still-preparing" }).title).toBe("Still preparing");
    expect(postLinkWords({ ...base, phase: "error", error: "bad" }).detail).toBe("bad");
  });
  it("a bank that still needs a sign-in is never called ready", () => {
    expect(postLinkWords({ ...base, phase: "ready", added: 5, needsReconnect: true }).title).toBe("Sample Bank still needs reconnecting");
  });
});
