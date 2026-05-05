import { describe, it, expect } from "vitest";
import {
  pickOneClickBankMatches,
  type PlanLine,
  type PlanSuggestion,
} from "./forecastMatch";

function plan(itemId: string, date: string, amount = -100, label = ""): PlanLine {
  return { kind: "plan", date, itemId, label, amount, status: "pending_plan" };
}

function sug(
  p: PlanLine,
  confidence: PlanSuggestion["confidence"],
  score = 0,
): PlanSuggestion {
  return {
    plan: p,
    score,
    confidence,
    daysAway: 0,
    amountDelta: 0,
    labelMatch: false,
  };
}

describe("pickOneClickBankMatches (#28)", () => {
  it("picks the only high-confidence suggestion when uncontested", () => {
    const p = plan("rent", "2026-05-01");
    const m = new Map([["t1", [sug(p, "high"), sug(plan("x", "2026-05-03"), "low")]]]);
    const out = pickOneClickBankMatches(m);
    expect(out.size).toBe(1);
    expect(out.get("t1")?.plan.itemId).toBe("rent");
  });

  it("excludes cards with no high-confidence suggestion", () => {
    const m = new Map([
      ["t1", [sug(plan("a", "2026-05-01"), "medium"), sug(plan("b", "2026-05-02"), "low")]],
    ]);
    expect(pickOneClickBankMatches(m).size).toBe(0);
  });

  it("excludes cards with multiple high-confidence suggestions (on-card tie)", () => {
    const m = new Map([
      [
        "t1",
        [sug(plan("a", "2026-05-01"), "high"), sug(plan("b", "2026-05-02"), "high")],
      ],
    ]);
    expect(pickOneClickBankMatches(m).size).toBe(0);
  });

  it("excludes contested plans claimed as high-confidence by another card", () => {
    const shared = plan("rent", "2026-05-01");
    const m = new Map([
      ["t1", [sug(shared, "high")]],
      ["t2", [sug(shared, "high")]],
    ]);
    expect(pickOneClickBankMatches(m).size).toBe(0);
  });

  it("does NOT count a non-high suggestion on another card as a contest", () => {
    const shared = plan("rent", "2026-05-01");
    const m = new Map([
      ["t1", [sug(shared, "high")]],
      ["t2", [sug(shared, "low")]],
    ]);
    const out = pickOneClickBankMatches(m);
    expect(out.size).toBe(1);
    expect(out.get("t1")?.plan.itemId).toBe("rent");
  });

  it("returns one-click picks for multiple cards independently", () => {
    const m = new Map([
      ["t1", [sug(plan("rent", "2026-05-01"), "high")]],
      ["t2", [sug(plan("netflix", "2026-05-10"), "high")]],
      ["t3", [sug(plan("z", "2026-05-12"), "medium")]],
    ]);
    const out = pickOneClickBankMatches(m);
    expect(out.size).toBe(2);
    expect(out.get("t1")?.plan.itemId).toBe("rent");
    expect(out.get("t2")?.plan.itemId).toBe("netflix");
    expect(out.has("t3")).toBe(false);
  });
});
