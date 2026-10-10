import { describe, it, expect } from "vitest";
import type { PlaidItemDetail } from "@workspace/api-client-react";
import {
  accountTypesOf,
  categoriesByIdOf,
  directionConflictOfTxn,
  isCardTxn,
  isInflowFiledAsExpense,
  type DirectionTxn,
} from "./categoryDirection";

// (dash-accuracy) "Income filed under an expense category": an inflow, in an
// expense category, that is not a refund by the shared refund rule.
// (WP5c) Now the shared direction rule itself (`categoryDirectionConflict`,
// avalanche-core), with card-ness from the account type: a card's credit is
// never flagged, whichever bank issued the card.
const cats = categoriesByIdOf([
  { id: "dining", name: "Dining & Coffee", kind: "expense" },
  { id: "pay", name: "Paycheck", kind: "income" },
  { id: "xfer", name: "Transfer", kind: "expense" },
  { id: "visa", name: "Visa", kind: "expense", sourceKind: "auto_debts" },
  { id: "visa2", name: "Visa 2", kind: "expense", debtId: "d2" },
  { id: "uncat", name: "Uncategorized", kind: "expense" },
]);
const tx = (o: Partial<DirectionTxn> = {}): DirectionTxn => ({
  amount: "2150.00", source: "plaid:chase", categoryId: "dining", description: "ACME CORP PAYROLL PPD ID 123",
  isTransfer: false, debtId: null, isExternalCardPayment: false, reimbursable: false, pfcDetailed: "INCOME_WAGES", ...o,
});
const CHK = { isCardAccount: false } as const;
const CARD = { isCardAccount: true } as const;

describe("isInflowFiledAsExpense", () => {
  it("flags a payroll credit filed under Dining & Coffee", () => {
    expect(isInflowFiledAsExpense(tx(), cats, CHK)).toBe(true);
    expect(isInflowFiledAsExpense(tx({ pfcDetailed: null, amount: 40 }), cats, CHK)).toBe(true);
  });
  it("money out is never flagged", () => {
    expect(isInflowFiledAsExpense(tx({ amount: "-12.40" }), cats, CHK)).toBe(false);
    expect(isInflowFiledAsExpense(tx({ amount: "0" }), cats, CHK)).toBe(false);
  });
  it("an Amex-workbook row's positive amount is a CHARGE, not an inflow", () => {
    expect(isInflowFiledAsExpense(tx({ source: "amex", amount: "45.00" }), cats, CHK)).toBe(false);
  });
  it("a refund (classifyRefund) belongs in its expense category", () => {
    // Money back on a card's own ledger.
    expect(isInflowFiledAsExpense(tx({ source: "plaid:amex", description: "CAFE", pfcDetailed: null }), cats, CHK)).toBe(false);
    // A REFUND word on checking.
    expect(isInflowFiledAsExpense(tx({ description: "CAFE REFUND", pfcDetailed: null }), cats, CHK)).toBe(false);
    // …but a TAX refund is not money back from a purchase.
    expect(isInflowFiledAsExpense(tx({ description: "IRS TREAS 310 TAX REF", pfcDetailed: null }), cats, CHK)).toBe(true);
  });
  it("income, uncategorized, missing, excluded and debt categories are not flagged", () => {
    expect(isInflowFiledAsExpense(tx({ categoryId: "pay" }), cats, CHK)).toBe(false);
    expect(isInflowFiledAsExpense(tx({ categoryId: null }), cats, CHK)).toBe(false);
    expect(isInflowFiledAsExpense(tx({ categoryId: "deleted" }), cats, CHK)).toBe(false);
    expect(isInflowFiledAsExpense(tx({ categoryId: "xfer" }), cats, CHK)).toBe(false);
    expect(isInflowFiledAsExpense(tx({ categoryId: "visa" }), cats, CHK)).toBe(false);
    expect(isInflowFiledAsExpense(tx({ categoryId: "visa2" }), cats, CHK)).toBe(false);
  });
  it("(WP5c) the system Uncategorized category files a row nowhere: never 'income in an expense category'", () => {
    expect(isInflowFiledAsExpense(tx({ categoryId: "uncat" }), cats, CHK)).toBe(false);
  });
  it("(lead's ruling) a credit marked reimbursable is expected in an expense category: never flagged", () => {
    expect(isInflowFiledAsExpense(tx({ reimbursable: true }), cats, CHK)).toBe(false);
    expect(isInflowFiledAsExpense(tx({ reimbursable: true, pfcDetailed: null, description: "VENMO FROM J SMITH" }), cats, CHK)).toBe(false);
    expect(isInflowFiledAsExpense(tx({ reimbursable: false, pfcDetailed: null, description: "VENMO FROM J SMITH" }), cats, CHK)).toBe(true);
  });
  it("a transfer, a debt-tagged row or the card-payment flag is not income", () => {
    expect(isInflowFiledAsExpense(tx({ isTransfer: true }), cats, CHK)).toBe(false);
    expect(isInflowFiledAsExpense(tx({ debtId: "d1" }), cats, CHK)).toBe(false);
    expect(isInflowFiledAsExpense(tx({ isExternalCardPayment: true }), cats, CHK)).toBe(false);
  });
  it("(WP5c) a NON-Amex card's credit is never flagged: the account type says it is a card", () => {
    const freedom = tx({ source: "plaid:chase", description: "AMAZON MKTPLACE", pfcDetailed: null, amount: "20.00", plaidAccountId: "ext-freedom" });
    expect(isInflowFiledAsExpense(freedom, cats, CARD)).toBe(false);
    // The same credit on checking is money in under an expense category.
    expect(isInflowFiledAsExpense(freedom, cats, CHK)).toBe(true);
    // A card ledger source is a card even when the caller said otherwise.
    expect(isInflowFiledAsExpense(tx({ source: "plaid:amex", description: "PAYMENT THANK YOU", pfcDetailed: null }), cats, CHK)).toBe(false);
  });
  it("is pure: the same row and categories give the same answer, and nothing is mutated", () => {
    const row = tx();
    const before = JSON.stringify(row);
    expect(isInflowFiledAsExpense(row, cats, CHK)).toBe(isInflowFiledAsExpense(row, cats, CHK));
    expect(JSON.stringify(row)).toBe(before);
    expect(cats.get("visa")!.sourceKind).toBe("auto_debts");
  });
});

describe("(WP5c) card-ness from the loaded bank items", () => {
  const items = [
    {
      id: "item-chase",
      accounts: [
        { id: "row-chk", accountId: "ext-chk", type: "depository", subtype: "checking" },
        { id: "row-freedom", accountId: "ext-freedom", type: "credit", subtype: "credit card" },
      ],
    },
    { id: "item-cu", accounts: [{ id: "row-cu", accountId: "ext-cu", type: null, subtype: null }] },
  ] as unknown as PlaidItemDetail[];

  it("accountTypesOf keys every account by Plaid's EXTERNAL account id", () => {
    expect(accountTypesOf(items)).toEqual(
      new Map([
        ["ext-chk", "depository"],
        ["ext-freedom", "credit"],
        ["ext-cu", null],
      ]),
    );
    expect(accountTypesOf(undefined)).toEqual(new Map());
  });

  it("isCardTxn: a credit account of any bank, or a card ledger source; never by the internal row id", () => {
    const types = accountTypesOf(items);
    expect(isCardTxn({ source: "plaid:chase", plaidAccountId: "ext-freedom" }, types)).toBe(true);
    expect(isCardTxn({ source: "plaid:chase", plaidAccountId: "ext-chk" }, types)).toBe(false);
    expect(isCardTxn({ source: "plaid:chase", plaidAccountId: "row-freedom" }, types)).toBe(false);
    expect(isCardTxn({ source: "plaid:amex", plaidAccountId: null }, types)).toBe(true);
    expect(isCardTxn({ source: "amex" }, types)).toBe(true);
    expect(isCardTxn({ source: "manual", plaidAccountId: null }, types)).toBe(false);
  });
});

describe("(WP5c) directionConflictOfTxn — the shared rule, both ways", () => {
  it("money out under an income category is the other conflict", () => {
    expect(directionConflictOfTxn(tx({ amount: "-8.50", description: "ACME CAFE", categoryId: "pay", pfcDetailed: null }), cats, CHK)).toBe(
      "outflow_into_income",
    );
    expect(directionConflictOfTxn(tx(), cats, CHK)).toBe("inflow_into_expense");
    expect(directionConflictOfTxn(tx({ categoryId: "pay" }), cats, CHK)).toBeNull();
  });
});
