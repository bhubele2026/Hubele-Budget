// (PR-B1) `deriveWeeklyLimit` — the suggested weekly cap and its working.
// Pure; synthetic plans only.

import { describe, it, expect } from "vitest";
import {
  deriveWeeklyLimit,
  isEverydayFundingItem,
  monthlyCentsOf,
  type WeeklyLimitInputs,
} from "@workspace/avalanche-core";

const base = (over: Partial<WeeklyLimitInputs> = {}): WeeklyLimitInputs => ({
  incomeItems: [],
  billItems: [],
  debts: [],
  avalancheExtra: 0,
  goalsMonthly: 0,
  ...over,
});

describe("monthly normalisation", () => {
  it.each([
    ["weekly", 120, (120 * 52) / 12],
    ["biweekly", 2000, (2000 * 26) / 12],
    ["semimonthly", 1500, 3000],
    ["monthly", 1800, 1800],
    ["quarterly", 300, 100],
    ["annual", 1200, 100],
  ])("%s %d is %d a month", (frequency, amount, monthly) => {
    expect(monthlyCentsOf(amount, frequency)! / 100).toBeCloseTo(monthly, 9);
    const r = deriveWeeklyLimit(base({ incomeItems: [{ amount, frequency, active: "true" }] }));
    expect(r.derivation.takeHomeMonthly).toBe((Math.round(monthly * 100) / 100).toFixed(2));
  });

  it("a one-time plan, or an unknown frequency, is not a monthly amount", () => {
    expect(monthlyCentsOf(500, "onetime")).toBeNull();
    expect(monthlyCentsOf(500, "fortnightly")).toBeNull();
    const r = deriveWeeklyLimit(base({ billItems: [{ name: "Couch", amount: 900, frequency: "onetime", active: "true" }] }));
    expect(r.derivation.committedMonthly).toBe("0.00");
  });

  it("each figure is summed exactly and rounded to the cent once", () => {
    // 3 × $10.01 weekly = $130.13 a month exactly; rounding each item first would give 3 × 43.38 = 130.14.
    const items = Array.from({ length: 3 }, () => ({ amount: "10.01", frequency: "weekly", active: true }));
    expect(deriveWeeklyLimit(base({ incomeItems: items })).derivation.takeHomeMonthly).toBe("130.13");
  });
});

describe("what is committed", () => {
  it("leaves out inactive plans, the allowance's own funding items and bills linked to a debt", () => {
    const r = deriveWeeklyLimit(
      base({
        billItems: [
          { name: "Mortgage", amount: "1800", frequency: "monthly", active: "true" },
          { name: "Gym", amount: "40", frequency: "monthly", active: "false" },
          { name: "Weekly Spend", amount: "300", frequency: "weekly", active: "true" },
          { name: "  monthly   SPEND ", amount: "400", frequency: "monthly", active: "true" },
          { name: "Car payment", amount: "350", frequency: "monthly", active: "true", debtId: "debt-1" },
        ],
      }),
    );
    expect(r.derivation.committedMonthly).toBe("1800.00");
  });

  it("debt minimums count for active debts only; the Avalanche extra and goals are their own lines", () => {
    const r = deriveWeeklyLimit(
      base({
        incomeItems: [{ amount: "5000", frequency: "monthly", active: true }],
        debts: [
          { minPayment: "85", status: "active" },
          { minPayment: "310.50" },
          { minPayment: "999", status: "paid_off" },
        ],
        avalancheExtra: "250",
        goalsMonthly: "100",
      }),
    );
    expect(r.derivation).toEqual({
      takeHomeMonthly: "5000.00",
      committedMonthly: "0.00",
      debtMinimumsMonthly: "395.50",
      extraMonthly: "250.00",
      goalsMonthly: "100.00",
      discretionaryMonthly: "4254.50",
    });
  });

  it("isEverydayFundingItem matches the two funding names only", () => {
    expect(isEverydayFundingItem("Weekly Spend")).toBe(true);
    expect(isEverydayFundingItem("weekly  spend")).toBe(true);
    expect(isEverydayFundingItem("Weekly Spending")).toBe(false);
    expect(isEverydayFundingItem(null)).toBe(false);
  });
});

describe("the suggestion", () => {
  it("is the discretionary month per week, rounded DOWN to whole $5", () => {
    // 4,000 − 1,800 − 395 − 250 = 1,555 a month → 1,555 × 12/52 = 358.85 → $355.
    const r = deriveWeeklyLimit(
      base({
        incomeItems: [{ amount: "4000", frequency: "monthly", active: true }],
        billItems: [{ name: "Mortgage", amount: "1800", frequency: "monthly", active: true }],
        debts: [{ minPayment: "395" }],
        avalancheExtra: 250,
      }),
    );
    expect(r.derivation.discretionaryMonthly).toBe("1555.00");
    expect(r.suggestedWeekly).toBe("355.00");
  });

  it("an exact multiple of $5 is kept, a cent under it drops to the next $5 down", () => {
    // $1,300 a month × 12/52 = exactly $300.
    const at = (monthly: string) =>
      deriveWeeklyLimit(base({ incomeItems: [{ amount: monthly, frequency: "monthly", active: true }] })).suggestedWeekly;
    expect(at("1300")).toBe("300.00");
    expect(at("1299.99")).toBe("295.00");
  });

  it("is never negative: a plan that already spends more than comes in suggests $0", () => {
    const r = deriveWeeklyLimit(
      base({
        incomeItems: [{ amount: "1000", frequency: "monthly", active: true }],
        billItems: [{ name: "Rent", amount: "1500", frequency: "monthly", active: true }],
      }),
    );
    expect(r.derivation.discretionaryMonthly).toBe("-500.00");
    expect(r.suggestedWeekly).toBe("0.00");
    // A sliver above zero is still under $5.
    expect(
      deriveWeeklyLimit(base({ incomeItems: [{ amount: "21.66", frequency: "monthly", active: true }] })).suggestedWeekly,
    ).toBe("0.00");
  });

  it("negative or unreadable extra and goals count as nothing", () => {
    const r = deriveWeeklyLimit(
      base({ incomeItems: [{ amount: "1300", frequency: "monthly", active: true }], avalancheExtra: "-50", goalsMonthly: "abc" }),
    );
    expect(r.derivation.extraMonthly).toBe("0.00");
    expect(r.derivation.goalsMonthly).toBe("0.00");
    expect(r.suggestedWeekly).toBe("300.00");
  });
});
