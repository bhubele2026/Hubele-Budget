import { describe, it, expect } from "vitest";
import { latestMemberPlans, matchesSuggestion, monthWords, parsePositiveDollars, planErrorWords, planFor, plainDollars } from "./planWords";

const plan = (id: string, memberUserId: string | null, period: string, amount: string, effectiveFrom: string) => ({
  id, memberUserId, period, amount, effectiveFrom, source: "owner",
});

describe("plan words", () => {
  it("monthWords", () => {
    expect(monthWords("2028-03")).toBe("Mar 2028");
    expect(monthWords("junk")).toBe("junk");
  });
  it("typed dollars: positive only, canonical", () => {
    expect(parsePositiveDollars("$350")).toBe("350.00");
    expect(parsePositiveDollars("0")).toBeNull();
    expect(parsePositiveDollars("12.345")).toBeNull();
  });
  it("plainDollars drops .00 and keeps cents", () => {
    expect([plainDollars("600.00"), plainDollars("12.50"), plainDollars(null), plainDollars("x")]).toEqual(["600", "12.50", "", ""]);
  });
  it("error words", () => {
    expect(planErrorWords({ status: 403 })).toBe("Only the household owner can change this.");
    expect(planErrorWords({ status: 409 })).toContain("conflicts");
    expect(planErrorWords({})).toBe("Couldn't save. Try again.");
  });
  it("planFor takes the latest start per member and period; the shared pool is null", () => {
    const plans = [
      plan("a", null, "weekly", "300.00", "2026-01-04"),
      plan("b", null, "weekly", "350.00", "2026-09-27"),
      plan("c", "u2", "weekly", "40.00", "2026-09-27"),
      plan("d", null, "monthly", "1500.00", "2026-09-27"),
    ];
    expect(planFor(plans, null, "weekly")?.id).toBe("b");
    expect(planFor(plans, "u2", "weekly")?.id).toBe("c");
    expect(planFor(plans, "u3", "weekly")).toBeNull();
    expect(latestMemberPlans(plans).map((p) => p.id)).toEqual(["c"]);
  });
  it("matchesSuggestion is cents-exact", () => {
    expect(matchesSuggestion(350, 350)).toBe(true);
    expect(matchesSuggestion(350, 350.01)).toBe(false);
    expect(matchesSuggestion(null, 350)).toBe(false);
  });
});
