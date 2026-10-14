// (S5) The card summary's pure rules.
//
//   classifyCardCredit   what one row did to the card: purchase · other_charge ·
//                        refund · payment · other_credit (null for $0.00)
//   amexCardLabel        a card's name: the household's, else its tier word, else Plaid's
//   avalancheRankOf      a debt's place in the avalanche order (targetIndex, repeated)
//
// The equivalence block is the load-bearing one: `computeWeeklyPayoff` now
// bills through `classifyCardCredit`, so "purchase" and "refund" must be
// exactly the tests it used before (`classifyOutflow(…).kind === "spend"`,
// `classifyRefund`) on every row.

import { describe, expect, it } from "vitest";
import {
  AMEX_TIER_LABEL,
  PFC_CARD_PAYMENT,
  amexCardLabel,
  amexEffectiveTier,
  classifyCardCredit,
  classifyOutflow,
  classifyRefund,
  creditAmount,
  spendAmount,
  type SpendContext,
  type SpendTxn,
} from "@workspace/avalanche-core";
import { avalancheRankOf } from "./avalancheSim";

const cats: SpendContext["categoriesById"] = new Map([
  ["groceries", { name: "Groceries", debtId: null, kind: "expense" }],
  ["paycheck", { name: "Paycheck", debtId: null, kind: "income" }],
  ["ignore", { name: "Ignore", debtId: null, kind: "expense" }],
  ["transfer", { name: "Transfer", debtId: null, kind: "expense" }],
  ["card-payoff", { name: "Card Payoff", debtId: "debt-1", kind: "expense" }],
]);
const ctx: SpendContext = { categoriesById: cats, debtCategoryIds: new Set(["card-payoff"]) };
const OWED = { reimbursableIsSpend: true };

/** A Plaid Amex row: negative = a charge, positive = a credit (the stored sign). */
function tx(over: Partial<SpendTxn> = {}): SpendTxn {
  return {
    amount: "-40.00",
    source: "plaid:amex",
    isTransfer: false,
    categoryId: null,
    description: "WHOLE FOODS #123",
    debtId: null,
    isExternalCardPayment: false,
    reimbursable: false,
    pfcDetailed: null,
    ...over,
  };
}

describe("classifyCardCredit — one bucket per card row", () => {
  it("a charge the spending rule calls spend is a purchase, filed or not, reimbursable or not (with the payoff's option)", () => {
    expect(classifyCardCredit(tx(), ctx, OWED)).toBe("purchase");
    expect(classifyCardCredit(tx({ categoryId: "groceries" }), ctx, OWED)).toBe("purchase");
    expect(classifyCardCredit(tx({ reimbursable: true }), ctx, OWED)).toBe("purchase");
    // Without the option, rule 7 drops a reimbursable charge: not a purchase.
    expect(classifyCardCredit(tx({ reimbursable: true }), ctx)).toBe("other_charge");
    // The workbook stores a charge positive.
    expect(classifyCardCredit(tx({ source: "amex", amount: "40.00" }), ctx, OWED)).toBe("purchase");
  });

  it("a charge the spending rule leaves out is other_charge: transfer, debt row, Ignore, debt category", () => {
    expect(classifyCardCredit(tx({ isTransfer: true }), ctx, OWED)).toBe("other_charge");
    expect(classifyCardCredit(tx({ debtId: "debt-9" }), ctx, OWED)).toBe("other_charge");
    expect(classifyCardCredit(tx({ categoryId: "ignore" }), ctx, OWED)).toBe("other_charge");
    expect(classifyCardCredit(tx({ categoryId: "card-payoff" }), ctx, OWED)).toBe("other_charge");
  });

  it("money back on the card is a refund (Plaid and workbook signs)", () => {
    expect(classifyCardCredit(tx({ amount: "15.00" }), ctx, OWED)).toBe("refund");
    expect(classifyCardCredit(tx({ amount: "15.00", description: "KROGER #442 REFUND" }), ctx, OWED)).toBe("refund");
    expect(classifyCardCredit(tx({ source: "amex", amount: "-15.00" }), ctx, OWED)).toBe("refund");
    // A reimbursable credit nets the card only with the payoff's option.
    expect(classifyCardCredit(tx({ amount: "15.00", reimbursable: true }), ctx, OWED)).toBe("refund");
    expect(classifyCardCredit(tx({ amount: "15.00", reimbursable: true }), ctx)).toBe("other_credit");
  });

  it("a payment to the card is a payment, never a refund", () => {
    const pay = (over: Partial<SpendTxn>) => classifyCardCredit(tx({ amount: "200.00", ...over }), ctx, OWED);
    expect(pay({ description: "ONLINE PAYMENT - THANK YOU" })).toBe("payment");
    expect(pay({ description: "AUTOPAY PYMT" })).toBe("payment");
    expect(pay({ description: "AMEX EPAYMENT ACH PMT" })).toBe("payment");
    expect(pay({ description: "MOBILE DEPOSIT", pfcDetailed: PFC_CARD_PAYMENT })).toBe("payment");
    expect(pay({ description: "MOBILE DEPOSIT", isExternalCardPayment: true })).toBe("payment");
    expect(pay({ description: "MOBILE DEPOSIT", debtId: "debt-1" })).toBe("payment");
    expect(pay({ description: "MOBILE DEPOSIT", categoryId: "card-payoff" })).toBe("payment");
    // A payment the household also flagged as a transfer is still a payment.
    expect(pay({ description: "PAYMENT RECEIVED", isTransfer: true })).toBe("payment");
  });

  it("any other credit is other_credit: a transfer, an excluded or income category, a Plaid transfer category", () => {
    const credit = (over: Partial<SpendTxn>) => classifyCardCredit(tx({ amount: "10.00", description: "BALANCE ADJ", ...over }), ctx, OWED);
    expect(credit({ isTransfer: true })).toBe("other_credit");
    expect(credit({ categoryId: "transfer" })).toBe("other_credit");
    expect(credit({ categoryId: "paycheck" })).toBe("other_credit");
    expect(credit({ pfcDetailed: "TRANSFER_IN_ACCOUNT_TRANSFER" })).toBe("other_credit");
  });

  it("⚠️ a credit on another bank's card with no REFUND word stays other_credit (the card-ledger rule is Amex-only; S6 owns it)", () => {
    expect(classifyCardCredit(tx({ source: "plaid:chase", amount: "15.00" }), ctx, OWED)).toBe("other_credit");
    expect(classifyCardCredit(tx({ source: "plaid:chase", amount: "15.00", description: "TARGET REFUND" }), ctx, OWED)).toBe("refund");
  });

  it("a $0.00 row is nothing", () => {
    expect(classifyCardCredit(tx({ amount: "0.00" }), ctx, OWED)).toBeNull();
    expect(classifyCardCredit(tx({ amount: "not a number" }), ctx, OWED)).toBeNull();
  });

  it("⭐ purchase ⇔ classifyOutflow spend and refund ⇔ classifyRefund — the payoff's own tests, on 6,000 seeded rows", () => {
    // A small deterministic generator (mulberry32) so a failure reproduces.
    let seed = 0x5eed5;
    const rnd = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const descriptions = ["WHOLE FOODS #123", "ONLINE PAYMENT - THANK YOU", "KROGER REFUND", "AMEX EPAYMENT", "ONLINE TRANSFER", "AUTOPAY", "TAX REFUND IRS", "SHELL OIL"];
    const categories = [null, "groceries", "paycheck", "ignore", "transfer", "card-payoff", "deleted-cat"];
    const pfcs = [null, PFC_CARD_PAYMENT, "TRANSFER_IN_ACCOUNT_TRANSFER", "INCOME_WAGES", "FOOD_AND_DRINK_GROCERIES"];
    const sources = ["plaid:amex", "amex", "plaid:chase", "manual"];
    let purchases = 0;
    let refunds = 0;
    for (let i = 0; i < 6000; i += 1) {
      const row = tx({
        amount: (Math.round((rnd() - 0.5) * 40000) / 100).toFixed(2),
        source: pick(sources),
        isTransfer: rnd() < 0.1,
        categoryId: pick(categories),
        description: pick(descriptions),
        debtId: rnd() < 0.05 ? "debt-1" : null,
        isExternalCardPayment: rnd() < 0.05,
        reimbursable: rnd() < 0.15,
        pfcDetailed: pick(pfcs),
      });
      for (const opts of [OWED, {}]) {
        const kind = classifyCardCredit(row, ctx, opts);
        const label = JSON.stringify({ row, opts });
        expect(kind === "purchase", label).toBe(classifyOutflow(row, ctx, opts).kind === "spend");
        expect(kind === "refund", label).toBe(classifyRefund(row, ctx, opts) !== null);
        // Every row with money in it lands somewhere; a charge is never a credit kind and back.
        if (spendAmount(row) > 0) expect(["purchase", "other_charge"], label).toContain(kind);
        else if (creditAmount(row) > 0) expect(["refund", "payment", "other_credit"], label).toContain(kind);
        else expect(kind, label).toBeNull();
        if (kind === "purchase") purchases += 1;
        if (kind === "refund") refunds += 1;
      }
    }
    // The seeded set exercises both sides.
    expect(purchases).toBeGreaterThan(500);
    expect(refunds).toBeGreaterThan(100);
  });
});

describe("amexCardLabel — the household's name, else the tier word, else Plaid's", () => {
  it("names the card the way the card band and the card tabs do", () => {
    expect(AMEX_TIER_LABEL).toEqual({ blue: "Blue Cash", silver: "Platinum" });
    const base = { accountId: "a1", plaidName: "Gold Card" };
    expect(amexCardLabel({ ...base, serverBrand: "silver", names: { a1: "Travel card" } })).toBe("Travel card");
    expect(amexCardLabel({ ...base, serverBrand: "silver" })).toBe("Platinum");
    expect(amexCardLabel({ ...base, serverBrand: "blue" })).toBe("Blue Cash");
    // The owner's tier override wins; a legacy "gold" reads Platinum.
    expect(amexCardLabel({ ...base, serverBrand: "silver", brands: { a1: "blue" } })).toBe("Blue Cash");
    expect(amexCardLabel({ ...base, serverBrand: "blue", brands: { a1: "gold" } })).toBe("Platinum");
    // An empty saved name is no name.
    expect(amexCardLabel({ ...base, serverBrand: "blue", names: { a1: "" } })).toBe("Blue Cash");
    expect(amexEffectiveTier("a1", "gold", null)).toBe("silver");
  });
});

describe("avalancheRankOf — the avalanche order, one targetIndex at a time", () => {
  const debt = (id: string, apr: string, balance: string, status = "active") => ({ id, apr, balance, status });
  it("1 = the debt the plan attacks now; then highest APR, ties to the smaller balance", () => {
    const debts = [debt("car", "0.0600", "5000.00"), debt("amex", "0.2499", "1234.56"), debt("visa", "0.2499", "900.00"), debt("paid", "0.3000", "0.00"), debt("old", "0.3500", "800.00", "archived")];
    expect(avalancheRankOf(debts, "visa")).toBe(1);
    expect(avalancheRankOf(debts, "amex")).toBe(2);
    expect(avalancheRankOf(debts, "car")).toBe(3);
    // No balance, or not on the plan: no place in the order.
    expect(avalancheRankOf(debts, "paid")).toBeNull();
    expect(avalancheRankOf(debts, "old")).toBeNull();
    expect(avalancheRankOf(debts, "nobody")).toBeNull();
  });
});
