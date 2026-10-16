import { describe, it, expect } from "vitest";
import { DAY_CODEC, horizonForDay, monthEnd } from "./dayParam";

const OFFERED = [30, 90, 120, 183, 365];

describe("?day= (T3)", () => {
  it("reads only a real calendar day", () => {
    expect(DAY_CODEC.read("2026-10-22")).toBe("2026-10-22");
    expect(DAY_CODEC.read("2026-02-30")).toBeNull();
    expect(DAY_CODEC.read("2026-10-22T00:00")).toBeNull();
    expect(DAY_CODEC.read("soon")).toBeNull();
    expect(DAY_CODEC.read(null)).toBeNull();
    expect(DAY_CODEC.write("2026-10-22")).toBe("2026-10-22");
    expect(DAY_CODEC.write(null)).toBeNull();
  });

  it("widens the horizon just enough to hold the day, never narrows the chosen one", () => {
    expect(horizonForDay("2026-11-14", "2026-10-15", OFFERED, 30)).toBe(30); // day 30: the last day of a 30-day window
    expect(horizonForDay("2026-11-15", "2026-10-15", OFFERED, 30)).toBe(90);
    expect(horizonForDay("2027-01-12", "2026-10-15", OFFERED, 30)).toBe(90);
    expect(horizonForDay("2027-02-12", "2026-10-15", OFFERED, 30)).toBe(120);
    expect(horizonForDay("2026-10-20", "2026-10-15", OFFERED, 183)).toBe(183);
  });

  it("keeps the chosen horizon for no day, a past day, or one beyond the longest horizon", () => {
    expect(horizonForDay(null, "2026-10-15", OFFERED, 90)).toBe(90);
    expect(horizonForDay("2026-10-01", "2026-10-15", OFFERED, 30)).toBe(30);
    expect(horizonForDay("2028-01-01", "2026-10-15", OFFERED, 30)).toBe(30);
  });

  it("names a month's last day", () => {
    expect(monthEnd("2026-10")).toBe("2026-10-31");
    expect(monthEnd("2026-02")).toBe("2026-02-28");
    expect(monthEnd("2028-02")).toBe("2028-02-29");
    expect(monthEnd("2026-13")).toBeNull();
  });
});
