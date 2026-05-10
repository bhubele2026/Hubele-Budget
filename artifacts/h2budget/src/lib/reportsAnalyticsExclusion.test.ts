import { describe, it, expect } from "vitest";
import type { Transaction } from "@workspace/api-client-react";
import { categoryTotals, dailyCashFlow } from "./reportsAnalytics";

// (#624) Verifies that `excludedCategoryIds` correctly drops
// transactions tagged with a system-managed `excludeFromBudget`
// category (Uncategorized / Transfer / Ignore) from the Reports
// roll-ups. Without this set the helpers double-count Ignore rows in
// both the spending breakdown and the daily cash-flow chart.

function txn(over: Partial<Transaction>): Transaction {
  return {
    id: over.id ?? "t",
    userId: "u",
    householdId: "h",
    occurredOn: "2026-05-10",
    description: "x",
    amount: "0.00",
    categoryId: null,
    accountKey: null,
    isTransfer: false,
    isTransferUserOverridden: false,
    weeklyAllowance: false,
    monthlyAllowance: false,
    unplannedAllowance: false,
    source: "manual",
    plaidTransactionId: null,
    plaidAccountId: null,
    pending: false,
    notes: null,
    reimbursable: null,
    isReimbursed: false,
    createdAt: "2026-05-10T00:00:00Z",
    updatedAt: "2026-05-10T00:00:00Z",
    ...over,
  } as unknown as Transaction;
}

describe("(#624) Reports analytics excludes system categories", () => {
  const coffeeId = "cat-coffee";
  const ignoreId = "cat-ignore";
  const transferId = "cat-transfer";
  const catNameById = new Map<string, string>([
    [coffeeId, "Coffee"],
    [ignoreId, "Ignore"],
    [transferId, "Transfer"],
  ]);
  const excluded: ReadonlySet<string> = new Set([ignoreId, transferId]);

  const txns: Transaction[] = [
    txn({ id: "1", amount: "-30.00", categoryId: coffeeId, occurredOn: "2026-05-10" }),
    txn({ id: "2", amount: "-1000.00", categoryId: ignoreId, occurredOn: "2026-05-11" }),
    txn({ id: "3", amount: "-500.00", categoryId: transferId, occurredOn: "2026-05-12" }),
    txn({ id: "4", amount: "200.00", categoryId: ignoreId, occurredOn: "2026-05-13" }),
  ];

  it("categoryTotals excludes Ignore + Transfer transactions", () => {
    const totals = categoryTotals(txns, catNameById, excluded);
    expect(totals).toHaveLength(1);
    expect(totals[0]!.id).toBe(coffeeId);
    expect(totals[0]!.total).toBe(30);
    // Sanity: without the excluded set, Ignore + Transfer leak in.
    const naive = categoryTotals(txns, catNameById);
    expect(naive.length).toBeGreaterThan(1);
    expect(naive.some((c) => c.name === "Ignore")).toBe(true);
  });

  it("dailyCashFlow excludes Ignore + Transfer transactions from both income and expense", () => {
    const days = dailyCashFlow(txns, excluded);
    // Only the May-10 Coffee row survives the filter.
    expect(days).toHaveLength(1);
    expect(days[0]!.date).toBe("2026-05-10");
    expect(days[0]!.expense).toBe(30);
    expect(days[0]!.income).toBe(0);
    // Sanity: without the excluded set the +$200 Ignore deposit and
    // the $1000/$500 outflows would all show up.
    const naive = dailyCashFlow(txns);
    expect(naive.length).toBeGreaterThan(1);
  });
});
