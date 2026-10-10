// ⭐ (WP6) The Budget's "this month" against household spending to date: the
// identity, one row per term, to the cent. Synthetic rows only.
import { describe, it, expect } from "vitest";
import { classifyOutflow, PFC_CARD_PAYMENT, type SpendContext } from "./spendingFilter";
import type { ReplacedPending } from "./supersededPending";
import { explainedByTerms, reconcileMonthSpend, type ReconcileRow } from "./spendingReconcile";

const TODAY = "2026-10-10";
const CAT = {
  groceries: "cat-groceries",
  misc: "cat-misc-buffer",
  debtLine: "cat-upstart",
  ignore: "cat-ignore",
  uncategorized: "cat-uncategorized", // the system row: no Budget line
  paycheck: "cat-paycheck",
} as const;
const spendCtx: SpendContext = {
  categoriesById: new Map([
    [CAT.groceries, { name: "Groceries", debtId: null, kind: "expense" }],
    [CAT.misc, { name: "Misc / Buffer", debtId: null, kind: "expense" }],
    [CAT.debtLine, { name: "Upstart personal loan", debtId: "debt-upstart", kind: "expense" }],
    [CAT.ignore, { name: "Ignore", debtId: null, kind: "expense" }],
    [CAT.uncategorized, { name: "Uncategorized", debtId: null, kind: "expense" }],
    [CAT.paycheck, { name: "Paycheck", debtId: null, kind: "income" }],
  ]),
  debtCategoryIds: new Set([CAT.debtLine]),
};
const filingCtx = { uncategorizedIds: new Set([CAT.uncategorized]) };
// Every Budget line that is not income (the system Uncategorized has no line).
const expenseLineIds = new Set([CAT.groceries, CAT.misc, CAT.debtLine, CAT.ignore]);

let n = 0;
const row = (o: Partial<ReconcileRow>): ReconcileRow => ({
  id: `r${++n}`,
  description: "CORNER MARKET",
  source: "plaid:chase",
  amount: "-1.00",
  pending: false,
  isExternalCardPayment: false,
  categoryId: CAT.groceries,
  weeklyAllowance: false,
  monthlyAllowance: false,
  unplannedAllowance: false,
  weeklyBucket: null,
  reimbursable: false,
  debtId: null,
  isTransfer: false,
  isTransferUserOverridden: false,
  occurredOn: "2026-10-02",
  plaidAccountId: "acct-checking",
  pfcDetailed: null,
  ...o,
});

// One row per term (and the rows that move neither figure).
const purchase = row({ amount: "-100.00" });
const futureDated = row({ amount: "-40.00", occurredOn: "2026-10-20" });
const cardPayment = row({ description: "AMEX EPAYMENT ACH PMT", amount: "-1200.00", categoryId: CAT.misc, pfcDetailed: PFC_CARD_PAYMENT });
const debtPayment = row({ description: "UPSTART LOAN", amount: "-245.00", categoryId: CAT.debtLine, debtId: "debt-upstart" });
const excludedName = row({ description: "CASH TO SELF", amount: "-30.00", categoryId: CAT.ignore });
const reimbursable = row({ description: "OFFICE SUPPLY CO", amount: "-60.00", reimbursable: true });
const bankNoise = row({ description: "ONLINE TRANSFER TO SAV 9", amount: "-500.00", categoryId: CAT.misc });
const splitPurchase = row({ description: "BIG BOX STORE", amount: "-80.00" });
const uncategorized = row({ description: "FOOD TRUCK", amount: "-25.00", categoryId: null });
const parked = row({ description: "STREET VENDOR", amount: "-15.00", categoryId: CAT.uncategorized });
const refund = row({ description: "CORNER MARKET REFUND", amount: "20.00", occurredOn: "2026-10-08" });
const transfer = row({ description: "TO SAVINGS", amount: "-300.00", categoryId: CAT.misc, isTransfer: true });
const paycheck = row({ description: "ACME PAYROLL", amount: "2000.00", categoryId: CAT.paycheck });
// A pending charge its posted row replaced: the posted row counts, the pending half in neither.
const pendingHalf = row({ description: "CAFE 22", amount: "-10.00", pending: true, occurredOn: "2026-10-04" });
const postedHalf = row({ description: "CAFE 22", amount: "-12.00", occurredOn: "2026-10-05", categoryId: null });

const ROWS = [
  purchase, futureDated, cardPayment, debtPayment, excludedName, reimbursable, bankNoise, splitPurchase,
  uncategorized, parked, refund, transfer, paycheck, pendingHalf, postedHalf,
];
const supersede = {
  replacedIds: new Set([pendingHalf.id]),
  replacedBy: new Map<string, ReplacedPending>([
    [postedHalf.id, { id: pendingHalf.id, occurredOn: pendingHalf.occurredOn, description: pendingHalf.description, filing: pendingHalf }],
  ]),
};
// $50 of the split purchase is Groceries; $30 parked in Uncategorized (no line).
const splitParts = new Map([
  [splitPurchase.id, [{ categoryId: CAT.groceries, amount: "-50.00" }, { categoryId: CAT.uncategorized, amount: "-30.00" }]],
]);

describe("reconcileMonthSpend — Budget actual vs household spending to date", () => {
  const r = reconcileMonthSpend(ROWS, supersede, filingCtx, spendCtx, splitParts, { today: TODAY, expenseLineIds });

  it("the fixture's rows are what their names say, by the one spending rule", () => {
    expect(classifyOutflow(cardPayment, spendCtx).kind).toBe("card_payment");
    expect(classifyOutflow(debtPayment, spendCtx).kind).toBe("debt_payment");
    expect(classifyOutflow(excludedName, spendCtx).kind).toBe("excluded_category");
    expect(classifyOutflow(reimbursable, spendCtx).kind).toBe("reimbursable");
    expect(classifyOutflow(bankNoise, spendCtx).kind).toBe("bank_noise");
  });

  it("A: every row in an expense line, the whole month, transfers skipped (the posted half under its pending row's Groceries)", () => {
    // 100 + 40 + 1,200 + 245 + 30 + 60 + 500 + 50 (split part) + 12 (posted half) = 2,237.00
    expect(r.budgetActual).toBe(223700);
  });

  it("B: purchases through today, any category, less the refund on the same account", () => {
    // 100 + 80 (whole split row) + 25 + 15 + 12 = 232.00, less the 20.00 refund
    expect(r.householdSpendToDate).toBe(21200);
  });

  it("⭐ one row per term, and the identity closes to the cent (unexplained 0)", () => {
    expect(r.terms).toEqual({
      futureDated: 4000,
      cardPayments: 120000,
      debtPayments: 24500,
      excludedNames: 3000,
      reimbursable: 6000,
      bankNoise: 50000,
      splitsOutsideLines: -3000,
      uncategorized: 2500,
      parkedUncategorized: 1500,
      refundsNetted: 2000,
    });
    expect(r.difference).toBe(r.budgetActual - r.householdSpendToDate);
    expect(r.difference).toBe(202500);
    expect(explainedByTerms(r.terms)).toBe(r.difference);
    expect(r.unexplained).toBe(0);
  });

  it("a refund never takes an account below zero: only what was spent there is netted", () => {
    const bigRefund = row({ description: "SOFA STORE REFUND", amount: "900.00", plaidAccountId: "acct-other", occurredOn: "2026-10-09" });
    const smallBuy = row({ description: "SOFA STORE", amount: "-100.00", plaidAccountId: "acct-other" });
    const x = reconcileMonthSpend([bigRefund, smallBuy], { replacedIds: new Set<string>(), replacedBy: new Map<string, ReplacedPending>() }, filingCtx, spendCtx, new Map(), {
      today: TODAY,
      expenseLineIds,
    });
    expect(x.householdSpendToDate).toBe(0);
    expect(x.terms.refundsNetted).toBe(10000);
    expect(explainedByTerms(x.terms) + x.unexplained).toBe(x.difference);
  });

  it("a past month: nothing is future-dated; a future month: everything is", () => {
    const past = reconcileMonthSpend(ROWS, supersede, filingCtx, spendCtx, splitParts, { today: "2026-11-15", expenseLineIds });
    expect(past.terms.futureDated).toBe(0);
    expect(explainedByTerms(past.terms) + past.unexplained).toBe(past.difference);
    const future = reconcileMonthSpend(ROWS, supersede, filingCtx, spendCtx, splitParts, { today: "2026-09-30", expenseLineIds });
    expect(future.householdSpendToDate).toBe(0);
    expect(future.terms.futureDated).toBe(future.budgetActual);
    expect(future.unexplained).toBe(0);
  });
});
