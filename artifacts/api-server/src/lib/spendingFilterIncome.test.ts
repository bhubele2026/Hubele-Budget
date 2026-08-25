import { describe, it, expect } from "vitest";
import {
  incomeAmount,
  isRealIncome,
  type SpendContext,
  type SpendTxn,
} from "./spendingFilter";

// The inflow half of the spending filter. `realIncome` is the denominator the
// Reports hub divides real spend by ("of income spent"), so what counts here
// decides whether that percentage means anything.

const PAYCHECK_CAT = "cat-paycheck";
const GROCERIES_CAT = "cat-groceries";
const TRANSFER_CAT = "cat-transfer";
const DEBT_CAT = "cat-debt";

const ctx: SpendContext = {
  categoriesById: new Map([
    [PAYCHECK_CAT, { name: "Paycheck", debtId: null, kind: "income" }],
    [GROCERIES_CAT, { name: "Groceries", debtId: null, kind: "expense" }],
    [TRANSFER_CAT, { name: "Transfer", debtId: null, kind: "income" }],
    [DEBT_CAT, { name: "Card draw", debtId: "debt-1", kind: "income" }],
  ]),
  debtCategoryIds: new Set([DEBT_CAT]),
};

function tx(over: Partial<SpendTxn> = {}): SpendTxn {
  return {
    amount: "2500.00",
    source: "chase",
    isTransfer: false,
    categoryId: PAYCHECK_CAT,
    description: "PAYROLL DEPOSIT",
    ...over,
  };
}

describe("incomeAmount", () => {
  it("reads a bank inflow as its positive magnitude", () => {
    expect(incomeAmount(tx({ amount: "2500.00" }))).toBe(2500);
    expect(incomeAmount(tx({ amount: 2500 }))).toBe(2500);
  });

  it("is zero for an outflow", () => {
    expect(incomeAmount(tx({ amount: "-120.00" }))).toBe(0);
  });

  it("is zero for every Amex row — a card credit is not income", () => {
    // A refund and the monthly payment both land here; both are the household
    // moving its own money, and counting either would inflate what it earns.
    expect(incomeAmount(tx({ source: "amex", amount: "-500.00" }))).toBe(0);
    expect(incomeAmount(tx({ source: "amex", amount: "500.00" }))).toBe(0);
  });

  it("is zero for an unparseable amount", () => {
    expect(incomeAmount(tx({ amount: "not-a-number" }))).toBe(0);
  });
});

describe("isRealIncome", () => {
  it("counts a deposit into an income category", () => {
    expect(isRealIncome(tx(), ctx)).toBe(true);
  });

  it("⚠️ still counts a paycheck whose raw string carries ACH noise", () => {
    // The spend side screens these tokens to catch bank noise. Applying the
    // same screen here would drop real direct deposits — Chase stamps "WEB
    // ID:" on plenty of them — which is the one row that must never vanish.
    expect(
      isRealIncome(
        tx({ description: "ORIG CO NAME:ACME  ACH PMT  WEB ID: 1234567890" }),
        ctx,
      ),
    ).toBe(true);
  });

  it("rejects an inflow flagged as a transfer between our own accounts", () => {
    expect(isRealIncome(tx({ isTransfer: true }), ctx)).toBe(false);
  });

  it("rejects a refund landing back in an expense category", () => {
    expect(isRealIncome(tx({ categoryId: GROCERIES_CAT }), ctx)).toBe(false);
  });

  it("rejects an uncategorized deposit", () => {
    expect(isRealIncome(tx({ categoryId: null }), ctx)).toBe(false);
  });

  it("rejects a category named as a transfer even when it is kind income", () => {
    expect(isRealIncome(tx({ categoryId: TRANSFER_CAT }), ctx)).toBe(false);
  });

  it("rejects money drawn from a tracked debt", () => {
    // Borrowing is not earning.
    expect(isRealIncome(tx({ categoryId: DEBT_CAT }), ctx)).toBe(false);
  });

  it("rejects an outflow sitting in an income category", () => {
    expect(isRealIncome(tx({ amount: "-2500.00" }), ctx)).toBe(false);
  });

  it("rejects a row whose category no longer exists", () => {
    expect(isRealIncome(tx({ categoryId: "deleted-cat" }), ctx)).toBe(false);
  });
});
