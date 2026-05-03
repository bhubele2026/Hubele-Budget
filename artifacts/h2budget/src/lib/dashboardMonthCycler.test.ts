import { describe, it, expect } from "vitest";
import {
  FLOOR_MONTH_INDEX,
  FLOOR_YEAR,
  computeViewMonth,
  isAtFloor,
  monthKeyFor,
  monthLabelFor,
} from "./dashboardMonthCycler";

describe("dashboardMonthCycler", () => {
  it("defaults (offset 0) to the current month", () => {
    const today = new Date(2026, 9, 17); // Oct 17, 2026
    const v = computeViewMonth(today, 0);
    expect(v.getFullYear()).toBe(2026);
    expect(v.getMonth()).toBe(9);
    expect(v.getDate()).toBe(1);
    expect(monthKeyFor(v)).toBe("2026-10");
  });

  it("walks back month by month with negative offsets", () => {
    const today = new Date(2026, 9, 17);
    expect(monthKeyFor(computeViewMonth(today, -1))).toBe("2026-09");
    expect(monthKeyFor(computeViewMonth(today, -6))).toBe("2026-04");
    expect(monthKeyFor(computeViewMonth(today, -7))).toBe("2026-03");
  });

  it("isAtFloor is true only at April 2026 (the configured floor)", () => {
    expect(FLOOR_YEAR).toBe(2026);
    expect(FLOOR_MONTH_INDEX).toBe(3);
    const today = new Date(2026, 9, 17);
    // Walking back from October 2026 by 6 months lands on April 2026 (the floor).
    expect(isAtFloor(computeViewMonth(today, -6))).toBe(true);
    // One month later (May 2026) is not the floor.
    expect(isAtFloor(computeViewMonth(today, -5))).toBe(false);
    // The current month is not the floor.
    expect(isAtFloor(computeViewMonth(today, 0))).toBe(false);
  });

  it("simulates the cycler: prev arrow is disabled at the April 2026 floor", () => {
    const today = new Date(2026, 9, 17);
    let offset = 0;
    // Helper that mimics the dashboard click handler: only decrement when not at floor.
    const tryPrev = () => {
      const v = computeViewMonth(today, offset);
      if (isAtFloor(v)) return;
      offset -= 1;
    };
    // Click "prev" 20 times — the cycler should bottom out at April 2026.
    for (let i = 0; i < 20; i++) tryPrev();
    const v = computeViewMonth(today, offset);
    expect(v.getFullYear()).toBe(FLOOR_YEAR);
    expect(v.getMonth()).toBe(FLOOR_MONTH_INDEX);
    expect(isAtFloor(v)).toBe(true);
  });

  it("yields a single shared monthKey that all three bucket cards consume", () => {
    // The Weekly, Monthly, and Unplanned cards each derive their own
    // periodKey from `viewMonth` using the same formula. This guarantees
    // they all reflect the selected month in lockstep.
    const today = new Date(2026, 9, 17);
    const v = computeViewMonth(today, -3); // July 2026
    const expected = "2026-07";
    // Simulate the three sections deriving the period key independently.
    const weeklyKey = monthKeyFor(v);
    const monthlyKey = monthKeyFor(v);
    const unplannedKey = monthKeyFor(v);
    expect(weeklyKey).toBe(expected);
    expect(monthlyKey).toBe(expected);
    expect(unplannedKey).toBe(expected);
  });

  it("formats the month label as 'MONTH YYYY' in uppercase", () => {
    const today = new Date(2026, 3, 1); // April 2026
    expect(monthLabelFor(computeViewMonth(today, 0))).toBe("APRIL 2026");
  });
});
