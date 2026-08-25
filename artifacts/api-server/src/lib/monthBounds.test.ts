import { describe, it, expect } from "vitest";
import { monthEndExclusive, daysInMonth } from "./monthBounds";

describe("monthEndExclusive", () => {
  it("returns the first of the next month", () => {
    expect(monthEndExclusive("2026-05-01")).toBe("2026-06-01");
    expect(monthEndExclusive("2026-06-01")).toBe("2026-07-01");
    expect(monthEndExclusive("2026-02-01")).toBe("2026-03-01");
  });

  it("rolls the year over at December", () => {
    expect(monthEndExclusive("2026-12-01")).toBe("2027-01-01");
  });

  it("handles a leap February", () => {
    expect(monthEndExclusive("2024-02-01")).toBe("2024-03-01");
    expect(daysInMonth("2024-02-01")).toBe(29);
    expect(daysInMonth("2026-02-01")).toBe(28);
  });

  it("⚠️ is the same answer whatever the host timezone is", () => {
    // The regression. The old `new Date(m).setMonth(getMonth() + 1)` read UTC
    // and wrote LOCAL, so in America/Chicago it produced 2026-03-04 for
    // February — four days of March counted as February spend. This is a pure
    // string→string function with no local-time field access anywhere, so the
    // property holds by construction; the assertion documents the contract.
    const before = process.env.TZ;
    try {
      for (const tz of ["UTC", "America/Chicago", "Pacific/Kiritimati"]) {
        process.env.TZ = tz;
        expect(monthEndExclusive("2026-02-01")).toBe("2026-03-01");
        expect(monthEndExclusive("2026-06-01")).toBe("2026-07-01");
        expect(daysInMonth("2026-06-01")).toBe(30);
      }
    } finally {
      process.env.TZ = before;
    }
  });

  it("counts the days each month actually has", () => {
    expect(daysInMonth("2026-05-01")).toBe(31);
    expect(daysInMonth("2026-06-01")).toBe(30);
  });

  it("refuses a malformed month rather than inventing a window", () => {
    expect(() => monthEndExclusive("nonsense")).toThrow();
  });
});
