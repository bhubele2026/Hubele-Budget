import { describe, it, expect } from "vitest";
import { categoriesByIdOf, isInflowFiledAsExpense, type DirectionTxn } from "./categoryDirection";

// (dash-accuracy) "Income filed under an expense category": an inflow, in an
// expense category, that is not a refund by the shared refund rule.
const cats = categoriesByIdOf([
  { id: "dining", name: "Dining & Coffee", kind: "expense" },
  { id: "pay", name: "Paycheck", kind: "income" },
  { id: "xfer", name: "Transfer", kind: "expense" },
  { id: "visa", name: "Visa", kind: "expense", sourceKind: "auto_debts" },
  { id: "visa2", name: "Visa 2", kind: "expense", debtId: "d2" },
]);
const tx = (o: Partial<DirectionTxn> = {}): DirectionTxn => ({
  amount: "2150.00", source: "plaid:chase", categoryId: "dining", description: "ACME CORP PAYROLL PPD ID 123",
  isTransfer: false, debtId: null, isExternalCardPayment: false, reimbursable: false, pfcDetailed: "INCOME_WAGES", ...o,
});

describe("isInflowFiledAsExpense", () => {
  it("flags a payroll credit filed under Dining & Coffee", () => {
    expect(isInflowFiledAsExpense(tx(), cats)).toBe(true);
    expect(isInflowFiledAsExpense(tx({ pfcDetailed: null, amount: 40 }), cats)).toBe(true);
  });
  it("money out is never flagged", () => {
    expect(isInflowFiledAsExpense(tx({ amount: "-12.40" }), cats)).toBe(false);
    expect(isInflowFiledAsExpense(tx({ amount: "0" }), cats)).toBe(false);
  });
  it("an Amex-workbook row's positive amount is a CHARGE, not an inflow", () => {
    expect(isInflowFiledAsExpense(tx({ source: "amex", amount: "45.00" }), cats)).toBe(false);
  });
  it("a refund (classifyRefund) belongs in its expense category", () => {
    // Money back on a card's own ledger.
    expect(isInflowFiledAsExpense(tx({ source: "plaid:amex", description: "CAFE", pfcDetailed: null }), cats)).toBe(false);
    // A REFUND word on checking.
    expect(isInflowFiledAsExpense(tx({ description: "CAFE REFUND", pfcDetailed: null }), cats)).toBe(false);
    // …but a TAX refund is not money back from a purchase.
    expect(isInflowFiledAsExpense(tx({ description: "IRS TREAS 310 TAX REF", pfcDetailed: null }), cats)).toBe(true);
  });
  it("income, uncategorized, missing, excluded and debt categories are not flagged", () => {
    expect(isInflowFiledAsExpense(tx({ categoryId: "pay" }), cats)).toBe(false);
    expect(isInflowFiledAsExpense(tx({ categoryId: null }), cats)).toBe(false);
    expect(isInflowFiledAsExpense(tx({ categoryId: "deleted" }), cats)).toBe(false);
    expect(isInflowFiledAsExpense(tx({ categoryId: "xfer" }), cats)).toBe(false);
    expect(isInflowFiledAsExpense(tx({ categoryId: "visa" }), cats)).toBe(false);
    expect(isInflowFiledAsExpense(tx({ categoryId: "visa2" }), cats)).toBe(false);
  });
  it("a transfer or a debt-tagged row is not income", () => {
    expect(isInflowFiledAsExpense(tx({ isTransfer: true }), cats)).toBe(false);
    expect(isInflowFiledAsExpense(tx({ debtId: "d1" }), cats)).toBe(false);
  });
  it("is pure: the same row and categories give the same answer, and nothing is mutated", () => {
    const row = tx();
    const before = JSON.stringify(row);
    expect(isInflowFiledAsExpense(row, cats)).toBe(isInflowFiledAsExpense(row, cats));
    expect(JSON.stringify(row)).toBe(before);
    expect(cats.get("visa")!.sourceKind).toBe("auto_debts");
  });
});
