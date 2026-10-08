import { describe, it, expect } from "vitest";
import { localDateInZone, zonedTimeToUtc } from "@workspace/avalanche-core";

// (AI-4a) localDateInZone / zonedTimeToUtc: the recap is sent at each member's
// own local time, so these two decide WHICH day it is and WHEN 07:00 is. They
// are checked across both 2026 US transitions (spring forward 3/8, fall back
// 11/1) for Central and Eastern, in a zone with no DST, and in a half-hour zone.

const iso = (d: Date) => d.toISOString();

describe("localDateInZone", () => {
  it("is the member's calendar date, not UTC's", () => {
    // 18:30 and 19:30 Central on Oct 7 are 23:30 Oct 7 and 00:30 Oct 8 UTC.
    expect(localDateInZone(new Date("2026-10-07T23:30:00Z"), "America/Chicago")).toBe("2026-10-07");
    expect(localDateInZone(new Date("2026-10-08T00:30:00Z"), "America/Chicago")).toBe("2026-10-07");
    // 04:30Z is 23:30 the evening before in Central daylight time; 05:00Z is midnight.
    expect(localDateInZone(new Date("2026-10-08T04:59:59Z"), "America/Chicago")).toBe("2026-10-07");
    expect(localDateInZone(new Date("2026-10-08T05:00:00Z"), "America/Chicago")).toBe("2026-10-08");
  });

  it("follows the zone's offset in winter and summer", () => {
    expect(localDateInZone(new Date("2026-01-15T05:59:59Z"), "America/Chicago")).toBe("2026-01-14");
    expect(localDateInZone(new Date("2026-01-15T06:00:00Z"), "America/Chicago")).toBe("2026-01-15");
    expect(localDateInZone(new Date("2026-07-15T03:59:59Z"), "America/New_York")).toBe("2026-07-14");
    expect(localDateInZone(new Date("2026-07-15T04:00:00Z"), "America/New_York")).toBe("2026-07-15");
  });

  it("is a day ahead east of UTC, and unmoved by the machine's own zone", () => {
    expect(localDateInZone(new Date("2026-10-07T20:00:00Z"), "Asia/Kolkata")).toBe("2026-10-08");
    const saved = process.env.TZ;
    try {
      for (const tz of ["UTC", "Pacific/Auckland"]) {
        process.env.TZ = tz;
        expect(localDateInZone(new Date("2026-10-08T04:30:00Z"), "America/Chicago")).toBe("2026-10-07");
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it("rejects an unknown zone", () => {
    expect(() => localDateInZone(new Date(), "Not/AZone")).toThrow();
  });
});

describe("zonedTimeToUtc", () => {
  const cases: Array<[string, string, string, string]> = [
    // zone, date, hh:mm, expected UTC instant
    ["America/Chicago", "2026-03-07", "07:00", "2026-03-07T13:00:00.000Z"], // CST (UTC-6) the day before
    ["America/Chicago", "2026-03-08", "07:00", "2026-03-08T12:00:00.000Z"], // CDT (UTC-5): clocks sprang forward at 02:00
    ["America/Chicago", "2026-03-09", "07:00", "2026-03-09T12:00:00.000Z"],
    ["America/Chicago", "2026-10-31", "07:00", "2026-10-31T12:00:00.000Z"], // CDT the day before
    ["America/Chicago", "2026-11-01", "07:00", "2026-11-01T13:00:00.000Z"], // CST: clocks fell back at 02:00
    ["America/Chicago", "2026-11-02", "07:00", "2026-11-02T13:00:00.000Z"],
    ["America/New_York", "2026-03-07", "07:00", "2026-03-07T12:00:00.000Z"],
    ["America/New_York", "2026-03-08", "07:00", "2026-03-08T11:00:00.000Z"],
    ["America/New_York", "2026-10-31", "07:00", "2026-10-31T11:00:00.000Z"],
    ["America/New_York", "2026-11-01", "07:00", "2026-11-01T12:00:00.000Z"],
    // No DST at all.
    ["America/Phoenix", "2026-03-08", "07:00", "2026-03-08T14:00:00.000Z"],
    ["America/Phoenix", "2026-11-01", "07:00", "2026-11-01T14:00:00.000Z"],
    ["UTC", "2026-11-01", "07:00", "2026-11-01T07:00:00.000Z"],
    // A half-hour offset, east of UTC (the local date is a day ahead of UTC's evening).
    ["Asia/Kolkata", "2026-03-08", "07:00", "2026-03-08T01:30:00.000Z"],
    // Late evening and midnight.
    ["America/Chicago", "2026-10-07", "23:30", "2026-10-08T04:30:00.000Z"],
    ["America/Chicago", "2026-10-07", "00:00", "2026-10-07T05:00:00.000Z"],
  ];
  for (const [tz, date, hhmm, want] of cases) {
    it(`${hhmm} on ${date} in ${tz} is ${want}`, () => {
      const got = zonedTimeToUtc(date, hhmm, tz);
      expect(iso(got)).toBe(want);
      // And it reads back as the same wall date.
      expect(localDateInZone(got, tz)).toBe(date);
    });
  }

  it("takes the earlier instant when the wall time happens twice (fall back)", () => {
    // 01:30 on 2026-11-01 occurs at 06:30Z (CDT) and again at 07:30Z (CST).
    expect(iso(zonedTimeToUtc("2026-11-01", "01:30", "America/Chicago"))).toBe("2026-11-01T06:30:00.000Z");
  });

  it("moves a wall time that never happens (spring forward) to just after the gap", () => {
    // 02:30 on 2026-03-08 does not exist in Central: read with CST it is 08:30Z = 03:30 CDT.
    const got = zonedTimeToUtc("2026-03-08", "02:30", "America/Chicago");
    expect(iso(got)).toBe("2026-03-08T08:30:00.000Z");
    expect(localDateInZone(got, "America/Chicago")).toBe("2026-03-08");
  });

  it("gives the same instant on a UTC machine and a Central one", () => {
    const saved = process.env.TZ;
    try {
      for (const tz of ["UTC", "America/Chicago", "Asia/Tokyo"]) {
        process.env.TZ = tz;
        expect(iso(zonedTimeToUtc("2026-11-01", "07:00", "America/Chicago"))).toBe("2026-11-01T13:00:00.000Z");
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});
