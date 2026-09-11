import { describe, it, expect } from "vitest";
import {
  CARD_PAYMENT_WORD_PREFIXES,
  GENERIC_CARD_PAYMENT_PHRASES,
  classifyOutflow,
  isRealSpend,
  isUncategorizedSpend,
  matchesCardPaymentPattern,
  matchesTransferPattern,
  normalizeDescription,
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

  it("the Amex payoff option counts a reimbursable charge and nothing else", () => {
    const reimb = { ...base, reimbursable: true };
    expect(isRealSpend(reimb, ctx)).toBe(false);
    expect(isRealSpend(reimb, ctx, { reimbursableIsSpend: true })).toBe(true);
    const cardPayment = { ...base, description: "DISCOVER E-PAYMENT 7788" };
    expect(isRealSpend(cardPayment, ctx, { reimbursableIsSpend: true })).toBe(false);
  });
});

describe("recognition is automatic (review H1)", () => {
  const payment = { ...base, description: "CAPITAL ONE CRCARDPMT 5KX9" };

  it.each([
    ["uncategorized", null],
    ["filed under Misc / Buffer", "misc"],
    ["filed under Groceries", "groceries"],
    ["in the system Uncategorized category", "uncat"],
    ["in a category since deleted", "gone"],
  ])("a card payment %s is still a card payment", (_label, categoryId) => {
    expect(classifyOutflow({ ...payment, categoryId }, ctx).rule).toBe("9-card-payment-pattern");
  });

  it("ignores the transfer-override flag a hand-picked category sets", () => {
    // Not part of SpendTxn any more; a row read with `select()` still carries it.
    const handFiled = { ...payment, categoryId: "misc", isTransferUserOverridden: true } as SpendTxn;
    expect(classifyOutflow(handFiled, ctx).kind).toBe("card_payment");
    const plaidFiled = { ...base, pfcDetailed: PFC_CARD_PAYMENT, isTransferUserOverridden: true } as SpendTxn;
    expect(classifyOutflow(plaidFiled, ctx).kind).toBe("card_payment");
  });
});

describe("CARD_PAYMENT_PATTERNS", () => {
  it.each([
    "CAPITAL ONE CRCARDPMT 5KX9",
    "CAPITAL ONE MOBILE PYMT",
    "CAPITAL ONE ONLINE PYMT",
    "APPLECARD GSBANK PAYMENT 12345",
    "DISCOVER E-PAYMENT 7788",
    "DISCOVER DC PYMNTS 200112",
    "CITI CARD ONLINE PAYMENT",
    "SYNCHRONY BANK/PAYPAL",
    "SYNCHRONY BANK PAYMENT",
    "PAYPAL *PAYMTHLY",
    "BARCLAYCARD US CREDITCARD",
    "BEST BUY CREDIT CARD PYMT",
    "TARGET CARD SRVC PAYMENT",
    "AMEX EPAYMENT ACH PMT",
    "AMERICAN EXPRESS ACH PMT M1234 WEB ID: 0005000008",
    "ORIG CO NAME:CAPITAL ONE CRCARDPMT ORIG ID:9279744380",
  ])("recognizes %s", (d) => {
    expect(classifyOutflow({ ...base, categoryId: null, description: d }, ctx).rule).toBe(
      "9-card-payment-pattern",
    );
  });

  // Purchases at merchants whose names share words with card issuers, plus the
  // everyday merchants a household ledger is made of. None is a card payment.
  it.each([
    "APPLE STORE R123",
    "APPLE.COM/BILL",
    "APPLECARE PROTECTION",
    "CAPITAL ONE CAFE",
    "Capital One Café #12",
    "CAPITAL ONE ARENA TICKETS",
    "DISCOVER BOOKS",
    "DISCOVERY PLACE MUSEUM",
    "AMERICAN EXPRESS TRAVEL",
    "PAYPAL *NETFLIX",
    "PAYPAL *EBAY INC",
    "ZELLE TO JANE DOE",
    "VENMO *JOHN SMITH",
    "TARGET 00012345",
    "TARGET.COM *ORDER",
    "BEST BUY 00001234",
    "BESTBUY.COM 8053",
    "MATTRESS FIRM #1123",
    "MENARDS 3011",
    "AFFIRM *CASPER",
    "CITI TRENDS 4421",
    "CITIBIKE NYC",
    "CREDIT ONE STADIUM",
    "BARCLAYS CENTER",
    "SYNCHRONY THEATRE",
    "WHOLE FOODS MARKET",
    "HY-VEE 1502",
    "KWIK TRIP 812",
    "DOORDASH*CHIPOTLE",
    "UBER *TRIP",
    "SHELL OIL 57442",
    "COSTCO WHSE #1035",
  ])("does not catch %s", (d) => {
    expect(matchesCardPaymentPattern(d)).toBe(false);
    expect(classifyOutflow({ ...base, categoryId: null, description: d }, ctx).kind).toBe("spend");
  });

  it("matches whole words after punctuation and padding are normalized", () => {
    expect(normalizeDescription("  SYNCHRONY BANK/PAYPAL*  ")).toBe("synchrony bank paypal");
    expect(matchesCardPaymentPattern("capital one    crcardpmt")).toBe(true);
    // A phrase never fires inside a longer word.
    expect(matchesCardPaymentPattern("XCRCARDPMTX")).toBe(false);
  });

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

  it("are written normalized and unique", () => {
    for (const list of [CARD_PAYMENT_PATTERNS, CARD_PAYMENT_WORD_PREFIXES, GENERIC_CARD_PAYMENT_PHRASES]) {
      for (const p of list) {
        expect(p).toBe(normalizeDescription(p));
      }
      expect(new Set(list).size).toBe(list.length);
    }
    // A prefix is one word; a generic phrase is never also an issuer phrase.
    for (const p of CARD_PAYMENT_WORD_PREFIXES) expect(p).not.toContain(" ");
    for (const p of GENERIC_CARD_PAYMENT_PHRASES) expect(CARD_PAYMENT_PATTERNS).not.toContain(p);
  });

  // ── (PR7b) The reviewer's missed strings, and the purchases they must not drag in.
  it.each([
    "Payment to Chase card ending in 1234 09/01",
    "US BANK CREDIT CARD PAYMENT",
    "WF CREDIT CARD AUTO PAY",
    "TARGET CARD SERVICES PAYMENT",
    "CRCARDPMT5KX9ABC",
    "CAPITAL ONE CRCARDPMT5KX9ABC",
    // The same issuers in the forms a bank adds around them.
    "U.S. BANK CREDIT CARD PAYMENT PPD ID: 9000000001",
    "US BANK CREDIT CARD PAYMENT JANE DOE",
    "WF Credit Card AUTO PAY 260901 PPD ID: WFCCAUTOPY",
    // A generic phrase where only a payment puts it.
    "CREDIT CARD PAYMENT",
    "CREDIT CARD PYMT 0412",
    "ELAN CREDIT CARD PYMT PPD ID: ELANCARDAP",
    "FIRST BANKCARD CREDIT CARD AUTO PAY 88231",
    "ORIG CO NAME:FIRST NATIONAL ORIG ID:1234 DESC DATE:0901 CO ENTRY DESCR:CREDIT CARD PAYMENT SEC:PPD TRACE#:0210 EED:260901 IND ID:1234 IND NAME:JANE DOE TRN: 2440 TC",
  ])("(PR7b) recognizes %s", (d) => {
    expect(matchesCardPaymentPattern(d)).toBe(true);
    expect(classifyOutflow({ ...base, categoryId: null, description: d }, ctx).rule).toBe(
      "9-card-payment-pattern",
    );
  });

  it.each([
    // The NIT: a generic phrase inside a business name.
    "CREDIT CARD PYMT SUPPLIES INC",
    "ACME CREDIT CARD PAYMENT SOLUTIONS",
    "SQ *CREDIT CARD PAYMENT SYSTEMS",
    "CREDIT CARD PAYMENT PROCESSING FEE",
    "CREDIT CARD AUTO PAY CENTER LLC",
    // Issuer words in venues and stores.
    "US BANK STADIUM",
    "U.S. BANK STADIUM CONCESSIONS",
    "CHASE CENTER TICKETS",
    "WF CAFE 12",
    "TARGET 00012345 CARD",
    "SERVICES CARD TARGET",
  ])("(PR7b) does not catch %s", (d) => {
    expect(matchesCardPaymentPattern(d)).toBe(false);
    expect(classifyOutflow({ ...base, categoryId: null, description: d }, ctx).kind).toBe("spend");
  });

  it("(PR7b) an issuer code matches at the start of a word only", () => {
    expect(matchesCardPaymentPattern("CRCARDPMT5KX9ABC")).toBe(true);
    expect(matchesCardPaymentPattern("capital one crcardpmt")).toBe(true);
    expect(matchesCardPaymentPattern("XCRCARDPMTX")).toBe(false);
    expect(matchesCardPaymentPattern("ABCRCARDPMT5KX9")).toBe(false);
  });

  it("(PR7b review NIT) 'credit card pymt' is a payment only where a payment puts it", () => {
    expect(matchesCardPaymentPattern("BEST BUY CREDIT CARD PYMT")).toBe(true);
    expect(matchesCardPaymentPattern("BEST BUY CREDIT CARD PYMT 0412 WEB ID: 1234")).toBe(true);
    expect(matchesCardPaymentPattern("CO ENTRY DESCR:CREDIT CARD PYMT SEC:PPD IND NAME:JANE DOE")).toBe(true);
    expect(matchesCardPaymentPattern("CREDIT CARD PYMT SUPPLIES INC")).toBe(false);
    // An ID label vouches for the one word after it, not for everything after.
    expect(matchesCardPaymentPattern("CREDIT CARD PYMT ID 12 SUPPLIES INC")).toBe(false);
    expect(matchesCardPaymentPattern("")).toBe(false);
  });

  it("⚠️ the pre-PR7 bank-noise list is unchanged, including its loose 'epay' (disclosed)", () => {
    expect(matchesTransferPattern("REPAY *PEST CONTROL")).toBe(true);
    expect(matchesTransferPattern("EPAYMENTS PLUMBING LLC")).toBe(true);
  });
});
