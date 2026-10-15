import { describe, it, expect } from "vitest";
import { BUCKETS, bucketAria, classificationNote, fateWords, planLine, plannedFateWords, sideWords, signedCash, varianceWords } from "./words";

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

// ⭐ (F5 round 2) A card week whose purchases moved on is never "Missed".
describe("plannedFateWords", () => {
  it("carried → 'Carried to <day>'; part paid with the rest on the forecast → 'Part paid · $X still owed'; else the fate's words", () => {
    expect(plannedFateWords({ fate: "carried", carriedTo: "2026-10-15", onCurve: false, remainder: "-10.00" })).toBe("Carried to Oct 15");
    expect(plannedFateWords({ fate: "carried", carriedTo: null, onCurve: false, remainder: null })).toBe("Carried");
    expect(plannedFateWords({ fate: "paid_on_evidence", carriedTo: null, onCurve: true, remainder: "-210.00" })).toBe("Part paid · $210.00 still owed");
    expect(plannedFateWords({ fate: "paid_on_evidence", carriedTo: null, onCurve: false, remainder: "0.00" })).toBe("Paid");
    expect(plannedFateWords({ fate: "missed", carriedTo: null, onCurve: false, remainder: null })).toBe("Missed");
    expect(fateWords("carried")).toBe("Carried");
  });
});

describe("(Q5) bucket words and aria", () => {
  const meta = Object.fromEntries(BUCKETS.map((b) => [b.name, b]));
  it("direction-aware titles: received or paid, a different day, not on the plan", () => {
    expect(meta.amountDifference!.title).toBe("Received or paid a different amount");
    expect(meta.timingDifference!.title).toBe("On a different day");
    expect(meta.unmatched!.title).toBe("Not on the plan");
    expect(BUCKETS.map((b) => b.title).join(" ")).not.toMatch(/Unmatched|Different date|Different amount/);
  });
  it("aria / tooltip: the count, then money in and money out apart; a zero side is not mentioned", () => {
    expect(bucketAria("Not on the plan", { count: 2, moneyIn: "300.00", moneyOut: "25.00" })).toBe("Not on the plan: 2 rows, money in $300.00, money out $25.00");
    expect(bucketAria("On a different day", { count: 1, moneyIn: "0.00", moneyOut: "40.00" })).toBe("On a different day: 1 row, money out $40.00");
    expect(bucketAria("Not sure", { count: 0, moneyIn: "0.00", moneyOut: "0.00" })).toBe("Not sure: 0 rows");
    // (Q5 fix) the variance lines the card shows lead the accessible name
    expect(bucketAria("Received or paid a different amount", { count: 2, moneyIn: "1940.00", moneyOut: "152.00", varianceIn: "-60.00", varianceOut: "-12.00" })).toBe(
      "Received or paid a different amount: Income $60.00 less than expected, Bills $12.00 over, 2 rows, money in $1,940.00, money out $152.00",
    );
    expect(bucketAria("Not sure", { count: 1, moneyIn: "0.00", moneyOut: "40.00", varianceIn: null, varianceOut: "-4.00" })).toBe("Not sure: Bills $4.00 over, 1 row, money out $40.00");
  });
});

describe("(Q5) planned outcomes in the direction of the money", () => {
  it("income: Received / Received, different amount / Not received yet; a payment: Paid / Paid, different amount / Not paid yet", () => {
    const p = (outcome: string, direction: "in" | "out", o: Record<string, unknown> = {}) =>
      plannedFateWords({ fate: "matched", carriedTo: null, onCurve: false, remainder: null, outcome, direction, ...o } as never);
    expect(p("received", "in")).toBe("Received");
    expect(p("received_different", "in")).toBe("Received, different amount");
    expect(p("not_received_yet", "in")).toBe("Not received yet");
    expect(p("paid", "out")).toBe("Paid");
    expect(p("paid_different", "out")).toBe("Paid, different amount");
    expect(p("not_paid_yet", "out")).toBe("Not paid yet");
    expect(p("suggested", "in")).toBe("Maybe received");
    expect(p("suggested", "out")).toBe("Maybe paid");
    expect(p("not_due", "out")).toBe("Not due yet");
    expect(p("missed", "out")).toBe("Missed");
    // the card-week special cases still win
    expect(plannedFateWords({ fate: "carried", carriedTo: "2026-10-15", onCurve: false, remainder: null, outcome: "carried", direction: "out" } as never)).toBe("Carried to Oct 15");
  });
});
