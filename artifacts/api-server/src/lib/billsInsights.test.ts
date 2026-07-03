import { describe, it, expect } from "vitest";
import { computeOneOff, type OneOffTxn } from "./billsOneOff";
import type { SpendContext } from "./spendingFilter";

const ctx: SpendContext = {
  categoriesById: new Map([
    ["c-dining", { name: "Dining", debtId: null, kind: "expense" }],
    ["c-util", { name: "Utilities", debtId: null, kind: "expense" }],
  ]),
  debtCategoryIds: new Set(),
};

function tx(
  description: string,
  amount: number,
  categoryId: string | null = "c-dining",
  isTransfer = false,
): OneOffTxn {
  return { description, amount, source: "chase", categoryId, isTransfer };
}

describe("computeOneOff — one-off / non-recurring spend", () => {
  const activeBillNames = ["Madison Gas & Electric", "State Farm", "HELOC (Figure)"];

  it("counts real spend that isn't a tracked recurring bill", () => {
    const txns: OneOffTxn[] = [
      tx("MOOYAH 0456", -32), // one-off dining
      tx("TARGET STORE 12", -50, "c-dining"), // one-off
    ];
    const { total, count } = computeOneOff(txns, ctx, activeBillNames);
    expect(total).toBe(82);
    expect(count).toBe(2);
  });

  it("excludes transactions that match an active recurring bill name", () => {
    const txns: OneOffTxn[] = [
      tx("MADISON GAS & ELECTRIC WEB PMT", -241, "c-util"), // matches bill → excluded
      tx("STATE FARM INSURANCE", -122, "c-util"), // matches bill → excluded
      tx("MOOYAH 0456", -32), // one-off → kept
    ];
    const { total, count } = computeOneOff(txns, ctx, activeBillNames);
    expect(total).toBe(32);
    expect(count).toBe(1);
  });

  it("excludes transfers and uncategorized noise", () => {
    const txns: OneOffTxn[] = [
      tx("ONLINE TRANSFER TO SAV", -500, "c-dining", true), // transfer → excluded
      tx("MYSTERY SHOP", -75, null), // uncategorized → excluded
      tx("CHIPOTLE 900", -18), // one-off → kept
    ];
    const { total, count } = computeOneOff(txns, ctx, activeBillNames);
    expect(total).toBe(18);
    expect(count).toBe(1);
  });

  it("ranks the top one-off merchants by amount", () => {
    const txns: OneOffTxn[] = [
      tx("MOOYAH 0456", -20),
      tx("MOOYAH 0456", -20), // same merchant aggregates
      tx("CHIPOTLE 900", -15),
    ];
    const { top } = computeOneOff(txns, ctx, activeBillNames);
    expect(top[0].amount).toBe(40);
    expect(top[0].name.toLowerCase()).toContain("mooyah");
  });
});
