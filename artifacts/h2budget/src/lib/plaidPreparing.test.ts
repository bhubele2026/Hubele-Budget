import { describe, it, expect } from "vitest";
import {
  formatPreparingElapsed,
  isPreparingStalled,
  STALLED_PREPARING_MS,
} from "./plaidPreparing";

const NOW = new Date("2026-05-04T12:00:00.000Z").getTime();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60_000).toISOString();

describe("formatPreparingElapsed", () => {
  it("returns null for missing/invalid timestamps", () => {
    expect(formatPreparingElapsed(null, NOW)).toBeNull();
    expect(formatPreparingElapsed(undefined, NOW)).toBeNull();
    expect(formatPreparingElapsed("not-a-date", NOW)).toBeNull();
  });

  it("renders 'just now' under one minute", () => {
    expect(formatPreparingElapsed(new Date(NOW - 5_000).toISOString(), NOW)).toBe(
      "just now",
    );
  });

  it("renders minutes under one hour", () => {
    expect(formatPreparingElapsed(minutesAgo(12), NOW)).toBe("12m");
    expect(formatPreparingElapsed(minutesAgo(59), NOW)).toBe("59m");
  });

  it("renders hours under one day", () => {
    expect(formatPreparingElapsed(hoursAgo(3), NOW)).toBe("3h");
    expect(formatPreparingElapsed(hoursAgo(23), NOW)).toBe("23h");
  });

  it("renders days for longer stalls", () => {
    expect(formatPreparingElapsed(hoursAgo(48), NOW)).toBe("2d");
  });
});

describe("isPreparingStalled", () => {
  it("is false for missing/recent timestamps", () => {
    expect(isPreparingStalled(null, NOW)).toBe(false);
    expect(isPreparingStalled(undefined, NOW)).toBe(false);
    expect(isPreparingStalled(minutesAgo(30), NOW)).toBe(false);
    expect(isPreparingStalled(hoursAgo(5), NOW)).toBe(false);
  });

  it("trips at exactly the 6h threshold and beyond", () => {
    const exact = new Date(NOW - STALLED_PREPARING_MS).toISOString();
    expect(isPreparingStalled(exact, NOW)).toBe(true);
    expect(isPreparingStalled(hoursAgo(12), NOW)).toBe(true);
  });
});
