import { describe, it, expect } from "vitest";
import { isUncategorizedSpendRow, spendAmountOf, type SpendRow } from "./uncategorizedSpend";

// (PR7) The Recategorize popover runs the server's rule. These rows used to
// be listed by the browser's own copy of the bank-noise patterns.

const row = (over: Partial<SpendRow> = {}): SpendRow => ({
  amount: "-42.00",
  source: "plaid:chase",
  isTransfer: false,
  categoryId: null,
  description: "FARMERS MARKET",
  debtId: null,
  isExternalCardPayment: false,
  reimbursable: false,
  pfcDetailed: null,
  ...over,
});

describe("isUncategorizedSpendRow — the popover's rows are the server's rows", () => {
  it.each([
    ["an uncategorized purchase", row(), true],
    ["a card payment by description", row({ description: "CAPITAL ONE CRCARDPMT 5KX9" }), false],
    ["a card payment with punctuation", row({ description: "SYNCHRONY BANK/PAYPAL" }), false],
    ["a card payment Plaid classified", row({ description: "PAYMENT 88231", pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" }), false],
    ["a flagged external card payment", row({ isExternalCardPayment: true }), false],
    ["a transfer", row({ isTransfer: true }), false],
    ["a reimbursable charge", row({ reimbursable: true }), false],
    ["a debt-tagged payment", row({ debtId: "debt-1" }), false],
    ["bank noise", row({ description: "ONLINE TRANSFER TO SAV ...8801" }), false],
    ["an inflow", row({ amount: "42.00" }), false],
    ["a purchase whose category was deleted", row({ categoryId: "gone" }), true],
  ])("%s", (_label, r, expected) => {
    expect(isUncategorizedSpendRow(r, ["groceries"])).toBe(expected);
  });

  it("a row in a live category is not uncategorized", () => {
    expect(isUncategorizedSpendRow(row({ categoryId: "groceries" }), ["groceries"])).toBe(false);
  });

  it("sorts by the server's spend magnitude (a manual Amex charge is positive)", () => {
    expect(spendAmountOf({ amount: "-12.50", source: "plaid:amex" })).toBe(12.5);
    expect(spendAmountOf({ amount: "12.50", source: "amex" })).toBe(12.5);
  });
});
