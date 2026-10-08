// (PR-D) What a row on a card or loan account did to the debt
// (`classifyLiabilityRow`, the classifier `lib/debtLedger.ts` writes with).
import { describe, it, expect } from "vitest";
import { classifyLiabilityRow } from "@workspace/avalanche-core";

const row = (o: Partial<Parameters<typeof classifyLiabilityRow>[0]>) =>
  classifyLiabilityRow({ source: "plaid:visa", amount: 0, description: "", ...o });

describe("classifyLiabilityRow", () => {
  it("Plaid's INTEREST_CHARGE is interest; any other BANK_FEES_* is a fee", () => {
    expect(row({ amount: -61.22, pfcDetailed: "BANK_FEES_INTEREST_CHARGE" })).toEqual({ kind: "interest", amount: 61.22 });
    expect(row({ amount: -29, pfcDetailed: "BANK_FEES_LATE_FEES" })).toEqual({ kind: "fee", amount: 29 });
  });
  it("the description names interest or a finance charge", () => {
    expect(row({ amount: -18.5, description: "PURCHASE INTEREST CHARGE" })).toEqual({ kind: "interest", amount: 18.5 });
    expect(row({ amount: -4.1, description: "Finance Charge" })).toEqual({ kind: "interest", amount: 4.1 });
  });
  it("any other row that raises the debt is a charge", () => {
    expect(row({ amount: -84.12, description: "GROCERY STORE 123" })).toEqual({ kind: "charge", amount: 84.12 });
  });
  it("a row that lowers it is a payment when marked or named as one, else a credit", () => {
    expect(row({ amount: 500, description: "PAYMENT THANK YOU" })).toEqual({ kind: "payment", amount: 500 });
    expect(row({ amount: 250, pfcPrimary: "LOAN_PAYMENTS", description: "ONLINE" })).toEqual({ kind: "payment", amount: 250 });
    expect(row({ amount: 75, isExternalCardPayment: true, description: "X" })).toEqual({ kind: "payment", amount: 75 });
    expect(row({ amount: 34.95, description: "RETURN - SHOE STORE" })).toEqual({ kind: "credit", amount: 34.95 });
  });
  it("an interest reversal lowers the debt: a credit, never negative interest", () => {
    expect(row({ amount: 12, pfcDetailed: "BANK_FEES_INTEREST_CHARGE" })).toEqual({ kind: "credit", amount: 12 });
  });
  it("workbook `amex` rows read positive-as-charge", () => {
    expect(classifyLiabilityRow({ source: "amex", amount: 42.18, description: "CAFE" })).toEqual({ kind: "charge", amount: 42.18 });
    expect(classifyLiabilityRow({ source: "amex", amount: -300, description: "AUTOPAY PAYMENT" })).toEqual({ kind: "payment", amount: 300 });
  });
  it("a zero row is nothing", () => {
    expect(row({ amount: 0 })).toBeNull();
    expect(row({ amount: "0.004" })).toBeNull();
  });
});
