import { describe, it, expect } from "vitest";
import {
  formatConsentRefreshAge,
  isConsentRefreshStale,
  STALE_CONSENT_REFRESH_MS,
} from "./plaidConsentFreshness";

const NOW = new Date("2026-05-04T12:00:00.000Z").getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 60 * 60_000).toISOString();
const daysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60_000).toISOString();

describe("isConsentRefreshStale", () => {
  it("is false for missing/invalid timestamps", () => {
    expect(isConsentRefreshStale(null, NOW)).toBe(false);
    expect(isConsentRefreshStale(undefined, NOW)).toBe(false);
    expect(isConsentRefreshStale("not-a-date", NOW)).toBe(false);
  });

  it("is false within the 3-day grace window", () => {
    expect(isConsentRefreshStale(hoursAgo(1), NOW)).toBe(false);
    expect(isConsentRefreshStale(daysAgo(1), NOW)).toBe(false);
    expect(isConsentRefreshStale(hoursAgo(71), NOW)).toBe(false);
  });

  it("trips at exactly the 3-day threshold and beyond", () => {
    const exact = new Date(NOW - STALE_CONSENT_REFRESH_MS).toISOString();
    expect(isConsentRefreshStale(exact, NOW)).toBe(true);
    expect(isConsentRefreshStale(daysAgo(7), NOW)).toBe(true);
    expect(isConsentRefreshStale(daysAgo(30), NOW)).toBe(true);
  });

  it("uses 3 days exactly (guards against accidental threshold drift)", () => {
    expect(STALE_CONSENT_REFRESH_MS).toBe(3 * 24 * 60 * 60 * 1000);
  });
});

describe("formatConsentRefreshAge", () => {
  it("returns null for missing/invalid timestamps", () => {
    expect(formatConsentRefreshAge(null, NOW)).toBeNull();
    expect(formatConsentRefreshAge(undefined, NOW)).toBeNull();
    expect(formatConsentRefreshAge("not-a-date", NOW)).toBeNull();
  });

  it("renders sub-hour ages", () => {
    expect(formatConsentRefreshAge(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe(
      "less than an hour",
    );
  });

  it("renders hours under one day with correct pluralization", () => {
    expect(formatConsentRefreshAge(hoursAgo(1), NOW)).toBe("1 hour");
    expect(formatConsentRefreshAge(hoursAgo(5), NOW)).toBe("5 hours");
    expect(formatConsentRefreshAge(hoursAgo(23), NOW)).toBe("23 hours");
  });

  it("renders days for longer gaps with correct pluralization", () => {
    expect(formatConsentRefreshAge(daysAgo(1), NOW)).toBe("1 day");
    expect(formatConsentRefreshAge(daysAgo(5), NOW)).toBe("5 days");
    expect(formatConsentRefreshAge(daysAgo(30), NOW)).toBe("30 days");
  });
});
