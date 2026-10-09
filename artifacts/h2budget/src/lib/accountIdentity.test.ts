import { describe, it, expect } from "vitest";
import { cardOrderOf, identityOf, resolveTxnAccount, type TxnAccountEntry } from "./accountIdentity";

const base = { id: "a", name: null, mask: null, type: null, subtype: null, institutionName: null, institutionSlug: null, liabilityKind: null };

describe("identityOf", () => {
  it("Chase checking is navy and not a card", () => {
    const i = identityOf({ ...base, name: "Total Checking", mask: "4821", type: "depository", subtype: "checking", institutionName: "Chase", institutionSlug: "chase" });
    expect(i).toMatchObject({ kind: "checking", accent: "checking", isCard: false, mask4: "4821", label: "Chase Total Checking", shortLabel: "Total Checking" });
  });
  it("Amex credit is teal-green by slug", () => {
    const i = identityOf({ ...base, name: "Platinum", mask: "1005", type: "credit", subtype: "credit card", institutionName: "American Express", institutionSlug: "amex" });
    expect(i).toMatchObject({ kind: "amex", accent: "amex", isCard: true });
  });
  it("Amex is detected by institution name alone", () => {
    expect(identityOf({ ...base, type: "credit", institutionName: "American Express" }).kind).toBe("amex");
  });
  it("other cards take card2 first, then other, by first appearance", () => {
    const a = { ...base, id: "c1", type: "credit", institutionName: "Chase", name: "Freedom" };
    const b = { ...base, id: "c2", type: "credit", institutionName: "Citi", name: "Double Cash" };
    const order = cardOrderOf([b, a, b]);
    expect(order).toEqual(["c2", "c1"]);
    expect(identityOf(b, { cardOrder: order }).accent).toBe("card2");
    expect(identityOf(a, { cardOrder: order }).accent).toBe("other");
    expect(identityOf(a, { cardOrder: order }).isCard).toBe(true);
  });
  it("de-duplicates the institution already in the name", () => {
    expect(identityOf({ ...base, name: "Chase Savings", institutionName: "Chase", subtype: "savings", type: "depository" }).label).toBe("Chase Savings");
  });
  it("null mask and null name still give a non-empty label", () => {
    const i = identityOf({ ...base });
    expect(i.label).toBe("Account");
    expect(i.shortLabel).toBe("Account");
    expect(i.mask4).toBe("");
    expect(i.kind).toBe("other");
    expect(i.accent).toBe("other");
  });
  it("mask keeps only the last four digits; loans and savings are not cards", () => {
    expect(identityOf({ ...base, mask: "x-00012345" }).mask4).toBe("2345");
    expect(identityOf({ ...base, type: "loan", liabilityKind: "mortgage" })).toMatchObject({ kind: "loan", isCard: false });
    expect(identityOf({ ...base, type: "depository", subtype: "savings" }).kind).toBe("savings");
  });
});

describe("resolveTxnAccount (dash-accuracy)", () => {
  const chase = identityOf({ ...base, id: "row-1", name: "Total Checking", mask: "5526", type: "depository", subtype: "checking", institutionName: "Chase", institutionSlug: "chase" });
  const plat = identityOf({ ...base, id: "row-2", name: "Platinum", mask: "1005", type: "credit", subtype: "credit card", institutionName: "American Express", institutionSlug: "amex" });
  const entries: TxnAccountEntry[] = [
    { plaidAccountId: "ext-chase", identity: chase, institutionName: "Chase", institutionSlug: "chase" },
    { plaidAccountId: "ext-plat", identity: plat, institutionName: "American Express", institutionSlug: "amex" },
  ];
  const byExt = new Map(entries.map((e) => [e.plaidAccountId, e]));

  it("matches on Plaid's EXTERNAL account_id, from an array or a map", () => {
    for (const list of [entries, byExt]) {
      const r = resolveTxnAccount({ plaidAccountId: "ext-chase", source: "plaid:chase" }, list);
      expect(r).toMatchObject({ known: true, label: "Chase Total Checking", mask4: "5526", accent: "checking", id: "row-1" });
      expect(resolveTxnAccount({ plaidAccountId: "ext-plat", source: "plaid:amex" }, list)).toMatchObject({ known: true, kind: "amex", accent: "amex" });
    }
  });
  it("the INTERNAL row id is not a transaction's account id and never matches", () => {
    const r = resolveTxnAccount({ plaidAccountId: "row-1", source: "plaid:chase" }, byExt);
    expect(r.known).toBe(false);
    expect(r.label).toBe("Chase (no longer linked)");
  });
  it("falls back by source, honestly", () => {
    expect(resolveTxnAccount({ plaidAccountId: null, source: "amex" }, byExt)).toMatchObject({ known: false, label: "Amex (imported)", kind: "amex", accent: "amex", isCard: true, mask4: "" });
    expect(resolveTxnAccount({ source: "manual", account: "Chase" }, byExt)).toMatchObject({ known: false, label: "Manual entry", accent: "other" });
    expect(resolveTxnAccount({ plaidAccountId: "ext-old", source: "plaid:amex" }, byExt)).toMatchObject({ known: false, label: "American Express (no longer linked)", kind: "amex" });
    expect(resolveTxnAccount({ plaidAccountId: "x", source: "xlsx" }, byExt)).toMatchObject({ known: false, label: "Unknown account" });
    expect(resolveTxnAccount({}, [])).toMatchObject({ known: false, label: "Unknown account" });
  });
  it("names an unlinked bank from the slug when no linked account shares it", () => {
    expect(resolveTxnAccount({ plaidAccountId: "z", source: "plaid:wells-fargo" }, []).label).toBe("Wells Fargo (no longer linked)");
    expect(resolveTxnAccount({ plaidAccountId: "z", source: "plaid:chase" }, []).label).toBe("Chase (no longer linked)");
    expect(resolveTxnAccount({ plaidAccountId: "z", source: "PLAID:Chase" }, entries).label).toBe("Chase (no longer linked)");
  });
  it("free-text `account` is never trusted as an identity", () => {
    expect(resolveTxnAccount({ plaidAccountId: null, source: null, account: "Chase Total Checking" }, entries).label).toBe("Unknown account");
  });
});
