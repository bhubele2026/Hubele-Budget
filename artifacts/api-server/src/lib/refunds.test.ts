// (B6) Refunds net, and a refund row gets a decision — the pure rules.
//
//   classifyRefund        which credits are refunds (and which never are)
//   classifyMovement      a refund's coverage and the coverage it nets
//   allowanceTotals       the netting: per account, inside a window, never below zero
//   computePosition       the week's figures with a refund in them
//   payoff (hooks)        a refund of an open week's card charge leaves the payoff where it was
//
// See docs/reviews/2026-10-08-b6-refunds.md.

import { describe, expect, it } from "vitest";
import {
  allowanceRowOf,
  allowanceTotals,
  classifyMovement,
  classifyRefund,
  computePosition,
  creditAmount,
  discretionaryCents,
  hasRefundMarker,
  netAccountOf,
  payoffFor,
  PFC_CARD_PAYMENT,
  type AllowanceRow,
  type MovementContext,
  type MovementRow,
  type PositionInputs,
  type SpendContext,
  type SpendTxn,
} from "@workspace/avalanche-core";
import { REFUND_SIGNATURE_MARKERS, merchantSignature, refundSignature } from "./merchantNameExtract";

const CHECKING = "chk-ext";
const AMEX = "amex-ext";

const cats: SpendContext["categoriesById"] = new Map([
  ["groceries", { name: "Groceries", debtId: null, kind: "expense" }],
  ["paycheck", { name: "Paycheck", debtId: null, kind: "income" }],
  ["ignore", { name: "Ignore", debtId: null, kind: "expense" }],
  ["reimb", { name: "Reimbursement", debtId: null, kind: "expense" }],
  ["card-payoff", { name: "Card Payoff", debtId: "debt-1", kind: "expense" }],
]);
const spendCtx: SpendContext = { categoriesById: cats, debtCategoryIds: new Set(["card-payoff"]) };

function ctx(over: Partial<MovementContext> = {}): MovementContext {
  return { ...spendCtx, checkingAccountExternalId: CHECKING, matchedTxnIds: new Set(), ...over };
}

/** An Amex (Plaid) credit by default: +20.00 is money back on the card. */
function row(over: Partial<MovementRow> = {}): MovementRow {
  return {
    id: "r1",
    occurredOn: "2026-10-08",
    amount: "20.00",
    source: "plaid:amex",
    isTransfer: false,
    categoryId: null,
    description: "KROGER #442 REFUND",
    debtId: null,
    isExternalCardPayment: false,
    reimbursable: false,
    pfcDetailed: "FOOD_AND_DRINK_GROCERIES",
    plaidAccountId: AMEX,
    unplannedAllowance: false,
    monthlyAllowance: false,
    weeklyAllowance: false,
    ...over,
  };
}

const tx = (over: Partial<MovementRow> = {}): SpendTxn => row(over);

describe("classifyRefund — which credits are refunds", () => {
  it("money back on the card's own ledger is a refund, filed or not (Plaid and workbook signs)", () => {
    expect(classifyRefund(tx(), spendCtx)).toEqual({ rule: "card-credit", categorized: false });
    expect(classifyRefund(tx({ categoryId: "groceries" }), spendCtx)).toEqual({ rule: "card-credit", categorized: true });
    // An unmarked credit on the card is still money back.
    expect(classifyRefund(tx({ description: "KROGER #442" }), spendCtx)?.rule).toBe("card-credit");
    // The workbook stores a card credit negative.
    const workbook = tx({ source: "amex", amount: "-20.00", plaidAccountId: null });
    expect(creditAmount(workbook)).toBe(20);
    expect(classifyRefund(workbook, spendCtx)?.rule).toBe("card-credit");
    // A charge is never a refund, on either sign convention.
    expect(classifyRefund(tx({ amount: "-86.33" }), spendCtx)).toBeNull();
    expect(classifyRefund(tx({ source: "amex", amount: "86.33", plaidAccountId: null }), spendCtx)).toBeNull();
    expect(classifyRefund(tx({ amount: "0.00" }), spendCtx)).toBeNull();
  });

  it("a refund on a transfer is ignored — and so is every other credit the spending rule rules out", () => {
    const out: Array<[string, Partial<MovementRow>]> = [
      ["transfer", { isTransfer: true }],
      ["tagged debt", { debtId: "debt-9" }],
      ["card-payment flag", { isExternalCardPayment: true }],
      ["debt category", { categoryId: "card-payoff" }],
      ["excluded category (Ignore)", { categoryId: "ignore" }],
      ["excluded category (Reimbursement)", { categoryId: "reimb" }],
      ["income category", { categoryId: "paycheck" }],
      ["Plaid card payment", { pfcDetailed: PFC_CARD_PAYMENT }],
      ["Plaid transfer in", { pfcDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER" }],
      ["Plaid income (tax refund)", { pfcDetailed: "INCOME_TAX_REFUND" }],
      ["the card's payment arriving", { description: "ONLINE PAYMENT - THANK YOU", pfcDetailed: null }],
      ["autopay", { description: "AUTOPAY PYMT RECEIVED", pfcDetailed: null }],
      ["card-payment phrase", { description: "AMEX EPAYMENT ACH PMT", pfcDetailed: null }],
      ["bank noise", { description: "ONLINE TRANSFER FROM CHK 1234", pfcDetailed: null }],
      ["reimbursable (spending)", { reimbursable: true }],
    ];
    for (const [why, over] of out) expect(classifyRefund(tx(over), spendCtx), why).toBeNull();
  });

  it("a reimbursable refund nets what the card owes, never household spending (rule 7's mirror)", () => {
    expect(classifyRefund(tx({ reimbursable: true }), spendCtx)).toBeNull();
    expect(classifyRefund(tx({ reimbursable: true }), spendCtx, { reimbursableIsSpend: true })?.rule).toBe("card-credit");
  });

  it("off the card, only a refund word makes a credit a refund — never a paycheck, an ACH return or a tax refund", () => {
    const chk = (description: string, over: Partial<MovementRow> = {}) =>
      classifyRefund(tx({ source: "plaid:chase", plaidAccountId: CHECKING, description, pfcDetailed: null, ...over }), spendCtx);
    expect(chk("AMAZON.COM REFUND")?.rule).toBe("refund-marker");
    expect(chk("RFND BEST BUY 0042")?.rule).toBe("refund-marker");
    expect(chk("TARGET REFUNDED", { source: "manual", plaidAccountId: null })?.rule).toBe("refund-marker");
    expect(chk("ACME PAYROLL")).toBeNull(); // an unfiled paycheck
    expect(chk("KROGER #442")).toBeNull(); // no word, not on a card
    expect(chk("ACH RETURN SETTLEMENT")).toBeNull();
    expect(chk("TARGET RETURN")).toBeNull();
    expect(chk("ACH CREDIT DEPOSIT")).toBeNull();
    expect(chk("STATE TAX REFUND")).toBeNull();
    expect(chk("IRS TREAS 310 REFUND")).toBeNull();
    expect(chk("AMAZON.COM REFUND", { categoryId: "paycheck" })).toBeNull();
    expect(hasRefundMarker("kroger #442 refund")).toBe(true);
    expect(hasRefundMarker("REFUNDABLE DEPOSIT")).toBe(false); // whole words only
  });
});

describe("classifyMovement — a refund's coverage and what it nets", () => {
  it("a refund is 'refund', netting the coverage a purchase with its flags would have", () => {
    expect(classifyMovement(row(), ctx())).toEqual({
      coverage: "refund",
      nets: "needs_classification",
      timing: { kind: "card", accountId: AMEX, date: "2026-10-08" },
    });
    expect(classifyMovement(row({ weeklyAllowance: true }), ctx()).nets).toBe("allowance_weekly");
    expect(classifyMovement(row({ monthlyAllowance: true }), ctx()).nets).toBe("allowance_monthly");
    expect(classifyMovement(row({ unplannedAllowance: true, weeklyAllowance: true }), ctx()).nets).toBe("unplanned");
    expect(classifyMovement(row({ reimbursable: true, weeklyAllowance: true }), ctx()).nets).toBe("reimbursable");
    expect(classifyMovement(row(), ctx({ matchedTxnIds: new Set(["r1"]) })).nets).toBe("bill_matched");
    expect(classifyMovement(row(), ctx({ tier2PairedTxnIds: new Set(["r1"]) })).nets).toBe("bill_matched");
  });

  it("a refund on a transfer is ignored: 'excluded', as every non-refund inflow was before", () => {
    const c = classifyMovement(row({ isTransfer: true }), ctx());
    expect(c.coverage).toBe("excluded");
    expect(c.nets).toBeUndefined();
    expect(classifyMovement(row({ pfcDetailed: PFC_CARD_PAYMENT, description: "ONLINE PAYMENT - THANK YOU" }), ctx()).coverage).toBe("excluded");
    // An uncategorized checking deposit is still excluded (no refund word).
    expect(classifyMovement(row({ source: "plaid:chase", plaidAccountId: CHECKING, description: "ACME PAYROLL", pfcDetailed: null }), ctx()).coverage).toBe("excluded");
  });

  it("income is unchanged: a deposit in an income category is income", () => {
    expect(classifyMovement(row({ source: "plaid:chase", plaidAccountId: CHECKING, amount: "2000.00", categoryId: "paycheck" }), ctx()).coverage).toBe("income");
  });

  it("allowanceRowOf: a refund moves into the coverage it nets, negative, on its own account", () => {
    expect(allowanceRowOf(row(), classifyMovement(row(), ctx()))).toEqual({ coverage: "needs_classification", spend: -20, account: AMEX });
    const buy = row({ amount: "-86.33", description: "KROGER #442" });
    expect(allowanceRowOf(buy, classifyMovement(buy, ctx()))).toEqual({ coverage: "needs_classification", spend: 86.33, account: AMEX });
    const workbook = row({ source: "amex", amount: "-20.00", plaidAccountId: null });
    expect(allowanceRowOf(workbook, classifyMovement(workbook, ctx()))).toEqual({ coverage: "needs_classification", spend: -20, account: "source:amex" });
    expect(netAccountOf({ plaidAccountId: null, source: "manual" })).toBe("source:manual");
  });
});

const r = (coverage: string, spend: number, account = AMEX): AllowanceRow => ({ coverage, spend, account });

describe("allowanceTotals — per account, inside the window, never below zero", () => {
  it("B4 S4: the $20 refund nets the card's $86.33; the checking $42.10 is untouched", () => {
    expect(allowanceTotals([r("needs_classification", 86.33), r("needs_classification", 42.1, CHECKING), r("needs_classification", -20)])).toEqual({
      discretionaryCents: 10843,
      unfiledCents: 10843,
      unplannedCents: 0,
      monthlyCents: 0,
    });
  });

  it("a refund larger than the window's spend floors at 0 — it never reaches another account's spend", () => {
    expect(allowanceTotals([r("needs_classification", 30), r("needs_classification", -50), r("allowance_weekly", 40, CHECKING)])).toEqual({
      discretionaryCents: 4000,
      unfiledCents: 0,
      unplannedCents: 0,
      monthlyCents: 0,
    });
    // A refund alone in the window: zero, never negative.
    expect(allowanceTotals([r("allowance_weekly", -25)]).discretionaryCents).toBe(0);
  });

  it("weekly and unfiled are ONE pool (both count against the cap); unfiled never exceeds it", () => {
    // A weekly charge refunded by an unfiled credit: the pool nets.
    expect(allowanceTotals([r("allowance_weekly", 50), r("needs_classification", -30)])).toMatchObject({ discretionaryCents: 2000, unfiledCents: 0 });
    // An unfiled charge refunded by a weekly-filed credit.
    expect(allowanceTotals([r("needs_classification", 50), r("allowance_weekly", -30)])).toMatchObject({ discretionaryCents: 2000, unfiledCents: 2000 });
  });

  it("unplanned and monthly net only themselves, each floored", () => {
    expect(allowanceTotals([r("unplanned", 10), r("unplanned", -15), r("allowance_monthly", 70), r("allowance_monthly", -20), r("allowance_weekly", 5)])).toEqual({
      discretionaryCents: 500,
      unfiledCents: 0,
      unplannedCents: 0,
      monthlyCents: 5000,
    });
  });

  it("a refund in a coverage outside every figure (bill_matched, reimbursable) nets nothing", () => {
    expect(allowanceTotals([r("allowance_weekly", 50), r("bill_matched", -30), r("reimbursable", -10)]).discretionaryCents).toBe(5000);
  });

  it("with no refund, every figure is the plain sum it was before B6 (accounts or not)", () => {
    const rows = [r("allowance_weekly", 12.34), r("needs_classification", 5.66, CHECKING), r("unplanned", 7), { coverage: "allowance_monthly", spend: "3.30" }];
    expect(allowanceTotals(rows)).toEqual({ discretionaryCents: 1800, unfiledCents: 566, unplannedCents: 700, monthlyCents: 330 });
    expect(allowanceTotals(rows.map(({ coverage, spend }) => ({ coverage, spend })))).toEqual(allowanceTotals(rows));
  });

  it("the daily metrics read the position's own rule: discretionaryWtd nets a refund the same way", () => {
    const rows = [r("needs_classification", 86.33), r("needs_classification", 42.1, CHECKING), r("needs_classification", -20)];
    expect(discretionaryCents(rows)).toBe(allowanceTotals(rows).discretionaryCents);
    expect(discretionaryCents(rows)).toBe(10843);
  });

  it("a refund on a card after the week closed nets the NEXT week, never the closed one", () => {
    // $86.33 charged Tue 10/6; $20 back Mon 10/12 — after Sat 10/10 closed the week.
    const charge = row({ id: "c", amount: "-86.33", description: "KROGER #442", occurredOn: "2026-10-06" });
    const refund = row({ id: "f", occurredOn: "2026-10-12" });
    const nextCharge = row({ id: "n", amount: "-12.00", description: "CORNER CAFE", occurredOn: "2026-10-13" });
    const rows = [charge, refund, nextCharge].map((x) => ({ date: x.occurredOn, a: allowanceRowOf(x, classifyMovement(x, ctx())) }));
    const week = (start: string, end: string) => allowanceTotals(rows.filter((x) => x.date >= start && x.date <= end).map((x) => x.a)).discretionaryCents;
    expect(week("2026-10-04", "2026-10-10")).toBe(8633); // the closed week keeps its charge
    expect(week("2026-10-11", "2026-10-17")).toBe(0); // the next week: 12.00 − 20.00, floored
  });
});

describe("computePosition — a refund gives the week's room back", () => {
  const base: PositionInputs = {
    todayISO: "2026-10-08",
    daily: [{ date: "2026-10-08", balance: "2457.90" }, { date: "2026-10-10", balance: "2200.00" }],
    events: [],
    incomeItems: [],
    cashBuffer: "500.00",
    weekCap: "300.00",
    weekRows: [],
    freshness: { stale: false, staleReason: null, asOfBank: null },
    status: "ready",
  };
  const pos = (weekRows: PositionInputs["weekRows"]) => computePosition({ ...base, weekRows });
  const amex = (coverage: "needs_classification" | "allowance_weekly", spend: number) => ({ coverage, spend, account: AMEX });

  it("B4 S4: spent 108.43, remaining 191.57, safe 191.57 (was 128.43 / 171.57)", () => {
    const p = pos([amex("needs_classification", 86.33), { coverage: "needs_classification", spend: 42.1, account: CHECKING }, amex("needs_classification", -20)]);
    expect(p).toMatchObject({
      spentWeekDiscretionary: "108.43",
      needsClassificationWeek: "108.43",
      remainingWeek: "191.57",
      safeToSpendNow: "191.57",
    });
  });

  it("a refund bigger than the week's spend returns no more than the week spent", () => {
    expect(pos([amex("allowance_weekly", 40), amex("needs_classification", -100)])).toMatchObject({
      spentWeekDiscretionary: "0.00",
      remainingWeek: "300.00",
    });
  });
});

describe("the open week's payoff holds when a card charge is refunded (charges and room net alike)", () => {
  // payoff = card charges net of refunds + (cap − spent, refunds netted per account).
  const payoff = (rows: AllowanceRow[], chargesCents: number) =>
    payoffFor({ chargesCents, capCents: 30000, spentCents: allowanceTotals(rows).discretionaryCents, periodEnd: "2026-10-10", todayISO: "2026-10-08" }).amountCents;

  it("B4: 86.33 + 171.57 before the refund, 66.33 + 191.57 after — 257.90 either way", () => {
    const before = [r("needs_classification", 86.33), r("needs_classification", 42.1, CHECKING)];
    expect(payoff(before, 8633)).toBe(25790);
    expect(payoff([...before, r("needs_classification", -20)], 6633)).toBe(25790);
  });

  it("a weekly-filed charge refunded by an unfiled credit still holds (one pool)", () => {
    expect(payoff([r("allowance_weekly", 50)], 5000)).toBe(30000);
    expect(payoff([r("allowance_weekly", 50), r("needs_classification", -30)], 2000)).toBe(30000);
  });
});

describe("refund-link signature — markers dropped as whole words", () => {
  it.each([
    ["KROGER #442 REFUND", "kroger"],
    ["KROGER #442", "kroger"],
    ["REFUND: BEST BUY 00123", "best buy"],
    ["AMAZON.COM RETURN", "amazon com"],
    ["TARGET CREDIT", "target"],
    ["RFND WALMART", "walmart"],
    ["COSTCO WHSE #1180 RETURNS", "costco whse"],
    ["CREDIT KARMA", "karma"],
    ["CREDIT KARMA REFUND", "karma"],
    ["REFUND", ""],
    ["TRADER JOE'S #552", "trader joe's"],
  ])("%s → %s", (input, sig) => {
    expect(refundSignature(input)).toBe(sig);
  });

  it("merchant memory keeps the plain signature", () => {
    expect(merchantSignature("KROGER #442 REFUND")).toBe("kroger refund");
    expect(merchantSignature("CREDIT KARMA")).toBe("credit karma");
    expect(REFUND_SIGNATURE_MARKERS).toEqual(expect.arrayContaining(["refund", "credit", "return", "rfnd"]));
  });
});
