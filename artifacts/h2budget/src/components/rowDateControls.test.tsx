import { describe, it, expect } from "vitest";
import { shiftISODate } from "./row-date-controls";

describe("shiftISODate", () => {
  it("moves a Sunday back to the preceding Saturday (the core week-fix)", () => {
    // 2026-06-07 is a Sunday; -1 day lands on Saturday 2026-06-06, pulling
    // the charge back into the prior Sun→Sat allowance week.
    expect(shiftISODate("2026-06-07", -1)).toBe("2026-06-06");
  });

  it("crosses a month boundary", () => {
    expect(shiftISODate("2026-06-01", -1)).toBe("2026-05-31");
  });

  it("crosses a year boundary", () => {
    expect(shiftISODate("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("handles a leap day", () => {
    expect(shiftISODate("2028-03-01", -1)).toBe("2028-02-29");
  });

  it("tolerates a full timestamp by slicing to the date", () => {
    expect(shiftISODate("2026-06-07T13:45:00Z", -1)).toBe("2026-06-06");
  });

  it("supports forward shifts too", () => {
    expect(shiftISODate("2026-06-06", 1)).toBe("2026-06-07");
  });
});
