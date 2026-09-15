import { describe, it, expect } from "vitest";
import { rowDecisionsByTxn } from "./forecastRowState";

// (PR5b review H2) The Chase page reads one forecast decision per row. The
// server keeps a "Not this" answer beside the real decision, in no guaranteed
// order, so the read must ignore it — and a partial is a decision.

describe("rowDecisionsByTxn", () => {
  it("ignores 'Not this': a row whose only answer is a rejection has no decision", () => {
    const m = rowDecisionsByTxn([
      { matchedTxnId: "t1", status: "not_match" },
      { matchedTxnId: null, status: "missed" },
    ]);
    expect(m.has("t1")).toBe(false);
    expect(m.size).toBe(0);
  });

  it("a rejection beside a match never hides the match, in either order", () => {
    const matched = { matchedTxnId: "t1", status: "matched" };
    const rejected = { matchedTxnId: "t1", status: "not_match" };
    expect(rowDecisionsByTxn([matched, rejected]).get("t1")).toEqual({ status: "matched" });
    expect(rowDecisionsByTxn([rejected, matched]).get("t1")).toEqual({ status: "matched" });
  });

  it("a partial is the row's decision", () => {
    expect(
      rowDecisionsByTxn([
        { matchedTxnId: "t1", status: "not_match" },
        { matchedTxnId: "t1", status: "partial" },
      ]).get("t1"),
    ).toEqual({ status: "partial" });
  });

  it("(PR-I) a bank-removed marker is no decision, and never hides the row's real one, in either order", () => {
    const marker = { matchedTxnId: "t1", status: "bank_removed" };
    const matched = { matchedTxnId: "t1", status: "matched" };
    expect(rowDecisionsByTxn([marker]).has("t1")).toBe(false);
    expect(rowDecisionsByTxn([marker, matched]).get("t1")).toEqual({ status: "matched" });
    expect(rowDecisionsByTxn([matched, marker]).get("t1")).toEqual({ status: "matched" });
  });
});
