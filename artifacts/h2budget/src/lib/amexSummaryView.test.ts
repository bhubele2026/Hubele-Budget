import { describe, expect, it } from "vitest";
import { amexPlanLine, amexRowKind, amexSummaryPeriod, householdLine, monthNameOf, overLinkView, rowInFigure, summaryTitle } from "./amexSummaryView";

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
    const hc = {
      weeklyPlan: "560.00", weeklyKnown: "560.00", weeklyUnresolved: "0.00",
      monthlyPlan: "45.00", monthlyKnown: "45.00", monthlyUnresolved: "0.00",
      unfiled: "0.00", link: "/spending/week",
    };
    // (hh-split) nothing unconfirmed: the line says nothing about it
    expect(householdLine(hc, "wk", true)).toBe("Adds $560.00 to this week's household plan");
    expect(householdLine(hc, "mo", true)).toBe("Adds $560.00 weekly and $45.00 monthly to the household plan");
    // the weekly part: the server's own unconfirmed figure, said exactly
    const wk = { ...hc, weeklyKnown: "520.00", weeklyUnresolved: "40.00" };
    expect(householdLine(wk, "wk", true)).toBe("Adds $560.00 to this week's household plan (includes $40.00 unconfirmed)");
    expect(householdLine(wk, "mo", true)).toBe("Adds $560.00 weekly (includes $40.00 unconfirmed) and $45.00 monthly to the household plan");
    // a past week reads as the period's two figures, with the same weekly part
    expect(householdLine(wk, "wk", false)).toBe("Adds $560.00 weekly (includes $40.00 unconfirmed) and $45.00 monthly to the household plan");
    // the monthly part says it only when the monthly figure has one
    const mo = { ...hc, monthlyKnown: "30.00", monthlyUnresolved: "15.00" };
    expect(householdLine(mo, "mo", true)).toBe("Adds $560.00 weekly and $45.00 monthly (includes $15.00 unconfirmed) to the household plan");
    expect(householdLine(mo, "wk", true)).toBe("Adds $560.00 to this week's household plan");
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


describe("(P1) summaryTitle — the Summary is titled by its period", () => {
  const now = new Date("2026-10-14T17:00:00Z"); // Wed, noon in Chicago
  it("this week, a month, Week on another month, a year", () => {
    expect(summaryTitle("wk", { year: 2026, month: 9 }, now)).toBe("This week · Oct 11 – 17");
    expect(summaryTitle("mo", { year: 2026, month: 9 }, now)).toBe("October 2026");
    expect(summaryTitle("wk", { year: 2026, month: 8 }, now)).toBe("September 2026");
    expect(summaryTitle("yr", { year: 2026, month: 9 }, now)).toBe("2026");
    expect(monthNameOf({ year: 2026, month: 9 })).toBe("October");
  });
});

describe("(P1) overLinkView — every row of the link table", () => {
  const wk = (plan: "loading" | "failed" | "none" | "over" | "set", owner?: boolean | "unknown") =>
    overLinkView({ period: "week", current: true, plan, owner });
  const mo = (plan: "loading" | "failed" | "none" | "over" | "set", current: boolean, owner?: boolean | "unknown") =>
    overLinkView({ period: "month", monthName: "October", current, plan, owner });
  it("over (even when not final) asks why", () => {
    expect(wk("over")).toEqual({ text: "Why are we over? →", state: "over" });
    expect(mo("over", true)).toEqual({ text: "Why are we over? →", state: "over" });
    expect(mo("over", false)).toEqual({ text: "Why are we over? →", state: "over" });
  });
  it("set and not over (on plan, tight, not final) only views", () => {
    expect(wk("set")).toEqual({ text: "View this week's spending →", state: "within" });
    expect(mo("set", true)).toEqual({ text: "View October spending →", state: "within" });
  });
  it("no plan this period: the owner sets one, anyone else (or not known yet) reviews", () => {
    expect(wk("none", true)).toEqual({ text: "Set a weekly plan →", state: "set_plan" });
    expect(mo("none", true, true)).toEqual({ text: "Set a monthly plan →", state: "set_plan" });
    expect(wk("none", false)).toEqual({ text: "Review this week →", state: "review" });
    expect(wk("none", "unknown")).toEqual({ text: "Review this week →", state: "review" });
    expect(mo("none", true, false)).toEqual({ text: "Review this month →", state: "review" });
  });
  it("no plan on a past month, loading, or a failed read: view, never 'over'", () => {
    expect(mo("none", false, true)).toEqual({ text: "View October spending →", state: "view" });
    expect(wk("loading")).toEqual({ text: "View this week's spending →", state: "view" });
    expect(wk("failed")).toEqual({ text: "View this week's spending →", state: "view" });
    expect(mo("loading", false)).toEqual({ text: "View October spending →", state: "view" });
    expect(mo("failed", true)).toEqual({ text: "View October spending →", state: "view" });
  });
  it("a year views spending by month", () => {
    expect(overLinkView({ period: "year" })).toEqual({ text: "View spending by month →", state: "year" });
  });
});
