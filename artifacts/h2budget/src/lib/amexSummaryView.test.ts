import { describe, expect, it } from "vitest";
import { amexPlanLine, amexRowKind, amexSummaryPeriod, householdLine, rowInFigure } from "./amexSummaryView";

describe("amexSummaryPeriod (W4)", () => {
  // Wed 2026-10-14, noon Chicago.
  const now = new Date("2026-10-14T17:00:00Z");
  it("Week on this month is this Sun–Sat week", () => {
    expect(amexSummaryPeriod("wk", { year: 2026, month: 9 }, now)).toEqual({ from: "2026-10-11", to: "2026-10-17" });
  });
  it("Month, and Week on another month, is that whole month", () => {
    expect(amexSummaryPeriod("mo", { year: 2026, month: 9 }, now)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(amexSummaryPeriod("wk", { year: 2026, month: 8 }, now)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });
  it("Year is that calendar year", () => {
    expect(amexSummaryPeriod("yr", { year: 2026, month: 9 }, now)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });
  it("a period that has not started asks for nothing", () => {
    expect(amexSummaryPeriod("mo", { year: 2026, month: 10 }, now)).toBeNull();
  });
});

describe("plan line and household wording (W4)", () => {
  const base = { payoff: null, payoffDate: null, basis: null, debtId: null, name: null, minimum: null, avalancheRank: null, status: null };
  it("weekly hook → Saturday payoff → Forecast; debt → minimum → Debt; none → null", () => {
    expect(amexPlanLine({ ...base, kind: "weekly_hook", payoff: "600.00" })).toMatchObject({ label: "Saturday payoff", amount: "600.00", to: "/forecast" });
    expect(amexPlanLine({ ...base, kind: "monthly_hook", payoff: "200.00" })).toMatchObject({ label: "Monthly payoff", to: "/forecast" });
    expect(amexPlanLine({ ...base, kind: "debt", minimum: "35.00" })).toMatchObject({ label: "On the payoff plan: minimum", amount: "35.00", to: "/debts" });
    expect(amexPlanLine({ ...base, kind: "none" })).toBeNull();
  });
  it("a minimum that is unknown stays null (a dash on screen), not $0", () => {
    expect(amexPlanLine({ ...base, kind: "debt" })!.amount).toBeNull();
  });
  it("the household line is the household's plan, not the card's budget", () => {
    const hc = { weeklyPlan: "560.00", monthlyPlan: "45.00", unfiled: "0.00", link: "/spending/week" };
    expect(householdLine(hc, "wk", true)).toBe("Adds $560.00 to this week's household plan");
    expect(householdLine(hc, "mo", true)).toBe("Adds $560.00 weekly and $45.00 monthly to the household plan");
  });
});

describe("which rows a figure opens (W4)", () => {
  const tx = (over: Record<string, unknown>) =>
    ({ amount: "-10", source: "plaid", isTransfer: false, categoryId: null, description: "STORE", debtId: null, isExternalCardPayment: false, reimbursable: false, pfcDetailed: null, ...over }) as never;
  it("purchase, payment, refund and other credit land in their own figure", () => {
    const purchase = amexRowKind(tx({}), []);
    const payment = amexRowKind(tx({ amount: "200", description: "AUTOPAY PAYMENT THANK YOU" }), []);
    const refund = amexRowKind(tx({ amount: "15", description: "REFUND STORE" }), []);
    expect([purchase, payment, refund]).toEqual(["purchase", "payment", "refund"]);
    expect(rowInFigure("purchases", purchase)).toBe(true);
    expect(rowInFigure("payments", purchase)).toBe(false);
    expect(rowInFigure("payments", payment)).toBe(true);
    expect(rowInFigure("credits", refund)).toBe(true);
    expect(rowInFigure("credits", "other_credit")).toBe(true);
    expect(rowInFigure("credits", payment)).toBe(false);
  });
});
