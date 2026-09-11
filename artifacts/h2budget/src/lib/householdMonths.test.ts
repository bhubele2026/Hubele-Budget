import { describe, expect, it } from "vitest";
import { currentMonthRange, currentWeekRange, currentYearRange, rangeForMode, weekSunday } from "./timeRange";
import { currentWeekBounds, isoDaysAgo, todayISO } from "./weeklyStreak";
import { localDateOf } from "./householdDay";

// (PR2 follow-up) Week, month and year all come from the household calendar
// (America/Chicago), so they can never disagree with each other or with the
// server. Run under TZ=UTC, TZ=America/Chicago and TZ=America/Los_Angeles: every
// answer here must be the same. A UTC browser is AHEAD of Chicago in the
// evening; a Pacific browser is BEHIND it around midnight.

/** Wed 9/30, 9:00pm Central — already October 1st in UTC. */
const LAST_EVENING_OF_SEPTEMBER = new Date("2026-10-01T02:00:00Z");
/** Thu 10/1, 12:30am Central — still Wed 9/30, 10:30pm in Pacific. */
const PACIFIC_LATE_SEPTEMBER_30 = new Date("2026-10-01T05:30:00Z");
/** Thu 12/31, 8:00pm Central — already 2027 in UTC. */
const NEW_YEARS_EVE = new Date("2027-01-01T02:00:00Z");
/** Sun 9/13, 12:30am Central — still Sat 9/12, 10:30pm in Pacific. */
const PACIFIC_SATURDAY_LATE = new Date("2026-09-13T05:30:00Z");

describe("timeRange — Mo and Yr on the household calendar", () => {
  it("the last evening of September is still September", () => {
    // Old, under UTC: October 2026.
    expect(currentMonthRange(LAST_EVENING_OF_SEPTEMBER)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
      label: "September 2026",
      mode: "mo",
    });
    expect(rangeForMode("mo", LAST_EVENING_OF_SEPTEMBER).to).toBe("2026-09-30");
  });

  it("a Pacific browser at 10:30pm on 9/30 is already in the household's October", () => {
    // Old, under Pacific: September 2026.
    expect(currentMonthRange(PACIFIC_LATE_SEPTEMBER_30)).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
      label: "October 2026",
      mode: "mo",
    });
  });

  it("New Year's Eve at 8pm Central is still 2026 and still December", () => {
    // Old, under UTC: 2027 and January 2027.
    expect(currentYearRange(NEW_YEARS_EVE)).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
      label: "2026",
      mode: "yr",
    });
    expect(currentMonthRange(NEW_YEARS_EVE).label).toBe("December 2026");
  });
});

describe("a browser behind Chicago (Pacific)", () => {
  it("Saturday 10:30pm Pacific is already Sunday 9/13 for the household", () => {
    expect(todayISO(PACIFIC_SATURDAY_LATE)).toBe("2026-09-13");
    expect(isoDaysAgo(PACIFIC_SATURDAY_LATE, 7)).toBe("2026-09-06");
    expect(currentWeekBounds(PACIFIC_SATURDAY_LATE)).toEqual({
      startISO: "2026-09-13",
      endISO: "2026-09-19",
    });
    expect(currentWeekRange(PACIFIC_SATURDAY_LATE)).toMatchObject({
      from: "2026-09-13",
      to: "2026-09-19",
      label: "Sep 13 – 19",
    });
    const sun = weekSunday(PACIFIC_SATURDAY_LATE);
    expect([sun.getFullYear(), sun.getMonth() + 1, sun.getDate(), sun.getHours()]).toEqual([
      2026, 9, 13, 0,
    ]);
  });
});

describe("daylight-saving edges (Central springs forward 3/8, falls back 11/1)", () => {
  // [instant, what it is in Chicago, household today, week start, week end]
  const cases: Array<[string, string, string, string, string]> = [
    ["2026-03-08T05:30:00Z", "Sat 3/7 11:30pm CST", "2026-03-07", "2026-03-01", "2026-03-07"],
    ["2026-03-08T08:30:00Z", "Sun 3/8 3:30am CDT", "2026-03-08", "2026-03-08", "2026-03-14"],
    ["2026-03-15T04:30:00Z", "Sat 3/14 11:30pm CDT", "2026-03-14", "2026-03-08", "2026-03-14"],
    ["2026-11-01T04:30:00Z", "Sat 10/31 11:30pm CDT", "2026-10-31", "2026-10-25", "2026-10-31"],
    ["2026-11-01T06:30:00Z", "Sun 11/1 1:30am CDT", "2026-11-01", "2026-11-01", "2026-11-07"],
    ["2026-11-01T07:30:00Z", "Sun 11/1 1:30am CST (the repeated hour)", "2026-11-01", "2026-11-01", "2026-11-07"],
    ["2026-11-08T05:30:00Z", "Sat 11/7 11:30pm CST", "2026-11-07", "2026-11-01", "2026-11-07"],
  ];

  it.each(cases)("%s (%s)", (instant, _central, today, start, end) => {
    const at = new Date(instant);
    expect(todayISO(at)).toBe(today);
    expect(currentWeekBounds(at)).toEqual({ startISO: start, endISO: end });
    expect(currentWeekRange(at)).toMatchObject({ from: start, to: end });
    // The local-midnight Sunday is that calendar day at 00:00 in any timezone.
    const sun = weekSunday(at);
    expect([sun.getFullYear(), sun.getMonth() + 1, sun.getDate(), sun.getHours()]).toEqual([
      Number(start.slice(0, 4)),
      Number(start.slice(5, 7)),
      Number(start.slice(8, 10)),
      0,
    ]);
    expect(currentMonthRange(at).from).toBe(`${today.slice(0, 7)}-01`);
  });
});

describe("localDateOf", () => {
  it("is that calendar day at local midnight", () => {
    const d = localDateOf("2026-11-01");
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours()]).toEqual([2026, 11, 1, 0]);
  });
});
