import { describe, it, expect } from "vitest";
import { pickAnchorDebt, type AnchorDebtCandidate } from "./amexAnchor";

// ⭐ (WP2) The Amex anchor writes exactly one debt, or none. It used to match a
// uuid against Plaid's text ids (never equal) and fall through to "the first
// debt named like amex" — any of them.
const d = (o: Partial<AnchorDebtCandidate> & { id: string }): AnchorDebtCandidate => ({
  name: "American Express",
  balance: "500.00",
  plaidAccountId: null,
  balanceSource: "manual",
  ...o,
});

describe("pickAnchorDebt", () => {
  it("the sole debt linked to the Amex rows' account is the one written (a manual decoy named 'Amex' is not)", () => {
    const linked = d({ id: "plat", name: "Platinum", plaidAccountId: "row-plat" });
    const decoy = d({ id: "decoy", name: "Amex" });
    expect(pickAnchorDebt([decoy, linked], ["row-plat"], false)).toEqual({ debt: linked, reason: "linked" });
  });
  it("two linked debts share one combined anchor, which is neither's balance: none is written", () => {
    const blue = d({ id: "blue", plaidAccountId: "row-blue" });
    const plat = d({ id: "plat", plaidAccountId: "row-plat" });
    expect(pickAnchorDebt([blue, plat], ["row-blue", "row-plat"], false)).toEqual({ debt: null, reason: "ambiguous_linked" });
    expect(pickAnchorDebt([blue, plat], ["row-blue", "row-plat"], true).debt).toBeNull();
  });
  it("a balance Plaid owns is never overwritten, unless adopting — and the name match does not step in", () => {
    const plaidOwned = d({ id: "plat", plaidAccountId: "row-plat", balanceSource: "plaid" });
    const decoy = d({ id: "decoy", name: "Amex" });
    expect(pickAnchorDebt([plaidOwned, decoy], ["row-plat"], false)).toEqual({ debt: null, reason: "plaid_owned" });
    expect(pickAnchorDebt([plaidOwned, decoy], ["row-plat"], true)).toEqual({ debt: plaidOwned, reason: "linked" });
  });
  it("no linked debt: the name match, among UNLINKED debts only, and only when it names one", () => {
    const one = d({ id: "amex" });
    const linkedElsewhere = d({ id: "other", name: "Amex Gold", plaidAccountId: "row-gold" });
    expect(pickAnchorDebt([one, linkedElsewhere], [], false)).toEqual({ debt: one, reason: "name" });
    expect(pickAnchorDebt([one, d({ id: "two", name: "AMEX Blue" })], [], false)).toEqual({ debt: null, reason: "ambiguous_name" });
    expect(pickAnchorDebt([linkedElsewhere, d({ id: "visa", name: "Visa" })], [], false)).toEqual({ debt: null, reason: "none" });
  });
  it("the name match also accepts 'American Express' spelled with or without the space", () => {
    expect(pickAnchorDebt([d({ id: "a", name: "AmericanExpress Card" })], [], false).reason).toBe("name");
  });
});
