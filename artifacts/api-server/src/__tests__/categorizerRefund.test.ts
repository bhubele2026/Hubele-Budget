// (B6) A refund row gets a decision — the categorizer's pure stages.
//
//   match            a credit that signs like an earlier purchase (≤ 90 days, ≤ its amount)
//                    → a QUEUE decision proposing that purchase's category,
//                      "Refund of <purchase> on <date>", linked (refund_of_txn_id)
//   no prior charge  a credit the spending rule calls a refund → a plain queue decision
//   never filed      memory / a rule / a recurring item never files a linked refund
// See docs/reviews/2026-10-08-b6-refunds.md.

import { describe, expect, it } from "vitest";
import { decideRow } from "../lib/categorizer/decide";
import { bandFor } from "../lib/categorizer/bands";
import { contentVersions, groupOutflows, spendContextOf } from "../lib/categorizer/context";
import { findRefundOf, heuristicStage, REFUND_WINDOW_DAYS } from "../lib/categorizer/stages/heuristic";
import type { EngineContext, EngineRow, MemoryRow } from "../lib/categorizer/types";
import type { RuleRow } from "../lib/autoCategorize";

const AMEX = "amex-1005";
const CHASE = "chase-1234";

function row(o: Partial<EngineRow> = {}): EngineRow {
  return {
    id: "refund-1",
    description: "KROGER #442 REFUND",
    amount: "20.00",
    source: "plaid:amex",
    plaidAccountId: AMEX,
    pfcPrimary: "FOOD_AND_DRINK",
    pfcDetailed: "FOOD_AND_DRINK_GROCERIES",
    pending: false,
    occurredOn: "2026-10-08",
    createdAt: new Date("2026-10-08T17:00:00Z"),
    categoryId: null,
    categoryLockedByUser: false,
    categoryProvisional: false,
    isTransfer: false,
    isTransferUserOverridden: false,
    isExternalCardPayment: false,
    debtId: null,
    reimbursable: false,
    weeklyAllowance: false,
    monthlyAllowance: false,
    unplannedAllowance: false,
    weeklyBucket: null,
    refundOfTxnId: null,
    ...o,
  };
}

type Outflow = Parameters<typeof groupOutflows>[0][number];
const PURCHASES: Outflow[] = [
  { id: "amex-kroger", description: "KROGER #442", amount: "-86.33", source: "plaid:amex", occurredOn: "2026-10-06", categoryId: "groceries", plaidAccountId: AMEX },
  // Later, bigger, but on another account: the card's own purchase still wins.
  { id: "chase-kroger", description: "KROGER #442", amount: "-142.10", source: "plaid:chase", occurredOn: "2026-10-07", categoryId: null, plaidAccountId: CHASE },
  { id: "old-shop", description: "SHOPCO STORE 0101", amount: "-40.00", source: "plaid:chase", occurredOn: "2026-07-01", categoryId: "shopping", plaidAccountId: CHASE },
];

function context(o: { outflows?: Outflow[]; memory?: MemoryRow[]; rules?: RuleRow[] } = {}): EngineContext {
  const memory = o.memory ?? [];
  const rules = o.rules ?? [];
  return {
    rules,
    memoryBySignature: memory.reduce((m, r) => m.set(r.signature, [...(m.get(r.signature) ?? []), r]), new Map<string, MemoryRow[]>()),
    recurring: [],
    replacedBy: new Map(),
    uncategorizedIds: new Set(["uncat"]),
    spendCtx: spendContextOf([
      { id: "groceries", name: "Groceries", debtId: null, kind: "expense" },
      { id: "shopping", name: "Shopping", debtId: null, kind: "expense" },
      { id: "paycheck", name: "Paycheck", debtId: null, kind: "income" },
      { id: "uncat", name: "Uncategorized", debtId: null, kind: "expense" },
    ]),
    outflowsBySignature: groupOutflows(o.outflows ?? PURCHASES),
    versions: contentVersions(rules, memory, []),
  };
}

const memoryRow = (signature: string, categoryId: string, count: number): MemoryRow => ({
  id: `m-${signature}`,
  signature,
  scope: "merchant",
  plaidAccountId: null,
  amountBandLo: null,
  amountBandHi: null,
  categoryId,
  count,
  createdAt: new Date("2026-01-01T00:00:00Z"),
});

describe("a refund that matches an earlier purchase", () => {
  it("B4 S4: 'KROGER #442 REFUND' links to the card's KROGER #442 and is queued proposing Groceries", () => {
    const d = decideRow(row(), context());
    expect(d).toEqual({
      source: "refund",
      categoryId: "groceries",
      confidence: 0.55,
      explanation: "Refund of KROGER #442 on 2026-10-06",
      refundOfTxnId: "amex-kroger",
    });
    expect(bandFor(d!.confidence)).toBe("queue");
  });

  it("with no purchase on its own account, the latest matching purchase anywhere", () => {
    const d = decideRow(row({ plaidAccountId: "amex-other" }), context());
    expect(d).toMatchObject({ refundOfTxnId: "chase-kroger", categoryId: null, explanation: "Refund of KROGER #442 on 2026-10-07" });
  });

  it("is never auto-filed: memory (3+ confirmations) and a rule for the merchant do not file it", () => {
    const ctx = context({
      memory: [memoryRow("kroger", "groceries", 5), memoryRow("kroger refund", "groceries", 5)],
      rules: [{ id: "r1", pattern: "KROGER", matchType: "contains", categoryId: "groceries", priority: 0 }],
    });
    // Unmarked, the credit signs exactly like the purchase in memory.
    for (const description of ["KROGER #442 REFUND", "KROGER #442"]) {
      const d = decideRow(row({ description }), ctx);
      expect(d?.source, description).toBe("refund");
      expect(bandFor(d!.confidence), description).toBe("queue");
    }
    // A purchase of the same merchant still goes to memory.
    expect(decideRow(row({ id: "buy", amount: "-10.00", description: "KROGER #442" }), ctx)?.source).toBe("memory");
  });

  it(`looks back ${REFUND_WINDOW_DAYS} days, inclusive, and never at a later or smaller purchase`, () => {
    const at = (occurredOn: string, amount = "15.00") => findRefundOf(row({ description: "SHOPCO STORE 0101", plaidAccountId: CHASE, source: "plaid:chase", occurredOn, amount }), context());
    expect(REFUND_WINDOW_DAYS).toBe(90);
    expect(at("2026-09-29")?.id).toBe("old-shop"); // 90 days after 7/01
    expect(at("2026-09-30")).toBeNull(); // 91 days
    expect(at("2026-06-30")).toBeNull(); // before the purchase
    expect(at("2026-08-01", "40.01")).toBeNull(); // more than was paid
    expect(at("2026-08-01", "40.00")?.id).toBe("old-shop");
  });

  it("never links what is not a refund: a transfer, the card's payment, an income-filed deposit", () => {
    const ctx = context();
    expect(findRefundOf(row({ isTransfer: true }), ctx)).toBeNull();
    expect(findRefundOf(row({ pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" }), ctx)).toBeNull();
    expect(findRefundOf(row({ description: "KROGER PAYMENT THANK YOU" }), ctx)).toBeNull();
    expect(findRefundOf(row({ categoryId: "paycheck" }), ctx)).toBeNull();
    expect(findRefundOf(row({ amount: "-20.00" }), ctx)).toBeNull(); // a purchase
  });
});

describe("a refund with no prior charge", () => {
  it("on the card: a plain queue decision, no category, no link", () => {
    const d = decideRow(row({ description: "DELTA AIR LINES REFUND" }), context());
    expect(d).toEqual({
      source: "refund",
      categoryId: null,
      confidence: 0.55,
      explanation: "Looks like a refund; no earlier purchase matched.",
    });
  });

  it("memory or a rule may still file a credit that matched no purchase (as before B6)", () => {
    const ctx = context({ memory: [memoryRow("delta air lines refund", "shopping", 4)] });
    expect(decideRow(row({ description: "DELTA AIR LINES REFUND" }), ctx)?.source).toBe("memory");
  });

  it("off the card, only with a refund word; a paycheck or a payment arriving gets nothing", () => {
    const chk = (description: string, o: Partial<EngineRow> = {}) =>
      heuristicStage(row({ description, source: "plaid:chase", plaidAccountId: CHASE, pfcPrimary: null, pfcDetailed: null, ...o }), context());
    expect(chk("AMAZON.COM REFUND")?.source).toBe("refund");
    expect(chk("ACME PAYROLL")).toBeNull();
    expect(chk("ONLINE TRANSFER FROM SAV 9")).toBeNull();
    expect(heuristicStage(row({ description: "ONLINE PAYMENT - THANK YOU", pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" }), context())).toBeNull();
  });
});
