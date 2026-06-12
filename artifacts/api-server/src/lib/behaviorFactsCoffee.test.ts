import { describe, it, expect } from "vitest";
import { matchesBucket } from "./behaviorFacts";

describe("matchesBucket — coffee", () => {
  it("counts a coffee-shop BRAND as coffee even above the old $15 cap", () => {
    // The bug: a $25 Starbucks run (two drinks + a pastry / group order)
    // was dropped from the coffee bucket by the old `amount < 15` guard,
    // so "days since last coffee shop" ignored real Starbucks visits.
    expect(matchesBucket("coffee", "Starbucks", "Dining", 25)).toBe(true);
    expect(matchesBucket("coffee", "DUNKIN #1234", null, 18.5)).toBe(true);
    expect(matchesBucket("coffee", "Caribou Coffee", null, 22)).toBe(true);
  });

  it("still counts a small brand purchase", () => {
    expect(matchesBucket("coffee", "Dunkin'", null, 4.95)).toBe(true);
  });

  it("drops absurd brand outliers (catering / gift-card reloads)", () => {
    expect(matchesBucket("coffee", "Starbucks", null, 150)).toBe(false);
  });

  it("keeps the small-amount guard for GENERIC coffee words", () => {
    // "cafe"/"coffee" ride along on a bag of beans or coffee-table
    // furniture, so the tight cap still applies to non-brand matches.
    expect(matchesBucket("coffee", "Corner Cafe", null, 9)).toBe(true);
    expect(matchesBucket("coffee", "Corner Cafe", null, 25)).toBe(false);
    expect(matchesBucket("coffee", "World Market coffee table", null, 60)).toBe(
      false,
    );
  });

  it("does not match a non-coffee merchant", () => {
    expect(matchesBucket("coffee", "Kwik Trip", "Gas", 5)).toBe(false);
  });
});
