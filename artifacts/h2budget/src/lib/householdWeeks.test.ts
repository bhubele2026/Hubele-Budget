import { describe, expect, it } from "vitest";
import * as weeklyStreak from "./weeklyStreak";
import { currentWeekBounds, isoDaysAgo, todayISO } from "./weeklyStreak";
import { currentWeekRange, rangeForMode, weekSunday } from "./timeRange";
import { weekBounds } from "./householdDay";

// (PR2 leftovers) The browser's weeks are the household's (America/Chicago),
// whatever timezone the browser is in. Run this file under TZ=UTC and under
// TZ=America/Chicago: the answers must be the same. Under UTC the old
// browser-local helpers were already in next week on Saturday evening.

/** Saturday 9/12, 8:30pm Central — 01:30 on Sunday in UTC. */
const SATURDAY_EVENING = new Date("2026-09-13T01:30:00Z");
/** Saturday 10/3, 8:30pm Central — the week that straddles two months. */
const SATURDAY_EVENING_OCT = new Date("2026-10-04T01:30:00Z");
/** Wednesday 9/9, noon Central — no edge, the same answer on any clock. */
const WEDNESDAY_NOON = new Date("2026-09-09T17:00:00Z");

describe("householdDay re-exports the household week", () => {
  it("weekBounds is Sun–Sat around a date", () => {
    expect(weekBounds("2026-09-12")).toEqual({ start: "2026-09-06", end: "2026-09-12" });
  });
});

describe("weeklyStreak — the Banking page's bounds", () => {
  it("Saturday 8:30pm Central is still Saturday, in Sun 9/6 – Sat 9/12", () => {
    // Old, under UTC: today 09-13, week 09-13 … 09-19.
    expect(todayISO(SATURDAY_EVENING)).toBe("2026-09-12");
    expect(currentWeekBounds(SATURDAY_EVENING)).toEqual({
      startISO: "2026-09-06",
      endISO: "2026-09-12",
    });
  });

  it("counts the 90-day fetch window back from the household's today", () => {
    // Old, under UTC: 2026-06-15.
    expect(isoDaysAgo(SATURDAY_EVENING, 90)).toBe("2026-06-14");
  });

  it("gives the same week at midday on any clock", () => {
    expect(currentWeekBounds(WEDNESDAY_NOON)).toEqual({
      startISO: "2026-09-06",
      endISO: "2026-09-12",
    });
  });

  it("no longer carries the unused weeklyBudgetStreak", () => {
    expect("weeklyBudgetStreak" in weeklyStreak).toBe(false);
  });
});

describe("timeRange — the Wk toggle", () => {
  it("Saturday 8:30pm Central shows Sep 6 – 12", () => {
    // Old, under UTC: 09-13 … 09-19, "Sep 13 – 19".
    expect(currentWeekRange(SATURDAY_EVENING)).toEqual({
      from: "2026-09-06",
      to: "2026-09-12",
      label: "Sep 6 – 12",
      mode: "wk",
    });
    expect(rangeForMode("wk", SATURDAY_EVENING).from).toBe("2026-09-06");
  });

  it("labels a week that crosses a month with both months", () => {
    // Old, under UTC: "Oct 4 – 10".
    expect(currentWeekRange(SATURDAY_EVENING_OCT)).toMatchObject({
      from: "2026-09-27",
      to: "2026-10-03",
      label: "Sep 27 – Oct 3",
    });
  });

  it("weekSunday is the household Sunday as a local-midnight Date", () => {
    const sun = weekSunday(SATURDAY_EVENING);
    expect([sun.getFullYear(), sun.getMonth() + 1, sun.getDate()]).toEqual([2026, 9, 6]);
    expect([sun.getHours(), sun.getMinutes()]).toEqual([0, 0]);
  });
});
