import { describe, it, expect } from "vitest";
import {
  BASED_ON,
  KIND_WORD,
  PROPOSAL_STATUS_WORD,
  SCOPE_ORDER,
  SCOPE_WORD,
  SOURCE_WORD,
  describeChange,
  keyWords,
  paragraphs,
  refHref,
  splitRefs,
  toolLine,
} from "./askWords";

// (F8) The Ask words, ported with h2's cases; money prints with cents here.

describe("Ask words", () => {
  it("refs split out of a line; text around them is kept", () => {
    expect(splitRefs("Based on: ref:txn-0001abc, ref:txn-0002def")).toEqual([
      { kind: "text", text: "Based on: " },
      { kind: "ref", id: "txn-0001abc" },
      { kind: "text", text: ", " },
      { kind: "ref", id: "txn-0002def" },
    ]);
    expect(splitRefs("no refs here")).toEqual([{ kind: "text", text: "no refs here" }]);
    // Too short to be an id: stays text.
    expect(splitRefs("ref:abc")).toEqual([{ kind: "text", text: "ref:abc" }]);
    expect(BASED_ON.test("Based on: x")).toBe(true);
  });

  it("a ref opens the Chase ledger on that charge (classic has no /activity)", () => {
    expect(refHref("txn-0001abc")).toBe("/transactions?tx=txn-0001abc");
    expect(refHref("a b")).toBe("/transactions?tx=a%20b");
  });

  it("paragraphs split on blank lines only", () => {
    expect(paragraphs("One.\nStill one.\n\n  Two.  \n\n\n")).toEqual(["One.\nStill one.", "Two."]);
  });

  it("memory keys and tool names as words", () => {
    expect(keyWords("dining_out-limit")).toBe("Dining out limit");
    expect(keyWords("")).toBe("");
    expect(toolLine("get_spending_summary")).toBe("Looking at spending…");
    expect(toolLine("something_new")).toBe("Working on it…");
    expect(SCOPE_ORDER.map((s) => SCOPE_WORD[s])).toEqual(["Filing", "Spending", "Debt", "General"]);
    expect(SOURCE_WORD.user_stated).toBe("You said");
    expect(KIND_WORD.budget_line).toBe("Change a budget line");
    expect(PROPOSAL_STATUS_WORD.proposed).toBe("Waiting for you");
  });

  it("a proposal's change, before → after, as the payload wrote it", () => {
    const cats = new Map([["cat-g", "Groceries"]]);
    expect(
      describeChange({ kind: "budget_line", payload: { target: "cat-1", before: 400, after: 350, label: "Dining out" } } as never, cats),
    ).toEqual({ what: "Dining out", before: "$400.00", after: "$350.00", beforeValue: "400", afterValue: "350", txnId: null });
    expect(
      describeChange({ kind: "set_category", payload: { target: "t", txnId: "txn-1", before: null, after: "cat-g" } } as never, cats),
    ).toEqual({ what: "Change a category", before: "Not filed", after: "Groceries", beforeValue: null, afterValue: null, txnId: "txn-1" });
    expect(describeChange({ kind: "weekly_limit", payload: { before: "x", after: null } } as never, cats).before).toBe("—");
  });
});
