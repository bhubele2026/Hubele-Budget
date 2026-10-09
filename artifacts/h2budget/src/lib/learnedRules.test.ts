import { describe, it, expect } from "vitest";
import type { LearnedRule } from "@workspace/api-client-react/features";
import {
  LEARNED_SCOPES,
  amountBandWords,
  confirmedWords,
  filedWords,
  merchantName,
  previewTail,
  scopeAvailable,
  sortLearnedRules,
} from "./learnedRules";

// (F2) The words and order of the learned-rules panel, ported from h2's
// RulesView (its `activity.test.tsx` "Rules" cases) onto classic's lib.

function rule(id: string, over: Partial<LearnedRule> = {}): LearnedRule {
  return {
    id,
    signature: "corner market",
    scope: "merchant",
    plaidAccountId: null,
    amountBandLo: null,
    amountBandHi: null,
    categoryId: "c1",
    count: 6,
    lastConfirmedAt: "2026-10-05T12:00:00Z",
    disabled: false,
    source: "user",
    createdAt: "2026-08-01T12:00:00Z",
    ...over,
  };
}

describe("learned rules — words", () => {
  it("names the merchant in title case", () => {
    expect(merchantName("corner market")).toBe("Corner Market");
    expect(merchantName("h-e-b grocery #12")).toBe("H-E-B Grocery #12");
  });

  it("says how often and when it was last confirmed, on the household calendar", () => {
    expect(confirmedWords(rule("a"))).toBe("Confirmed 6 times · last Oct 5");
    expect(confirmedWords(rule("a", { count: 1 }))).toBe("Confirmed 1 time · last Oct 5");
    expect(confirmedWords(rule("a", { lastConfirmedAt: null }))).toBe("Confirmed 6 times");
    // 03:00 UTC on Oct 6 is still Oct 5 in America/Chicago.
    expect(confirmedWords(rule("a", { lastConfirmedAt: "2026-10-06T03:00:00Z" }))).toBe(
      "Confirmed 6 times · last Oct 5",
    );
  });

  it("shows the amount band only for a similar-amounts rule that has both ends", () => {
    expect(
      amountBandWords(rule("a", { scope: "merchant_amount", amountBandLo: "40", amountBandHi: "60.5" })),
    ).toBe("$40.00 to $60.50");
    expect(amountBandWords(rule("a", { scope: "merchant", amountBandLo: "40", amountBandHi: "60" }))).toBeNull();
    expect(amountBandWords(rule("a", { scope: "merchant_amount", amountBandLo: "40" }))).toBeNull();
  });

  it("filing and preview lines", () => {
    expect(filedWords(0)).toBe("No past charges to file.");
    expect(filedWords(1)).toBe("Filed 1 past charge.");
    expect(filedWords(7)).toBe("Filed 7 past charges.");
    expect(previewTail(1, "Groceries")).toBe("past charge will move into Groceries.");
    expect(previewTail(7, "Groceries")).toBe("past charges will move into Groceries.");
  });

  it("the three scopes, in h2's words", () => {
    expect(LEARNED_SCOPES.map((s) => [s.key, s.label])).toEqual([
      ["merchant", "Any account, any amount"],
      ["merchant_account", "This account only"],
      ["merchant_amount", "Similar amounts only"],
    ]);
  });
});

describe("learned rules — order and scope", () => {
  it("off rules last, then most recently confirmed, then by name", () => {
    const out = sortLearnedRules([
      rule("old", { signature: "b", lastConfirmedAt: "2026-09-01T12:00:00Z" }),
      rule("off", { signature: "a", disabled: true, lastConfirmedAt: "2026-10-07T12:00:00Z" }),
      rule("new", { signature: "c", lastConfirmedAt: "2026-10-06T12:00:00Z" }),
      rule("never", { signature: "d", lastConfirmedAt: null }),
      rule("tieB", { signature: "f", lastConfirmedAt: "2026-09-01T12:00:00Z" }),
    ]);
    expect(out.map((r) => r.id)).toEqual(["new", "old", "tieB", "never", "off"]);
  });

  it("does not sort the caller's array in place", () => {
    const input = [rule("b", { signature: "b" }), rule("a", { signature: "a" })];
    sortLearnedRules(input);
    expect(input.map((r) => r.id)).toEqual(["b", "a"]);
  });

  it("offers a narrower scope only when the rule has what it narrows to (the server refuses otherwise)", () => {
    const bare = rule("a");
    expect(scopeAvailable(bare, "merchant")).toBe(true);
    expect(scopeAvailable(bare, "merchant_account")).toBe(false);
    expect(scopeAvailable(bare, "merchant_amount")).toBe(false);
    const full = rule("b", { plaidAccountId: "acc_1", amountBandLo: "1", amountBandHi: "2" });
    expect(scopeAvailable(full, "merchant_account")).toBe(true);
    expect(scopeAvailable(full, "merchant_amount")).toBe(true);
    // The rule's own scope is always selectable.
    expect(scopeAvailable(rule("c", { scope: "merchant_amount" }), "merchant_amount")).toBe(true);
  });
});
