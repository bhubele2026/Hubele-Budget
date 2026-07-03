import { describe, it, expect } from "vitest";
import { classifyHeuristic } from "./merchantClassify";

// The classifier's deterministic fallback is what guarantees a restaurant can
// never land in "cancel these" even when the AI is off. These lock the core
// distinctions the rework is about: subscription vs dining vs bill.
describe("classifyHeuristic — the subscription/habit/bill brain", () => {
  it("labels true subscriptions as 'subscription'", () => {
    expect(classifyHeuristic("Hulu", null)).toBe("subscription");
    expect(classifyHeuristic("Netflix.com", null)).toBe("subscription");
    expect(classifyHeuristic("Paramount+", null)).toBe("subscription");
    expect(classifyHeuristic("Spotify USA", null)).toBe("subscription");
  });

  it("NEVER calls a restaurant, coffee shop, or theater a subscription", () => {
    // The exact merchants the owner called out as wrongly flagged "cancel".
    expect(classifyHeuristic("Mooyah", "Dining")).toBe("dining");
    expect(classifyHeuristic("Mooyah", null)).toBe("dining");
    expect(classifyHeuristic("Marcus Theatres", null)).toBe("entertainment");
    expect(classifyHeuristic("Starbucks", null)).toBe("coffee");
    for (const name of ["Mooyah", "Marcus Theatres", "Starbucks"]) {
      expect(classifyHeuristic(name, null)).not.toBe("subscription");
    }
  });

  it("labels real bills/utilities/loans/fuel as 'bill' (never a subscription)", () => {
    expect(classifyHeuristic("Madison Gas & Electric", null)).toBe("bill");
    expect(classifyHeuristic("Nelnet Student Loan", null)).toBe("bill");
    expect(classifyHeuristic("State Farm Insurance", null)).toBe("bill");
    expect(classifyHeuristic("Kwik Trip", null)).toBe("bill");
  });

  it("uses the budget category when it's a strong signal", () => {
    expect(classifyHeuristic("Unknown Vendor", "Utilities")).toBe("bill");
    expect(classifyHeuristic("Unknown Vendor", "Streaming")).toBe("subscription");
    expect(classifyHeuristic("Unknown Vendor", "Coffee")).toBe("coffee");
  });

  it("labels retail as 'shopping' and unknowns as 'other'", () => {
    expect(classifyHeuristic("Amazon", null)).toBe("shopping");
    expect(classifyHeuristic("Target", null)).toBe("shopping");
    expect(classifyHeuristic("Zzqx Holdings", null)).toBe("other");
  });
});
