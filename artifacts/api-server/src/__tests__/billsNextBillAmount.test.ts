import { describe, it, expect } from "vitest";
import { occurrenceAmountOn, pickNextBill, type BillsSummary } from "../lib/billsSummary";

// (dash-accuracy, 2026-10-09) "What is due next" is ONE payment. A $450 weekly
// bill read "$2,250 next" because the pick quoted the row's `monthlyAmount`
// (every occurrence in the month). The row keeps that month total.

type Row = BillsSummary["bills"][number];
const item = (o: Partial<Row["item"]>): Row["item"] =>
  ({
    id: "i1", userId: "u", householdId: "h", name: "Weekly Spend", kind: "bill", amount: "450.00",
    frequency: "weekly", dayOfMonth: null, anchorDate: "2026-10-03", active: "true", ...o,
  }) as Row["item"];
const summary = (bills: Row[], debtMins: BillsSummary["debtMins"] = []): BillsSummary => ({
  income: [], bills, debtMins,
  monthly: { income: "0.00", bills: "0.00", debtMin: "0.00", totalOutflow: "0.00", net: "0.00", active: bills.length, monthStart: "2026-10-01", monthEnd: "2026-10-31" },
});
const TODAY = new Date(2026, 9, 9); // Fri Oct 9 2026, local midnight

describe("occurrenceAmountOn", () => {
  it("is one occurrence on that date, whatever the cadence", () => {
    expect(occurrenceAmountOn(item({}), "2026-10-10")).toBe("450.00");
    expect(occurrenceAmountOn(item({ frequency: "biweekly", amount: "-1200.5" }), "2026-10-17")).toBe("1200.50");
    expect(occurrenceAmountOn(item({ frequency: "monthly", dayOfMonth: 15, amount: "89.99" }), "2026-10-15")).toBe("89.99");
  });
  it("falls back to the stored per-occurrence amount on a day with no occurrence", () => {
    expect(occurrenceAmountOn(item({}), "2026-10-11")).toBe("450.00");
  });
});

describe("pickNextBill", () => {
  it("a weekly bill's next amount is one payment, not the month total", () => {
    const weekly: Row = { item: item({}), nextOccurrence: "2026-10-10", monthlyAmount: "2250.00", actualAmount: "0.00" };
    const r = pickNextBill(summary([weekly]), TODAY);
    expect(r.nextBill).toEqual({ name: "Weekly Spend", amount: "450.00", dueDate: "2026-10-10" });
    // The row itself is untouched: the Bills page still shows "~$2,250/mo".
    expect(weekly.monthlyAmount).toBe("2250.00");
    expect(r.billsDueCount).toBe(1);
  });
  it("a monthly bill is unchanged (one occurrence = the month), and a debt minimum keeps its own amount", () => {
    const rent: Row = {
      item: item({ name: "Rent", frequency: "monthly", dayOfMonth: 12, anchorDate: "2026-10-12", amount: "1850.00" }),
      nextOccurrence: "2026-10-12", monthlyAmount: "1850.00", actualAmount: "0.00",
    };
    expect(pickNextBill(summary([rent]), TODAY).nextBill).toEqual({ name: "Rent", amount: "1850.00", dueDate: "2026-10-12" });
    const min = { debtId: "d1", debtName: "Visa", amount: "-35.00", nextOccurrence: "2026-10-11" } as unknown as BillsSummary["debtMins"][number];
    expect(pickNextBill(summary([rent], [min]), TODAY).nextBill).toEqual({ name: "Visa", amount: "35.00", dueDate: "2026-10-11" });
  });
});
