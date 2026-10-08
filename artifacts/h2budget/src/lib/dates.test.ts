import { describe, it, expect } from "vitest";
import { dayWord, longDate, relativeTime, shortDate, shortDateOfInstant, weekdayDate } from "./dates";

/** Runs under four TZs in CI; every answer here must be the same in all four. */
describe("dates — words for household calendar dates, in any device zone", () => {
  it("long and short forms of a YYYY-MM-DD date", () => {
    expect(longDate("2026-10-07")).toBe("Wednesday, October 7");
    expect(shortDate("2026-10-12")).toBe("Oct 12");
    expect(shortDate("2026-01-01")).toBe("Jan 1");
  });

  it("an instant is read on the household's calendar (America/Chicago)", () => {
    // 03:00 UTC on the 8th is 22:00 on the 7th in Chicago.
    expect(shortDateOfInstant("2026-10-08T03:00:00Z")).toBe("Oct 7");
    expect(shortDateOfInstant("2026-10-08T06:00:00Z")).toBe("Oct 8");
  });

  it("garbage in is an empty string, not 'Invalid Date'", () => {
    expect(longDate("soon")).toBe("");
    expect(shortDateOfInstant("soon")).toBe("");
  });
});

describe("relativeTime — ported words", () => {
  const now = new Date("2026-10-07T14:00:00Z");
  it.each([
    ["2026-10-07T13:59:45Z", "just now"],
    ["2026-10-07T13:48:00Z", "12 minutes ago"],
    ["2026-10-07T13:00:00Z", "1 hour ago"],
    ["2026-10-06T13:00:00Z", "yesterday"],
    ["2026-10-04T13:00:00Z", "3 days ago"],
    ["2026-10-07T14:05:00Z", "just now"],
  ])("%s → %s", (iso, words) => {
    expect(relativeTime(iso, now)).toBe(words);
  });
  it("nothing for nothing", () => {
    expect(relativeTime(null, now)).toBe("");
  });
});

describe("dates — weekday forms and today/tomorrow words (S1)", () => {
  it("'Fri, Oct 9' for a date, in any device zone", () => {
    expect(weekdayDate("2026-10-09")).toBe("Fri, Oct 9");
  });

  it("today, tomorrow and yesterday are words; anything else is the date", () => {
    expect(dayWord("2026-10-07", "2026-10-07")).toBe("today");
    expect(dayWord("2026-10-08", "2026-10-07")).toBe("tomorrow");
    expect(dayWord("2026-10-06", "2026-10-07")).toBe("yesterday");
    expect(dayWord("2026-10-12", "2026-10-07")).toBe("Mon, Oct 12");
    expect(dayWord("2026-11-01", "2026-10-31")).toBe("tomorrow");
  });
});
