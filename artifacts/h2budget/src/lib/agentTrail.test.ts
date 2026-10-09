import { describe, expect, it } from "vitest";
import type { AgentAction, AgentFinding } from "@workspace/api-client-react/features";
import { FINDING_LINK, FINDING_TITLE, groupTrail, isStatus, payloadLines, trailTitle } from "./agentTrail";

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


describe("titles, links, statuses", () => {
  it("every finding kind has a title; kinds with a page link to it", () => {
    for (const k of Object.keys(FINDING_TITLE) as AgentFinding["kind"][]) expect(FINDING_TITLE[k].length).toBeGreaterThan(0);
    expect(FINDING_LINK.shortfall_before_income?.href).toBe("/forecast");
    expect(FINDING_LINK.goal_behind).toBeUndefined();
  });
  it("trail titles pluralise", () => {
    expect(trailTitle("remember", 1)).toBe("Remembered 1 merchant");
    expect(trailTitle("remember", 3)).toBe("Remembered 3 merchants");
    expect(trailTitle("finding", 2)).toBe("Flagged 2 things to look at");
  });
  it("isStatus reads an error's status", () => {
    expect(isStatus({ status: 501 }, 501)).toBe(true);
    expect(isStatus(new Error("x"), 501)).toBe(false);
    expect(isStatus(null, 501)).toBe(false);
  });
});
