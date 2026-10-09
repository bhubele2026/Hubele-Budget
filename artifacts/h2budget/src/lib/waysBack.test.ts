import { describe, it, expect } from "vitest";
import { carryOverLine, errorWords, fmtCents, weekdayName } from "./waysBack";

describe("ways back words", () => {
  it("fmtCents formats whole cents as money; null is the missing face", () => {
    expect(fmtCents(4000)).toBe("$40.00");
    expect(fmtCents(null)).toBe("—");
  });
  it("weekdayName", () => {
    expect(weekdayName("2026-10-10")).toBe("Saturday");
  });
  it("errorWords: the owner-only 403 has its own sentence", () => {
    expect(errorWords({ status: 403 })).toBe("Only the household owner can do this.");
    expect(errorWords({})).toBe("Couldn't save that. Try again.");
  });
  const adj = { amount: "-40.00", weekStart: "2026-10-04" };
  it("carryOverLine: this week, next week, other weeks, none", () => {
    expect(carryOverLine(adj, "2026-10-04", "2026-10-04")).toBe("This week starts $40.00 lower (you chose this)");
    expect(carryOverLine(adj, "2026-09-27", "2026-10-04")).toBe("Next week starts $40.00 lower (you chose this)");
    expect(carryOverLine(adj, "2026-09-27", "2026-09-27")).toBe("Next week starts $40.00 lower (you chose this)");
    expect(carryOverLine(adj, "2026-10-04", "2026-10-11")).toBe("That week started $40.00 lower (you chose this)");
    expect(carryOverLine(adj, "2026-09-13", "2026-10-04")).toBeNull();
    expect(carryOverLine(null, "2026-10-04", "2026-10-04")).toBeNull();
    expect(carryOverLine({ amount: "0.00", weekStart: "2026-10-04" }, "2026-10-04", "2026-10-04")).toBeNull();
  });
});
