import { describe, it, expect } from "vitest";
import { identityOf } from "./accountIdentity";
import { displayAmount, formatDisplayAmount } from "./amountDisplay";
const chk = identityOf({ id: "1", type: "depository", subtype: "checking", institutionName: "Chase" });
const amex = identityOf({ id: "2", type: "credit", institutionName: "American Express", institutionSlug: "amex" });
describe("amountDisplay", () => {
  it("checking debit is money out, deposit is a credit", () => {
    expect(formatDisplayAmount(displayAmount("-42.10", chk))).toBe("-$42.10");
    expect(formatDisplayAmount(displayAmount("900", chk))).toBe("+$900.00");
  });
  it("card purchase reads as spending; refund and payment as credits", () => {
    expect(formatDisplayAmount(displayAmount("-180.00", amex))).toBe("-$180.00");
    expect(formatDisplayAmount(displayAmount("20", amex))).toBe("+$20.00");
    expect(formatDisplayAmount(displayAmount("500", amex))).toBe("+$500.00");
  });
  it("junk is zero", () => { expect(displayAmount("x", amex)).toBe(0); });
  it("(dashboard refinement) an Amex WORKBOOK row (source amex) is stored charge-positive: a charge still reads as money out", () => {
    expect(formatDisplayAmount(displayAmount("45.00", amex, "amex"))).toBe("-$45.00");
    expect(formatDisplayAmount(displayAmount("-12.50", amex, "amex"))).toBe("+$12.50");
    expect(formatDisplayAmount(displayAmount("0", amex, "amex"))).toBe("$0.00");
    // A Plaid Amex row keeps the ledger's own sign.
    expect(formatDisplayAmount(displayAmount("-45.00", amex, "plaid:amex"))).toBe("-$45.00");
  });
});
