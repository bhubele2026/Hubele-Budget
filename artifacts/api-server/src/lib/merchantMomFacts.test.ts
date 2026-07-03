import { describe, it, expect } from "vitest";
import {
  computeMerchantMom,
  type MerchantMomTxn,
} from "./merchantMomFacts";
import type { SpendContext } from "./spendingFilter";

// A single "Dining" expense category so isRealSpend() keeps these rows.
const ctx: SpendContext = {
  categoriesById: new Map([
    ["c-dining", { name: "Dining", debtId: null, kind: "expense" }],
  ]),
  debtCategoryIds: new Set(),
};

// Fixed reference date so the month math is deterministic: July 15, 2026.
// Current month = July (from the 1st); like-for-like last month = June 1–15.
const NOW = new Date("2026-07-15T12:00:00Z");

function tx(occurredOn: string, amount: number, description: string): MerchantMomTxn {
  return {
    occurredOn,
    amount, // negative = spend (bank/Chase convention)
    source: "chase",
    categoryId: "c-dining",
    description,
    isTransfer: false,
  };
}

describe("computeMerchantMom — per-merchant month-over-month", () => {
  const rows: MerchantMomTxn[] = [
    // Starbucks: 6 visits last month through the 15th ($48), 3 this month ($30).
    tx("2026-06-02", -8, "STARBUCKS #123"),
    tx("2026-06-04", -8, "STARBUCKS #123"),
    tx("2026-06-07", -8, "STARBUCKS #123"),
    tx("2026-06-09", -8, "STARBUCKS #123"),
    tx("2026-06-12", -8, "STARBUCKS #123"),
    tx("2026-06-14", -8, "STARBUCKS #999"), // different store # → same signature
    tx("2026-07-03", -10, "STARBUCKS #123"),
    tx("2026-07-08", -10, "STARBUCKS #123"),
    tx("2026-07-12", -10, "STARBUCKS #123"),
    // Mooyah: only this month → new merchant.
    tx("2026-07-05", -16, "MOOYAH 0456"),
    tx("2026-07-11", -16, "MOOYAH 0456"),
    // One-off: a single visit, below the min-visits trust gate → dropped.
    tx("2026-07-06", -20, "ONEOFF CAFE"),
    // Noise that must be excluded:
    { ...tx("2026-07-07", -500, "ONLINE TRANSFER TO SAV"), isTransfer: true },
    { ...tx("2026-07-09", -75, "MYSTERY SHOP"), categoryId: null }, // uncategorized
  ];

  const entries = computeMerchantMom(rows, ctx, { now: NOW });
  const bySig = (sig: string) => entries.find((e) => e.signature === sig);

  it("groups a chain across store numbers into one stable merchant", () => {
    const sb = bySig("starbucks");
    expect(sb).toBeDefined();
    expect(sb!.display.toLowerCase()).toContain("starbucks");
  });

  it("computes spend + visit deltas month-to-date, like-for-like", () => {
    const sb = bySig("starbucks")!;
    expect(sb.curSpend).toBe(30);
    expect(sb.lastSpend).toBe(48);
    expect(sb.deltaAmount).toBe(-18); // spending LESS
    expect(sb.curVisits).toBe(3);
    expect(sb.lastVisits).toBe(6);
    expect(sb.deltaVisits).toBe(-3); // 3 fewer visits
    expect(sb.isNew).toBe(false);
    expect(sb.annualRunRate).toBeGreaterThan(0);
  });

  it("flags a merchant seen only this month as new", () => {
    const mooyah = bySig("mooyah")!;
    expect(mooyah).toBeDefined();
    expect(mooyah.isNew).toBe(true);
    expect(mooyah.curSpend).toBe(32);
    expect(mooyah.lastSpend).toBe(0);
  });

  it("drops merchants below the min-visits trust gate", () => {
    expect(bySig("oneoff cafe")).toBeUndefined();
  });

  it("excludes transfers and uncategorized noise", () => {
    expect(entries.some((e) => /transfer/i.test(e.display))).toBe(false);
    expect(entries.some((e) => /mystery/i.test(e.display))).toBe(false);
  });
});
