import { describe, it, expect } from "vitest";
import { SEED_RECURRING_ITEMS } from "../lib/budgetSeed";

describe("Bills monthly total (Task #70 sub-task 1)", () => {
  it("the four task-specified bill amounts are at the agreed values", () => {
    const byKey = (
      name: string,
      dayOfMonth: number | null,
      frequency: string,
    ) =>
      SEED_RECURRING_ITEMS.filter(
        (r) =>
          r.name === name &&
          r.frequency === frequency &&
          (dayOfMonth === null ? r.dayOfMonth == null : r.dayOfMonth === dayOfMonth),
      );

    const weekly = byKey("Weekly Spend", null, "weekly");
    const monthly = byKey("Monthly Spend", 1, "monthly");
    const kwik9 = byKey("Kwik Trip / gas", 9, "monthly");
    const kwik24 = byKey("Kwik Trip / gas", 24, "monthly");
    const dog = byKey("Dog Waste Removal", 1, "monthly");

    expect(weekly).toHaveLength(1);
    expect(monthly).toHaveLength(1);
    expect(kwik9).toHaveLength(1);
    expect(kwik24).toHaveLength(1);
    expect(dog).toHaveLength(1);

    expect(parseFloat(weekly[0].amount)).toBeCloseTo(450.0, 2);
    expect(parseFloat(monthly[0].amount)).toBeCloseTo(440.45, 2);
    expect(parseFloat(kwik9[0].amount)).toBeCloseTo(200.0, 2);
    expect(parseFloat(kwik24[0].amount)).toBeCloseTo(200.0, 2);
    expect(parseFloat(dog[0].amount)).toBeCloseTo(80.0, 2);
  });

  it("Bills 'per month' total for May 2026 lands on $8,466.70", () => {
    const bills = SEED_RECURRING_ITEMS.filter((r) => r.kind === "bill");
    const monthlySum = bills
      .filter((r) => r.frequency === "monthly")
      .reduce((acc, r) => acc + parseFloat(r.amount), 0);
    const weeklySum = bills
      .filter((r) => r.frequency === "weekly")
      .reduce((acc, r) => acc + parseFloat(r.amount), 0);

    const may2026WeeklyOccurrences = (() => {
      const anchor = new Date(2026, 4, 2);
      const monthStart = new Date(2026, 4, 1);
      const monthEnd = new Date(2026, 5, 0);
      let count = 0;
      for (
        let d = new Date(anchor);
        d <= monthEnd;
        d.setDate(d.getDate() + 7)
      ) {
        if (d >= monthStart) count += 1;
      }
      return count;
    })();
    expect(may2026WeeklyOccurrences).toBe(5);

    const total = monthlySum + weeklySum * may2026WeeklyOccurrences;
    expect(total).toBeCloseTo(8466.7, 2);
  });
});
