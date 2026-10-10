import { describe, it, expect } from "vitest";
import {
  categoryDirectionConflict,
  classifyOutflow,
  isCardLedgerRow,
  isRealIncome,
  type DirectionOptions,
  type SpendContext,
  type SpendTxn,
} from "./spendingFilter";

// (WP5c) The direction rule: money in under an EXPENSE category, or money out
// under an INCOME one, is a conflict — such a row counts in neither spending nor
// income. One predicate, shared by the categorizer (decide.ts, the model stage)
// and the web (lib/categoryDirection.ts). This file pins the rule, its
// exclusions, and what must NOT change: card credits, checking refunds,
// reimbursables, transfers and card payments.

const DINING = "cat-dining";
const SHOPPING = "cat-shopping";
const PAYCHECK = "cat-paycheck";
const TRANSFER = "cat-transfer";
const REIMB = "cat-reimbursement";
const VISA = "cat-visa";
const UNCAT = "cat-uncategorized";

const ctx: SpendContext = {
  categoriesById: new Map([
    [DINING, { name: "Dining & Coffee", debtId: null, kind: "expense" }],
    [SHOPPING, { name: "Shopping", debtId: null, kind: "expense" }],
    [PAYCHECK, { name: "Paycheck", debtId: null, kind: "income" }],
    [TRANSFER, { name: "Transfer", debtId: null, kind: "expense" }],
    [REIMB, { name: "Reimbursement", debtId: null, kind: "income" }],
    [VISA, { name: "Visa (24.99%)", debtId: "debt-visa", kind: "expense" }],
    [UNCAT, { name: "Uncategorized", debtId: null, kind: "expense" }],
  ]),
  debtCategoryIds: new Set([VISA]),
};

const CHECKING: DirectionOptions = { isCardAccount: false, uncategorizedIds: new Set([UNCAT]) };
const CARD: DirectionOptions = { isCardAccount: true, uncategorizedIds: new Set([UNCAT]) };

function tx(over: Partial<SpendTxn> = {}): SpendTxn {
  return {
    amount: "2500.00",
    source: "plaid:chase",
    isTransfer: false,
    categoryId: null,
    description: "BIGCO PAYROLL PPD ID 4455",
    debtId: null,
    isExternalCardPayment: false,
    reimbursable: false,
    pfcDetailed: "INCOME_WAGES",
    ...over,
  };
}
const cafe = (over: Partial<SpendTxn> = {}) =>
  tx({ amount: "-8.50", description: "BIGCO CAFE 0042", pfcDetailed: "FOOD_AND_DRINK_COFFEE", ...over });

describe("categoryDirectionConflict — the conflicts", () => {
  it("money in under an expense category: a payroll deposit in Dining & Coffee", () => {
    expect(categoryDirectionConflict(tx(), DINING, ctx, CHECKING)).toBe("inflow_into_expense");
    expect(categoryDirectionConflict(tx({ pfcDetailed: null }), DINING, ctx, CHECKING)).toBe("inflow_into_expense");
    // A friend paying back, not marked reimbursable, is still money in.
    expect(categoryDirectionConflict(tx({ description: "VENMO FROM J SMITH", pfcDetailed: null, amount: 40 }), DINING, ctx, CHECKING)).toBe("inflow_into_expense");
    // A TAX refund is not money back from a purchase.
    expect(categoryDirectionConflict(tx({ description: "IRS TREAS 310 TAX REF", pfcDetailed: null }), SHOPPING, ctx, CHECKING)).toBe("inflow_into_expense");
  });

  it("money out under an income category: a cafeteria charge in the paycheck category", () => {
    expect(categoryDirectionConflict(cafe(), PAYCHECK, ctx, CHECKING)).toBe("outflow_into_income");
    // An Amex-workbook charge is POSITIVE (workbook sign) and still money out.
    expect(categoryDirectionConflict(cafe({ source: "amex", amount: "45.00" }), PAYCHECK, ctx, CARD)).toBe("outflow_into_income");
    // A card only excuses CREDITS: a charge on any card into income is a conflict.
    expect(categoryDirectionConflict(cafe({ source: "plaid:chase" }), PAYCHECK, ctx, CARD)).toBe("outflow_into_income");
  });

  it("judges the category it is given, not the row's own", () => {
    expect(categoryDirectionConflict(tx({ categoryId: PAYCHECK }), DINING, ctx, CHECKING)).toBe("inflow_into_expense");
    expect(categoryDirectionConflict(tx({ categoryId: DINING }), PAYCHECK, ctx, CHECKING)).toBeNull();
  });

  it("every conflict is a row that, filed that way, counts as neither spending nor income", () => {
    const conflicts: Array<[SpendTxn, string, DirectionOptions]> = [
      [tx(), DINING, CHECKING],
      [tx({ description: "VENMO FROM J SMITH", pfcDetailed: null }), SHOPPING, CHECKING],
      [cafe(), PAYCHECK, CHECKING],
      [cafe({ source: "amex", amount: "45.00" }), PAYCHECK, CARD],
    ];
    for (const [row, categoryId, opts] of conflicts) {
      expect(categoryDirectionConflict(row, categoryId, ctx, opts)).not.toBeNull();
      const filed = { ...row, categoryId };
      expect(classifyOutflow(filed, ctx).kind).not.toBe("spend");
      expect(isRealIncome(filed, ctx)).toBe(false);
    }
  });
});

describe("categoryDirectionConflict — what must NOT change", () => {
  it("card credits: money back on a card belongs with the purchases it nets, whichever bank issued it", () => {
    // Plaid Amex (a card ledger source) and the Amex workbook (credit is negative).
    expect(categoryDirectionConflict(tx({ source: "plaid:amex", description: "CAFE", pfcDetailed: null, amount: "20.00" }), DINING, ctx, CHECKING)).toBeNull();
    expect(categoryDirectionConflict(tx({ source: "amex", description: "CAFE", pfcDetailed: null, amount: "-20.00" }), DINING, ctx, CHECKING)).toBeNull();
    // A non-Amex card: only its account type says it is a card.
    const freedomCredit = tx({ source: "plaid:chase", description: "AMAZON MKTPLACE", pfcDetailed: null, amount: "20.00" });
    expect(categoryDirectionConflict(freedomCredit, SHOPPING, ctx, CARD)).toBeNull();
    expect(categoryDirectionConflict(freedomCredit, SHOPPING, ctx, CHECKING)).toBe("inflow_into_expense");
    // A card ledger source is a card even when the caller did not say so.
    expect(categoryDirectionConflict(tx({ source: "plaid:amex", description: "PAYMENT THANK YOU", pfcDetailed: null, amount: "300.00" }), DINING, ctx, CHECKING)).toBeNull();
    expect(categoryDirectionConflict(tx({ source: "amex", description: "PAYMENT RECEIVED - THANK YOU", pfcDetailed: null, amount: "-500.00" }), DINING, ctx, CHECKING)).toBeNull();
    // A card's payment arriving is not flagged either.
    expect(categoryDirectionConflict(tx({ source: "plaid:chase", description: "PAYMENT THANK YOU", pfcDetailed: null, amount: "300.00" }), DINING, ctx, CARD)).toBeNull();
  });

  it("checking refunds: a credit whose description says REFUND nets its category", () => {
    expect(categoryDirectionConflict(tx({ description: "AMAZON.COM REFUND", pfcDetailed: null, amount: "19.99" }), SHOPPING, ctx, CHECKING)).toBeNull();
    expect(categoryDirectionConflict(tx({ description: "CAFE RFND", pfcDetailed: null, amount: "4.00" }), DINING, ctx, CHECKING)).toBeNull();
  });

  it("reimbursables: money paid back belongs with what it repays, either direction", () => {
    expect(categoryDirectionConflict(tx({ reimbursable: true }), DINING, ctx, CHECKING)).toBeNull();
    expect(categoryDirectionConflict(cafe({ reimbursable: true }), PAYCHECK, ctx, CHECKING)).toBeNull();
  });

  it("transfers: never a direction question", () => {
    expect(categoryDirectionConflict(tx({ isTransfer: true }), DINING, ctx, CHECKING)).toBeNull();
    expect(categoryDirectionConflict(cafe({ isTransfer: true }), PAYCHECK, ctx, CHECKING)).toBeNull();
  });

  it("card payments and debts: the flag, a debt row, a debt category", () => {
    expect(categoryDirectionConflict(tx({ isExternalCardPayment: true }), DINING, ctx, CHECKING)).toBeNull();
    expect(categoryDirectionConflict(tx({ debtId: "debt-visa" }), DINING, ctx, CHECKING)).toBeNull();
    expect(categoryDirectionConflict(tx(), VISA, ctx, CHECKING)).toBeNull();
    expect(categoryDirectionConflict(cafe(), VISA, ctx, CHECKING)).toBeNull();
    // A card payment leaving checking, filed under an expense: money out, so no question.
    expect(categoryDirectionConflict(cafe({ description: "AMEX EPAYMENT ACH PMT", amount: "-300.00", pfcDetailed: null }), DINING, ctx, CHECKING)).toBeNull();
  });

  it("excluded categories, the system Uncategorized, no category and a deleted one", () => {
    expect(categoryDirectionConflict(tx(), TRANSFER, ctx, CHECKING)).toBeNull();
    expect(categoryDirectionConflict(cafe(), REIMB, ctx, CHECKING)).toBeNull();
    expect(categoryDirectionConflict(tx(), UNCAT, ctx, CHECKING)).toBeNull();
    expect(categoryDirectionConflict(tx(), null, ctx, CHECKING)).toBeNull();
    expect(categoryDirectionConflict(tx(), undefined, ctx, CHECKING)).toBeNull();
    expect(categoryDirectionConflict(tx(), "cat-deleted", ctx, CHECKING)).toBeNull();
  });

  it("the right direction, and a zero, are never conflicts", () => {
    expect(categoryDirectionConflict(tx(), PAYCHECK, ctx, CHECKING)).toBeNull();
    expect(categoryDirectionConflict(cafe(), DINING, ctx, CHECKING)).toBeNull();
    expect(categoryDirectionConflict(tx({ amount: "0" }), DINING, ctx, CHECKING)).toBeNull();
    expect(categoryDirectionConflict(tx({ amount: "0" }), PAYCHECK, ctx, CHECKING)).toBeNull();
  });

  it("is pure: same answer twice, nothing mutated", () => {
    const row = tx({ categoryId: PAYCHECK });
    const before = JSON.stringify(row);
    expect(categoryDirectionConflict(row, DINING, ctx, CHECKING)).toBe(categoryDirectionConflict(row, DINING, ctx, CHECKING));
    expect(JSON.stringify(row)).toBe(before);
  });
});

describe("isCardLedgerRow", () => {
  it("a Plaid credit account of any bank, or a card ledger source", () => {
    expect(isCardLedgerRow("plaid:chase", "credit")).toBe(true);
    expect(isCardLedgerRow("plaid:capital-one", "credit")).toBe(true);
    expect(isCardLedgerRow("plaid:amex", null)).toBe(true);
    expect(isCardLedgerRow("amex", undefined)).toBe(true);
    expect(isCardLedgerRow("PLAID:AMEX", null)).toBe(true);
    expect(isCardLedgerRow("plaid:chase", "depository")).toBe(false);
    expect(isCardLedgerRow("manual", null)).toBe(false);
    expect(isCardLedgerRow(null, null)).toBe(false);
  });
});
