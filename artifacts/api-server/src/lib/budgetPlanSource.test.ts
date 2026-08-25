import { describe, it, expect } from "vitest";
import {
  planSourceOf,
  rollUpPlanBySource,
  type PlanSource,
} from "./budgetPlanSource";

const line = (over: Partial<Parameters<typeof planSourceOf>[0]> = {}) => ({
  kind: "expense",
  sourceKind: "manual",
  linkedBillCount: 0,
  ...over,
});

describe("planSourceOf", () => {
  it("files income categories under income, bill-backed or not", () => {
    expect(planSourceOf(line({ kind: "income", sourceKind: "auto_bills", linkedBillCount: 1 }))).toBe("income");
    expect(planSourceOf(line({ kind: "income", sourceKind: "manual" }))).toBe("income");
  });

  it("files Debt Tracker rows under debts", () => {
    expect(planSourceOf(line({ sourceKind: "auto_debts" }))).toBe("debts");
  });

  it("files the Avalanche payment under debts even though it is sourceKind manual", () => {
    // It is system-managed from the Avalanche page rather than the Debt
    // Tracker, so nothing about its row says "debt" except its identity.
    expect(planSourceOf(line({ isAvalanchePayment: true }))).toBe("debts");
  });

  it("⚠️ files a bill-backed MANUAL envelope under bills", () => {
    // The regression this guards: most expense bills never get their own
    // category — the user points each at a curated envelope on the Bills page,
    // so `Insurance` carries sourceKind "manual" while two bills roll into it.
    // Classifying on sourceKind alone would call it unbacked and empty the plan.
    expect(planSourceOf(line({ sourceKind: "manual", linkedBillCount: 2 }))).toBe("bills");
  });

  it("files a hand-created envelope with no bill under unbacked", () => {
    expect(planSourceOf(line({ sourceKind: "manual", linkedBillCount: 0 }))).toBe("unbacked");
  });

  it("still calls an auto_bills expense category bills when its bill is linked", () => {
    expect(planSourceOf(line({ sourceKind: "auto_bills", linkedBillCount: 1 }))).toBe("bills");
  });
});

const sum = (planSource: PlanSource, planned: string, actual: string) => ({
  planSource,
  plannedAmount: planned,
  actualAmount: actual,
});

describe("rollUpPlanBySource", () => {
  it("⚠️ leaves unbacked OUT of plannedTotal", () => {
    // This is the whole point. Groceries and Dining were planned by hand while
    // the money they describe was already committed as the Weekly Spend bill;
    // summing both is what showed the same $1,800 twice.
    const roll = rollUpPlanBySource([
      sum("income", "12600.00", "12600.00"),
      sum("bills", "6412.00", "5100.00"),
      sum("debts", "1180.00", "1180.00"),
      sum("unbacked", "920.00", "790.00"),
    ]);
    expect(roll.plannedTotal).toBe("7592.00"); // 6412 + 1180, no 920
    expect(roll.unbacked.planned).toBe("920.00"); // still reported
    expect(roll.actualTotal).toBe("6280.00"); // 5100 + 1180
  });

  it("nets income against the plan, not against every line", () => {
    const roll = rollUpPlanBySource([
      sum("income", "10000.00", "0.00"),
      sum("bills", "6000.00", "0.00"),
      sum("debts", "1000.00", "0.00"),
      sum("unbacked", "2500.00", "0.00"),
    ]);
    expect(roll.net).toBe("3000.00");
  });

  it("counts lines per bucket", () => {
    const roll = rollUpPlanBySource([
      sum("bills", "10.00", "0.00"),
      sum("bills", "10.00", "0.00"),
      sum("unbacked", "10.00", "0.00"),
    ]);
    expect(roll.bills.lineCount).toBe(2);
    expect(roll.unbacked.lineCount).toBe(1);
    expect(roll.debts.lineCount).toBe(0);
  });

  it("returns a whole, zeroed shape for an empty month", () => {
    const roll = rollUpPlanBySource([]);
    expect(roll.plannedTotal).toBe("0.00");
    expect(roll.net).toBe("0.00");
    expect(roll.income).toEqual({ planned: "0.00", actual: "0.00", lineCount: 0 });
  });

  it("treats unparseable amounts as zero rather than NaN", () => {
    const roll = rollUpPlanBySource([sum("bills", "", "abc")]);
    expect(roll.plannedTotal).toBe("0.00");
    expect(roll.bills.actual).toBe("0.00");
  });
});
