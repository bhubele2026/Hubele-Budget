import { describe, expect, it } from "vitest";
import type { AgentAction, AgentFinding } from "@workspace/api-client-react";
import { groupTrail, payloadLines } from "./trailWords";
import { reviewFlags, reviewWhy } from "./words";
import { badgeCount } from "@/data/activityData";

const a = (id: string, runId: string, type: AgentAction["type"], over: Partial<AgentAction> = {}): AgentAction => ({
  id, runId, type, targetKind: "transaction", targetId: id, outcome: "applied", reversible: true, undoneAt: null, createdAt: "2026-10-07T14:00:00Z", ...over,
});

describe("the agent trail, in words", () => {
  it("groups consecutive actions of one run and type: 'Filed 3 charges'", () => {
    const g = groupTrail([a("1", "r", "set_category"), a("2", "r", "set_category"), a("3", "r", "set_category"), a("4", "r2", "set_category")]);
    expect(g.map((x) => x.title)).toEqual(["Filed 3 charges", "Filed 1 charge"]);
  });

  it("Undo covers only what is reversible and not yet undone", () => {
    const [g] = groupTrail([
      a("1", "r", "set_category"),
      a("2", "r", "set_category", { undoneAt: "2026-10-07T15:00:00Z" }),
      a("3", "r", "set_category", { reversible: false }),
    ]);
    expect(g!.undoable.map((x) => x.id)).toEqual(["1"]);
    expect(g!.undone).toBe(false);
    const [done] = groupTrail([a("1", "r", "remember", { undoneAt: "2026-10-07T15:00:00Z" })]);
    expect(done!.undone).toBe(true);
    expect(done!.undoable).toEqual([]);
  });

  it("a duplicate-charge finding reads 'Flagged a possible duplicate'", () => {
    const f = { id: "f1", kind: "duplicate_charge" } as AgentFinding;
    expect(groupTrail([a("x", "r", "finding", { targetId: "f1" })], [f])[0]!.title).toBe("Flagged a possible duplicate");
    expect(groupTrail([a("x", "r", "finding", { targetId: "zz" })], [f])[0]!.title).toBe("Flagged something to look at");
  });

  it("a payload is words and figures: refs dropped, money keys as dollars, nothing derived", () => {
    expect(payloadLines({ transactionId: "abc", amount: 18.4, daysApart: 1, label: "Corner" })).toEqual([
      { label: "Amount", value: 18.4, money: true },
      { label: "Days apart", value: 1, money: false },
      { label: "Label", value: "Corner", money: false },
    ]);
  });
});

describe("review words and the badge", () => {
  it("maps the source to one plain line; the server's text only when it proposed nothing", () => {
    const base = { explanation: "The bank removed this charge.", suggestedCategoryId: "c1" };
    expect(reviewWhy({ ...base, source: "rule" })).toBe("Matches a rule");
    expect(reviewWhy({ ...base, source: "memory" })).toBe("Learned from a correction");
    expect(reviewWhy({ ...base, source: "recurring" })).toBe("Looks like a recurring bill");
    expect(reviewWhy({ ...base, source: "model" })).toBe("H2's best guess");
    expect(reviewWhy({ ...base, source: "heuristic", suggestedCategoryId: null })).toBe("The bank removed this charge.");
  });

  it("flags are words", () => {
    expect(reviewFlags({ novelMerchant: true, amountAnomaly: true, splitNeedsRebalance: true })).toEqual([
      "New merchant",
      "Unusual amount",
      "Split needs rebalance",
    ]);
    expect(reviewFlags({ novelMerchant: false, amountAnomaly: false, splitNeedsRebalance: false })).toEqual([]);
  });

  it("the badge is the queue total plus the spine's review count, and never negative or NaN", () => {
    expect(badgeCount(3, 2)).toBe(5);
    expect(badgeCount(undefined, undefined)).toBe(0);
    expect(badgeCount(0, 4)).toBe(4);
    expect(badgeCount(-1, 0)).toBe(0);
  });
});
