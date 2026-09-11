import { afterEach, describe, expect, it } from "vitest";
import {
  addDaysISO,
  dayOfWeekISO,
  householdDateOf,
  householdToday,
  monthBounds,
  weekBounds,
} from "@workspace/avalanche-core";

// The household calendar must not depend on the machine it runs on: Render is
// UTC, Brad's laptop is Central. Every case runs under both.
const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

for (const tz of ["UTC", "America/Chicago"]) {
  describe(`household calendar with the process in ${tz}`, () => {
    const inTz = () => {
      process.env.TZ = tz;
    };

    it("Saturday 8:30pm Central is still Saturday, still this week", () => {
      inTz();
      const now = new Date("2026-09-13T01:30:00Z"); // Sat 9/12 20:30 CDT
      expect(householdToday(now)).toBe("2026-09-12");
      expect(weekBounds(householdToday(now))).toEqual({
        start: "2026-09-06",
        end: "2026-09-12",
      });
    });

    it("half past midnight Central Sunday starts the new week", () => {
      inTz();
      const now = new Date("2026-09-13T05:30:00Z"); // Sun 9/13 00:30 CDT
      expect(householdToday(now)).toBe("2026-09-13");
      expect(weekBounds("2026-09-13")).toEqual({
        start: "2026-09-13",
        end: "2026-09-19",
      });
    });

    it("the last evening of a month is still that month", () => {
      inTz();
      const now = new Date("2026-09-01T01:00:00Z"); // Mon 8/31 20:00 CDT
      expect(householdToday(now)).toBe("2026-08-31");
      expect(monthBounds(householdToday(now))).toEqual({
        start: "2026-08-01",
        end: "2026-08-31",
        endExclusive: "2026-09-01",
      });
    });

    it("an evening bank snapshot keeps its own day", () => {
      inTz();
      expect(householdDateOf(new Date("2026-09-11T02:30:00Z"))).toBe("2026-09-10"); // Thu 21:30 CDT
    });

    it("crosses the March daylight-saving change on the right day", () => {
      inTz();
      expect(householdDateOf(new Date("2026-03-08T07:30:00Z"))).toBe("2026-03-08"); // 01:30 CST
      expect(householdDateOf(new Date("2026-03-08T08:30:00Z"))).toBe("2026-03-08"); // 03:30 CDT
      expect(householdDateOf(new Date("2026-03-08T05:59:00Z"))).toBe("2026-03-07"); // 23:59 CST
    });

    it("crosses the November daylight-saving change on the right day", () => {
      inTz();
      expect(householdDateOf(new Date("2026-11-01T04:30:00Z"))).toBe("2026-10-31"); // 23:30 CDT
      expect(householdDateOf(new Date("2026-11-01T05:30:00Z"))).toBe("2026-11-01"); // 00:30 CDT
      expect(householdDateOf(new Date("2026-11-01T06:30:00Z"))).toBe("2026-11-01"); // 01:30 CDT
      expect(householdDateOf(new Date("2026-11-01T07:30:00Z"))).toBe("2026-11-01"); // 01:30 CST
    });

    it("does calendar arithmetic without a timezone", () => {
      inTz();
      expect(addDaysISO("2026-03-07", 1)).toBe("2026-03-08");
      expect(addDaysISO("2026-11-01", -1)).toBe("2026-10-31");
      expect(addDaysISO("2026-12-31", 1)).toBe("2027-01-01");
      expect(dayOfWeekISO("2026-09-13")).toBe(0);
      expect(dayOfWeekISO("2026-09-12")).toBe(6);
      expect(weekBounds("2026-09-12")).toEqual({ start: "2026-09-06", end: "2026-09-12" });
      expect(monthBounds("2028-02-10")).toEqual({
        start: "2028-02-01",
        end: "2028-02-29",
        endExclusive: "2028-03-01",
      });
    });
  });
}
