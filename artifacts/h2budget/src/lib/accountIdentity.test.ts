import { describe, it, expect } from "vitest";
import { cardOrderOf, identityOf } from "./accountIdentity";

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
