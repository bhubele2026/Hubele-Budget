import { describe, it, expect } from "vitest";
import type { Spine } from "@workspace/api-client-react";
import { bankBalanceView, entriesWord, isSpineAccount, sinceSnapshotWords, snapshotWords } from "./bankBalance";

// Brad's live case (2026-10-09): Chase read $2,156.55 on the dashboard and
// $3,458.98 on the account selector — the Oct 2 snapshot, with 20 entries
// rolled on top of it since.
const ACCOUNT = { rowId: "row-chk", externalId: "ext-chk", name: "Total Checking", mask: "5526", subtype: "checking", via: "pointer" as const };
const bank = (o: Partial<Spine["bank"]> = {}): Spine["bank"] => ({
  balance: "2156.55",
  asOfDate: "2026-10-02T19:00:00.000Z",
  source: "plaid",
  lastContactAt: "2026-10-09T13:00:00.000Z",
  lastFailureAt: null,
  stale: false,
  staleReason: null,
  snapshot: { balance: "3458.98", at: "2026-10-02T19:00:00.000Z", source: "plaid" },
  sinceSnapshot: { net: "-1302.43", count: 20, through: "2026-10-09" },
  account: ACCOUNT,
  ...o,
});

describe("bankBalanceView — reads the spine, computes nothing", () => {
  it("the balance today, the snapshot under it (with its household day), what rolled since, and whose account", () => {
    expect(bankBalanceView(bank())).toEqual({
      balance: "2156.55",
      snapshot: { balance: "3458.98", at: "2026-10-02T19:00:00.000Z", day: "2026-10-02", source: "plaid" },
      since: { net: "-1302.43", count: 20, through: "2026-10-09" },
      account: ACCOUNT,
    });
  });

  it("the snapshot day is the household's (America/Chicago), not UTC's: a 9pm Central read is that day", () => {
    const at = "2026-10-03T02:00:00.000Z"; // Fri Oct 2, 9pm Central
    expect(bankBalanceView(bank({ snapshot: { balance: "1.00", at, source: "manual" } })).snapshot!.day).toBe("2026-10-02");
  });

  it("no bank balance at all: balance is null (words on screen, never $0.00)", () => {
    const v = bankBalanceView(bank({ balance: "0.00", asOfDate: null, source: null, snapshot: null, sinceSnapshot: null }));
    expect(v.balance).toBeNull();
    expect(v.snapshot).toBeNull();
    expect(v.since).toBeNull();
  });

  it("a real zero balance stays a zero", () => {
    expect(bankBalanceView(bank({ balance: "0.00" })).balance).toBe("0.00");
  });

  it("an unresolved account is no account", () => {
    const v = bankBalanceView(bank({ account: { rowId: null, externalId: null, name: null, mask: null, subtype: null, via: "unresolved" } }));
    expect(v.account).toBeNull();
  });

  it("a payload from before the spine carried the halves reads as 'not known', never a crash or a zero", () => {
    const old = { ...bank() } as Partial<Spine["bank"]>;
    delete old.snapshot;
    delete old.sinceSnapshot;
    delete old.account;
    const v = bankBalanceView(old as Spine["bank"]);
    expect(v).toMatchObject({ balance: "2156.55", snapshot: null, since: null, account: null });
  });
});

describe("isSpineAccount — by id, never by an empty or shared mask", () => {
  const chk = { id: "row-chk", accountId: "ext-chk", mask: "5526" };
  const savings = { id: "row-sav", accountId: "ext-sav", mask: "7001" };
  const noMaskA = { id: "row-a", accountId: "ext-a", mask: null };
  const noMaskB = { id: "row-b", accountId: "ext-b", mask: "" };
  const all = [chk, savings, noMaskA, noMaskB];

  it("matches the row id or the Plaid account_id the spine names", () => {
    expect(isSpineAccount(chk, ACCOUNT, all)).toBe(true);
    expect(isSpineAccount({ id: "row-chk" }, { rowId: "row-chk", externalId: null, mask: null }, all)).toBe(true);
    expect(isSpineAccount({ accountId: "ext-chk" }, { rowId: null, externalId: "ext-chk", mask: null }, all)).toBe(true);
    expect(isSpineAccount(savings, ACCOUNT, all)).toBe(false);
  });

  it("⭐ the old bug: an account with no mask is not the checking account because the spine's mask is empty too", () => {
    const maskless = { ...ACCOUNT, mask: null };
    expect(isSpineAccount(noMaskA, maskless, all)).toBe(false);
    expect(isSpineAccount(noMaskB, { ...ACCOUNT, mask: "" }, all)).toBe(false);
  });

  it("with ids present, a shared mask never decides (a duplicate-mask twin is not the account)", () => {
    const twin = { id: "row-twin", accountId: "ext-twin", mask: "5526" };
    expect(isSpineAccount(twin, ACCOUNT, [...all, twin])).toBe(false);
    expect(isSpineAccount(chk, ACCOUNT, [...all, twin])).toBe(true);
  });

  it("no ids at all: a non-empty mask decides only when exactly one account carries it", () => {
    const noIds = { rowId: null, externalId: null, mask: "5526" };
    expect(isSpineAccount(chk, noIds, all)).toBe(true);
    const twin = { id: "row-twin", accountId: "ext-twin", mask: "5526" };
    expect(isSpineAccount(chk, noIds, [...all, twin])).toBe(false);
    expect(isSpineAccount(twin, noIds, [...all, twin])).toBe(false);
    expect(isSpineAccount(noMaskA, { rowId: null, externalId: null, mask: null }, all)).toBe(false);
    expect(isSpineAccount(noMaskB, { rowId: null, externalId: null, mask: "" }, all)).toBe(false);
  });

  it("no spine account: nothing matches", () => {
    expect(isSpineAccount(chk, null, all)).toBe(false);
    expect(isSpineAccount(chk, undefined, all)).toBe(false);
  });
});

describe("the words", () => {
  it("entriesWord", () => {
    expect(entriesWord(1)).toBe("1 entry");
    expect(entriesWord(20)).toBe("20 entries");
  });

  it("sinceSnapshotWords: why the balance is not the bank's figure", () => {
    expect(sinceSnapshotWords(bankBalanceView(bank()))).toBe("Includes 20 entries since the Oct 2 snapshot");
    expect(sinceSnapshotWords(bankBalanceView(bank({ sinceSnapshot: { net: "-4.00", count: 1, through: "2026-10-09" } })))).toBe(
      "Includes 1 entry since the Oct 2 snapshot",
    );
    expect(sinceSnapshotWords(bankBalanceView(bank({ sinceSnapshot: { net: "0.00", count: 0, through: "2026-10-09" } })))).toBeNull();
    expect(sinceSnapshotWords(bankBalanceView(bank({ snapshot: null, sinceSnapshot: null })))).toBeNull();
  });

  it("snapshotWords: the bank's own figure, dated, beside the balance today", () => {
    expect(snapshotWords(bankBalanceView(bank()))).toBe("Snapshot $3,458.98 · Oct 2 · +20 entries");
    expect(snapshotWords(bankBalanceView(bank({ sinceSnapshot: { net: "0.00", count: 0, through: "2026-10-09" } })))).toBe(
      "Snapshot $3,458.98 · Oct 2",
    );
    // A real zero snapshot is $0.00; no snapshot is no words (never $0.00).
    expect(snapshotWords(bankBalanceView(bank({ snapshot: { balance: "0.00", at: "2026-10-02T19:00:00.000Z", source: "manual" } })))).toBe(
      "Snapshot $0.00 · Oct 2 · +20 entries",
    );
    expect(snapshotWords(bankBalanceView(bank({ snapshot: null, sinceSnapshot: null })))).toBeNull();
  });
});
