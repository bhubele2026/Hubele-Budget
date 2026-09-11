import { describe, it, expect } from "vitest";
import {
  buildClientSuggestions,
  pickOneClickBankMatches,
  type BankLine,
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

  it("(PR5) never offers a one-click pick for a plan the server already paired", () => {
    // Built through the page's own path (`buildClientSuggestions`): the
    // server paired Rent with t-server; t-client is an exact same-day $100
    // that would otherwise be Rent's sole high-confidence one-click.
    const rentPlan: PlanLine = {
      ...plan("rent", "2026-05-01"),
      probablyPaid: {
        txnId: "t-server",
        planDate: "2026-05-01",
        txnAmount: -104,
        difference: 4,
        dayDelta: -2,
        confidence: "medium",
        ambiguous: false,
        offCurve: true,
        txnDate: "2026-04-29",
        txnDescription: "RENT",
      },
    };
    const bank = (id: string, date: string, amount: number, suggestedPlan?: PlanLine): BankLine => ({
      kind: "bank",
      date,
      amount,
      status: "pending_bank",
      txn: { id, occurredOn: date, description: id, amount: String(amount), forecastFlag: true },
      ...(suggestedPlan ? { suggestedPlan } : {}),
    });
    const sugs = buildClientSuggestions(
      [bank("t-server", "2026-04-29", -104, rentPlan), bank("t-client", "2026-05-01", -100)],
      [rentPlan],
    );
    expect(pickOneClickBankMatches(sugs).size).toBe(0);
    // Control: the same plan without the server pair IS the one-click pick.
    const control = buildClientSuggestions(
      [bank("t-client", "2026-05-01", -100)],
      [plan("rent", "2026-05-01")],
    );
    expect(pickOneClickBankMatches(control).get("t-client")?.plan.itemId).toBe("rent");
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
