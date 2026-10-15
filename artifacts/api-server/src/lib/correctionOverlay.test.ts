// (Q2) The dry run's overlay is pure: these pin how it reads a row, the pending
// pairs' filing and the ledger's pairs as a fix would leave them.
import { describe, it, expect } from "vitest";
import { patchRow, patchRows, patchSupersede, suggestionsAfter, tier2PairedAfter, type CorrectionOverlay } from "./correctionOverlay";

const overlay: CorrectionOverlay = {
  rows: new Map([["t1", { categoryId: "cat-x", isTransfer: true, weeklyAllowance: false, categoryLockedByUser: true }]]),
  addMatched: [{ txnId: "t2", occurredOn: "2026-10-12", recurringItemId: "bill-1", occurrenceDate: "2026-10-20" }],
  removedResolutionIds: new Set(["r-old"]),
  resolvedPlanKeys: new Set(["bill-1|2026-10-20"]),
};

describe("correctionOverlay", () => {
  it("patches only the columns the reader selected, and only the fix's rows", () => {
    const row = { id: "t1", categoryId: "cat-a", isTransfer: false, weeklyAllowance: true, amount: "-5.00" };
    expect(patchRow(row, overlay)).toEqual({ id: "t1", categoryId: "cat-x", isTransfer: true, weeklyAllowance: false, amount: "-5.00" });
    // `categoryLockedByUser` was not selected: not added.
    expect("categoryLockedByUser" in patchRow(row, overlay)).toBe(false);
    const other = { id: "t9", categoryId: "cat-a" };
    expect(patchRow(other, overlay)).toBe(other);
    expect(patchRows([row, other], null)).toEqual([row, other]);
  });

  it("re-files a replaced pending row's filing, never which row replaced which", () => {
    const filing = { categoryId: "cat-a", weeklyAllowance: true, monthlyAllowance: false, unplannedAllowance: false, weeklyBucket: null, reimbursable: false, debtId: null, isTransfer: false, isTransferUserOverridden: false };
    const supersede = { replacedIds: new Set(["t1"]), replacedBy: new Map([["p1", { id: "t1", occurredOn: "2026-10-10", description: "X", filing }]]) };
    const out = patchSupersede(supersede, overlay);
    expect(out.replacedIds).toBe(supersede.replacedIds);
    expect(out.replacedBy.get("p1")!.filing).toEqual({ ...filing, categoryId: "cat-x", isTransfer: true, weeklyAllowance: false });
    expect(supersede.replacedBy.get("p1")!.filing).toBe(filing);
    expect(patchSupersede(supersede, null)).toBe(supersede);
  });

  it("drops the ledger's pairs and suggestions with an occurrence the fix answers, or on a row it confirms", () => {
    const matches = [
      { tier: 2, offCurve: true, txnId: "a", planKey: "bill-1|2026-10-20" },
      { tier: 2, offCurve: true, txnId: "b", planKey: "bill-2|2026-10-05" },
      { tier: 2, offCurve: true, txnId: "t2", planKey: "bill-3|2026-10-01" },
      { tier: 3, offCurve: false, txnId: "c", planKey: "bill-2|2026-10-05" },
    ];
    expect([...tier2PairedAfter(matches, overlay)]).toEqual(["b"]);
    const suggestions = new Map([
      ["c", { planKey: "bill-1|2026-10-20" }],
      ["d", { planKey: "bill-2|2026-10-05" }],
      ["t2", { planKey: "bill-4|2026-10-07" }],
    ]);
    expect([...suggestionsAfter(suggestions, overlay).keys()]).toEqual(["d"]);
    expect(suggestionsAfter(suggestions, null)).toBe(suggestions);
  });
});
