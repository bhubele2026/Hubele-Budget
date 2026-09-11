import { describe, it, expect } from "vitest";
import {
  classifyOutflow,
  isRealSpend,
  isUncategorizedSpend,
  matchesCardPaymentPattern,
  PFC_CARD_PAYMENT,
  type OutflowKind,
  type OutflowRule,
  type SpendContext,
  type SpendTxn,
} from "./spendingFilter";
import { CARD_PAYMENT_PATTERNS, SEED_MAPPING_RULES } from "./mappingSeed";

// (PR7) The one spending rule, as a table. First match wins; each row below is
// built so that it trips exactly the rule it names and nothing earlier.

const ctx: SpendContext = {
  categoriesById: new Map([
    ["groceries", { name: "Groceries", debtId: null, kind: "expense" }],
    ["misc", { name: "Misc / Buffer", debtId: null, kind: "expense" }],
    ["sky", { name: "Amex Delta SkyMiles Gold (28.49%)", debtId: "debt-sky", kind: "expense" }],
    ["transfer", { name: "Transfer", debtId: null, kind: "expense" }],
    ["ignore", { name: "Ignore", debtId: null, kind: "expense" }],
    ["paycheck", { name: "Paycheck", debtId: null, kind: "income" }],
    ["uncat", { name: "Uncategorized", debtId: null, kind: "expense" }],
  ]),
  debtCategoryIds: new Set(["sky"]),
};

/** A $50 grocery charge on Chase: plain categorized spend. */
const base: SpendTxn = {
  amount: "-50.00",
  source: "plaid:chase",
  isTransfer: false,
  categoryId: "groceries",
  description: "HEB GROCERY 0412",
  debtId: null,
  isExternalCardPayment: false,
  reimbursable: false,
  pfcDetailed: null,
  isTransferUserOverridden: false,
};

type Row = [
  label: string,
  patch: Partial<SpendTxn>,
  kind: OutflowKind,
  rule: OutflowRule,
  categorized: boolean,
];

const TABLE: Row[] = [
  ["1 · a transfer flag", { isTransfer: true, categoryId: "transfer" }, "transfer", "1-transfer", false],
  ["2 · a payment tagged to a debt", { debtId: "debt-sky", categoryId: "misc" }, "debt_payment", "2-debt-id", false],
  ["3 · the user's external-card-payment flag", { isExternalCardPayment: true }, "card_payment", "3-external-card-payment", false],
  ["4 · a category linked to a debt", { categoryId: "sky", description: "AMEX EPAYMENT ACH PMT" }, "debt_payment", "4-debt-category", false],
  ["5 · an excluded category name", { categoryId: "ignore" }, "excluded_category", "5-excluded-category", false],
  ["6 · an income category", { categoryId: "paycheck", description: "PAYROLL REVERSAL" }, "income", "6-income-category", false],
  ["7 · a reimbursable charge", { reimbursable: true, source: "plaid:amex" }, "reimbursable", "7-reimbursable", false],
  ["8 · Plaid calls it a credit-card payment", { categoryId: "misc", description: "PAYMENT 88231", pfcDetailed: PFC_CARD_PAYMENT }, "card_payment", "8-pfc-card-payment", false],
  ["9 · the description names a card payment", { categoryId: "misc", description: "CAPITAL ONE   CRCARDPMT 5KX9" }, "card_payment", "9-card-payment-pattern", false],
  ["9b · bank noise, unchanged from before PR7", { categoryId: "misc", description: "ORIG CO NAME:ACME ACH PMT WEB ID: 1234" }, "bank_noise", "9b-bank-noise", false],
  ["10 · a categorized purchase", {}, "spend", "10-spend", true],
  ["10 · an uncategorized purchase", { categoryId: null }, "spend", "10-spend", false],
];

describe("classifyOutflow — the 12-row table", () => {
  it.each(TABLE)("%s", (_label, patch, kind, rule, categorized) => {
    const tx = { ...base, ...patch };
    expect(classifyOutflow(tx, ctx)).toEqual({ kind, rule, categorized });
    // The wrappers are the rule, not a second copy of it.
    expect(isRealSpend(tx, ctx)).toBe(kind === "spend" && categorized);
    expect(isUncategorizedSpend(tx, ctx)).toBe(kind === "spend" && !categorized);
  });

  it("covers every rule exactly once, in order", () => {
    expect(TABLE.map((r) => r[3])).toEqual([
      "1-transfer",
      "2-debt-id",
      "3-external-card-payment",
      "4-debt-category",
      "5-excluded-category",
      "6-income-category",
      "7-reimbursable",
      "8-pfc-card-payment",
      "9-card-payment-pattern",
      "9b-bank-noise",
      "10-spend",
      "10-spend",
    ]);
  });
});

describe("classifyOutflow — the edges", () => {
  it("an inflow is not an outflow, whatever else it carries", () => {
    expect(classifyOutflow({ ...base, amount: "2000.00", categoryId: "paycheck" }, ctx).kind).toBe(
      "not_outflow",
    );
    // A card payment arriving on the card itself (positive on a Plaid card) is an inflow too.
    expect(
      classifyOutflow({ ...base, amount: "100.00", description: "AMEX EPAYMENT", source: "plaid:amex" }, ctx)
        .kind,
    ).toBe("not_outflow");
    // Manual Amex rows store a charge as POSITIVE.
    expect(classifyOutflow({ ...base, amount: "50.00", source: "amex" }, ctx)).toEqual({
      kind: "spend",
      rule: "10-spend",
      categorized: true,
    });
  });

  it("first match wins: a transfer tagged to a debt is a transfer", () => {
    expect(classifyOutflow({ ...base, isTransfer: true, debtId: "debt-sky" }, ctx).rule).toBe("1-transfer");
    // A reimbursable card payment is a card payment.
    expect(
      classifyOutflow({ ...base, reimbursable: true, isExternalCardPayment: true }, ctx).rule,
    ).toBe("3-external-card-payment");
  });

  it("a deleted category counts as uncategorized spend, not as nothing", () => {
    const tx = { ...base, categoryId: "a-category-that-was-deleted" };
    expect(classifyOutflow(tx, ctx)).toEqual({ kind: "spend", rule: "10-spend", categorized: false });
    expect(isUncategorizedSpend(tx, ctx)).toBe(true);
  });

  it("the system Uncategorized category is not excluded", () => {
    expect(classifyOutflow({ ...base, categoryId: "uncat" }, ctx).kind).toBe("spend");
  });

  describe("'this was a purchase' (isTransferUserOverridden with isTransfer=false)", () => {
    const said = { isTransferUserOverridden: true, isTransfer: false };

    it("skips the description match (rule 9)", () => {
      const tx = { ...base, ...said, categoryId: "misc", description: "APPLECARD GSBANK PAYMENT" };
      expect(classifyOutflow({ ...tx, isTransferUserOverridden: false }, ctx).rule).toBe(
        "9-card-payment-pattern",
      );
      expect(classifyOutflow(tx, ctx)).toEqual({ kind: "spend", rule: "10-spend", categorized: true });
    });

    it("skips Plaid's card-payment category (rule 8)", () => {
      const tx = { ...base, ...said, pfcDetailed: PFC_CARD_PAYMENT };
      expect(classifyOutflow(tx, ctx).rule).toBe("10-spend");
    });

    it("never beats a recorded fact (rules 1–7) or bank noise (9b)", () => {
      expect(classifyOutflow({ ...base, ...said, isExternalCardPayment: true }, ctx).rule).toBe(
        "3-external-card-payment",
      );
      expect(classifyOutflow({ ...base, ...said, debtId: "debt-sky" }, ctx).rule).toBe("2-debt-id");
      expect(classifyOutflow({ ...base, ...said, reimbursable: true }, ctx).rule).toBe("7-reimbursable");
      expect(
        classifyOutflow({ ...base, ...said, description: "AMERICAN EXPRESS ACH PMT" }, ctx).rule,
      ).toBe("9b-bank-noise");
    });

    it("a user-set transfer stays a transfer", () => {
      expect(classifyOutflow({ ...base, isTransferUserOverridden: true, isTransfer: true }, ctx).rule).toBe(
        "1-transfer",
      );
    });
  });

  it("the Amex payoff option counts a reimbursable charge and nothing else", () => {
    const reimb = { ...base, reimbursable: true };
    expect(isRealSpend(reimb, ctx)).toBe(false);
    expect(isRealSpend(reimb, ctx, { reimbursableIsSpend: true })).toBe(true);
    const cardPayment = { ...base, description: "DISCOVER E-PAYMENT 7788" };
    expect(isRealSpend(cardPayment, ctx, { reimbursableIsSpend: true })).toBe(false);
  });
});

describe("CARD_PAYMENT_PATTERNS", () => {
  it("recognizes the card payments the seed rules name", () => {
    const merchants = new Set(["MATTRESS FIRM", "AFFIRM"]); // a store charge, not a payment
    const seeded = SEED_MAPPING_RULES.filter(
      (r) =>
        r.categoryName === "Misc / Buffer" &&
        !merchants.has(r.pattern) &&
        !["NELNET", "DEPT OF ED"].includes(r.pattern), // student loans, not cards
    );
    expect(seeded.length).toBeGreaterThan(10);
    for (const r of seeded) {
      expect(matchesCardPaymentPattern(`${r.pattern} 000123`), r.pattern).toBe(true);
    }
  });

  it("does not catch a purchase at a store that also offers a card", () => {
    for (const d of ["MATTRESS FIRM #1123", "MENARDS 3011", "AFFIRM *BEST BUY", "CITI TRENDS 4421", "DISCOVER BOOKS"]) {
      expect(matchesCardPaymentPattern(d), d).toBe(false);
    }
  });

  it("are lowercase, whitespace-normal and unique, so a raw bank string can match", () => {
    for (const p of CARD_PAYMENT_PATTERNS) {
      expect(p).toBe(p.toLowerCase().replace(/\s+/g, " ").trim());
    }
    expect(new Set(CARD_PAYMENT_PATTERNS).size).toBe(CARD_PAYMENT_PATTERNS.length);
  });
});
