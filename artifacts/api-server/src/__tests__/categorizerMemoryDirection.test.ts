// (F2) Merchant memory is SIGN-AWARE — the categorizer's pure memory stage.
// Synthetic names only.
//
//   payroll vs cafeteria  a paycheck credit and the small card charges at the
//                         same employer share one merchant signature; money in
//                         reads `in:<signature>`, money out the plain one, so
//                         neither ever takes the other's category
//   legacy rows           a memory learned before F2 under the plain signature
//                         into an INCOME category is money in's (a paycheck);
//                         one into an expense category is money out's
//   refunds               money back on a card (or with a REFUND word) may read
//                         the purchase's own memory — it nets that category; a
//                         plain deposit never does
//   transfers             a transfer out keeps reading the plain signature

import { describe, expect, it } from "vitest";
import { contentVersions, groupOutflows, spendContextOf } from "../lib/categorizer/context";
import { decideRow } from "../lib/categorizer/decide";
import { memoryStage } from "../lib/categorizer/stages/memory";
import type { EngineContext, EngineRow, MemoryRow } from "../lib/categorizer/types";
import { memoryDirectionOf, memoryKeyOf, memoryRowDirection, parseMemoryKey } from "../lib/merchantNameExtract";

const CARD = "card-2002";
const CHECKING = "chk-1001";
const PAYROLL = "ORIG CO NAME:MAPLEWORKS INC CO ENTRY DESCR:PAYROLL SEC:PPD ORIG ID:5555";

function row(o: Partial<EngineRow> = {}): EngineRow {
  return {
    id: "r1",
    description: "MAPLEWORKS INC",
    amount: "-8.50",
    source: "plaid:amex",
    plaidAccountId: CARD,
    pfcPrimary: null,
    pfcDetailed: null,
    pending: false,
    occurredOn: "2026-10-12",
    createdAt: new Date("2026-10-12T17:00:00Z"),
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

const payroll = (o: Partial<EngineRow> = {}) =>
  row({ description: PAYROLL, amount: "2391.40", source: "plaid:chase", plaidAccountId: CHECKING, ...o });

const mem = (signature: string, categoryId: string, count = 3): MemoryRow => ({
  id: `m-${signature}-${categoryId}`,
  signature,
  scope: "merchant",
  plaidAccountId: null,
  amountBandLo: null,
  amountBandHi: null,
  categoryId,
  count,
  createdAt: new Date("2026-01-01T00:00:00Z"),
});

function context(memory: MemoryRow[]): EngineContext {
  return {
    rules: [],
    memoryBySignature: memory.reduce((m, r) => m.set(r.signature, [...(m.get(r.signature) ?? []), r]), new Map<string, MemoryRow[]>()),
    recurring: [],
    replacedBy: new Map(),
    uncategorizedIds: new Set(["uncat"]),
    spendCtx: spendContextOf([
      { id: "dining", name: "Dining & Coffee", debtId: null, kind: "expense" },
      { id: "groceries", name: "Groceries", debtId: null, kind: "expense" },
      { id: "paycheck", name: "Paycheck", debtId: null, kind: "income" },
      { id: "uncat", name: "Uncategorized", debtId: null, kind: "expense" },
    ]),
    accounts: new Map([
      [CARD, { type: "credit", subtype: "credit card", institutionSlug: "amex" }],
      [CHECKING, { type: "depository", subtype: "checking", institutionSlug: "chase" }],
    ]),
    outflowsBySignature: groupOutflows([]),
    versions: contentVersions([], memory, []),
  };
}

describe("memory keys", () => {
  it("money in keys under in:<signature>; money out under the plain signature; a workbook Amex charge (positive) is out", () => {
    expect(memoryKeyOf(payroll())).toBe("in:mapleworks inc");
    expect(memoryKeyOf(row())).toBe("mapleworks inc");
    expect(memoryDirectionOf({ amount: "8.50", source: "amex" })).toBe("out");
    expect(memoryDirectionOf({ amount: "-8.50", source: "amex" })).toBe("in");
    expect(memoryKeyOf({ description: "", amount: "1", source: "plaid:chase" })).toBe("");
    expect(parseMemoryKey("in:mapleworks inc")).toEqual({ signature: "mapleworks inc", inKey: true });
    expect(parseMemoryKey("mapleworks inc")).toEqual({ signature: "mapleworks inc", inKey: false });
    expect(memoryRowDirection("in:mapleworks inc", "expense")).toBe("in");
    expect(memoryRowDirection("mapleworks inc", "income")).toBe("in");
    expect(memoryRowDirection("mapleworks inc", "expense")).toBe("out");
  });
});

describe("⭐ a payroll credit and same-name card purchases never share a memory", () => {
  const ctx = context([mem("mapleworks inc", "dining"), mem("in:mapleworks inc", "paycheck")]);

  it("each reads its own: the paycheck → Paycheck, the cafeteria charge → Dining", () => {
    expect(memoryStage(payroll(), ctx)).toMatchObject({ source: "memory", categoryId: "paycheck", confidence: 0.92 });
    expect(memoryStage(row(), ctx)).toMatchObject({ source: "memory", categoryId: "dining" });
    expect(decideRow(payroll(), ctx)).toMatchObject({ categoryId: "paycheck", confidence: 0.92 });
    expect(decideRow(row(), ctx)).toMatchObject({ categoryId: "dining", confidence: 0.92 });
  });

  it("with only the purchases' memory, the paycheck takes nothing from it (before F2: Dining, sent to the queue)", () => {
    const only = context([mem("mapleworks inc", "dining")]);
    expect(memoryStage(payroll(), only)).toBeNull();
    expect(decideRow(payroll(), only)?.categoryId ?? null).not.toBe("dining");
  });

  it("with only the paycheck's memory, a cafeteria charge takes nothing from it", () => {
    expect(memoryStage(row(), context([mem("in:mapleworks inc", "paycheck")]))).toBeNull();
  });

  it("a legacy (pre-F2) plain row into an INCOME category stays the paycheck's", () => {
    const legacy = context([mem("mapleworks inc", "paycheck")]);
    expect(memoryStage(payroll(), legacy)).toMatchObject({ categoryId: "paycheck" });
    expect(memoryStage(row(), legacy)).toBeNull();
    // The new key wins over a legacy row.
    const both = context([mem("mapleworks inc", "paycheck", 9), mem("in:mapleworks inc", "dining", 1)]);
    expect(memoryStage(payroll(), both)).toMatchObject({ categoryId: "dining" });
  });
});

describe("refunds and transfers", () => {
  const ctx = context([mem("grocery mart", "groceries")]);

  it("money back on a card nets the purchase's category (it may read the purchase's memory)", () => {
    expect(memoryStage(row({ description: "GROCERY MART", amount: "12.00" }), ctx)).toMatchObject({ categoryId: "groceries" });
    // The same name as a plain deposit on checking is not a refund: it never reads the purchase's memory.
    expect(memoryStage(row({ description: "GROCERY MART", amount: "12.00", source: "plaid:chase", plaidAccountId: CHECKING }), ctx)).toBeNull();
  });

  it("its own money-in memory wins over the purchase's", () => {
    const own = context([mem("grocery mart", "groceries"), mem("in:grocery mart", "dining")]);
    expect(memoryStage(row({ description: "GROCERY MART", amount: "12.00" }), own)).toMatchObject({ categoryId: "dining" });
  });

  it("a transfer out reads the plain signature like any money out", () => {
    const t = context([mem("online transfer to sav", "groceries")]);
    expect(memoryStage(row({ description: "ONLINE TRANSFER TO SAV ...7703", amount: "-300.00", source: "plaid:chase", plaidAccountId: CHECKING, isTransfer: true }), t)).toMatchObject({
      categoryId: "groceries",
    });
    // The same signature as money IN (a transfer back) never reads it.
    expect(memoryStage(row({ description: "ONLINE TRANSFER TO SAV ...7703", amount: "300.00", source: "plaid:chase", plaidAccountId: CHECKING }), t)).toBeNull();
  });
});
