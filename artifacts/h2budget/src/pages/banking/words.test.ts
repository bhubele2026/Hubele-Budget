import { describe, it, expect } from "vitest";
import { classificationNote, planLine, sideWords, signedCash, varianceWords } from "./words";

/** (F4) Direction-aware words: income is 'less / more than expected', an expense is 'over / under'. */
const plan = (o: Record<string, unknown>) => ({ key: "k", label: "L", scheduledDate: "2026-10-09", planned: null, difference: null, dayDelta: 0, eventKind: "bill", direction: "out", expected: null, actual: null, variance: null, varianceKind: null, ...o });
const row = (o: Record<string, unknown>) => ({ amount: "-1.00", classificationIssue: null, category: null, plan: null, ...o }) as never;

describe("varianceWords", () => {
  it.each([
    ["less_than_expected", "-108.60", "$108.60 less than expected"],
    ["more_than_expected", "30.00", "$30.00 more than expected"],
    ["over_planned", "-12.00", "$12.00 over"],
    ["under_planned", "10.00", "$10.00 under"],
  ])("%s", (kind, variance, words) => {
    expect(varianceWords({ variance, varianceKind: kind } as never)).toBe(words);
  });
  it("an exact row, or no kind, has no variance words", () => {
    expect(varianceWords({ variance: "0.00", varianceKind: null } as never)).toBeNull();
    expect(varianceWords({ variance: null, varianceKind: null } as never)).toBeNull();
  });
});

describe("sideWords / signedCash", () => {
  it("money in and money out are worded apart, never netted", () => {
    expect(sideWords("in", "-108.60")).toBe("Income $108.60 less than expected");
    expect(sideWords("in", "5.00")).toBe("Income $5.00 more than expected");
    expect(sideWords("out", "-12.00")).toBe("Bills $12.00 over");
    expect(sideWords("out", "4.00")).toBe("Bills $4.00 under");
    expect(sideWords("out", "0.00")).toBeNull();
    expect(sideWords("in", null)).toBeNull();
    expect(signedCash("-108.60")).toBe("−$108.60");
    expect(signedCash("12.00")).toBe("+$12.00");
  });
});

describe("planLine", () => {
  it("income uses Expected / received", () => {
    expect(planLine(row({ amount: "2391.40", plan: plan({ direction: "in", expected: "2500.00", actual: "2391.40", variance: "-108.60", varianceKind: "less_than_expected" }) }))).toBe(
      "Expected $2,500.00 · received $2,391.40 · $108.60 less than expected",
    );
  });
  it("expense uses Planned / paid, and a late day is added", () => {
    expect(planLine(row({ amount: "-152.00", plan: plan({ expected: "140.00", actual: "152.00", variance: "-12.00", varianceKind: "over_planned", dayDelta: 6 }) }))).toBe(
      "Planned $140.00 · paid $152.00 · $12.00 over · 6 days late",
    );
  });
  it("no plan, no line", () => {
    expect(planLine(row({}))).toBeNull();
  });
});

describe("classificationNote", () => {
  it("names the category it was filed under and what it looks like", () => {
    expect(classificationNote(row({ classificationIssue: "inflow_into_expense", category: { id: "c", name: "Dining & Coffee" } }))).toBe("Filed as Dining & Coffee — looks like income");
    expect(classificationNote(row({ classificationIssue: "outflow_into_income", category: { id: "c", name: "Other income" } }))).toBe("Filed as Other income — looks like an expense");
    expect(classificationNote(row({}))).toBeNull();
  });
});
