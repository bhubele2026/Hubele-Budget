import { describe, expect, it } from "vitest";
import { householdDateOf } from "@workspace/avalanche-core/householdTime";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

/**
 * The fixture `created_at` helper must land on 00:00 America/Chicago of the
 * row's own date in both offsets, including the two days the clocks change.
 */
describe("createdAtStartOfHouseholdDay", () => {
  it("is 05:00Z on a daylight-time date (CDT, UTC-5)", () => {
    expect(createdAtStartOfHouseholdDay("2026-05-01").toISOString()).toBe("2026-05-01T05:00:00.000Z");
  });

  it("is 06:00Z on a standard-time date (CST, UTC-6)", () => {
    expect(createdAtStartOfHouseholdDay("2026-01-15").toISOString()).toBe("2026-01-15T06:00:00.000Z");
  });

  it("is still standard-time midnight on the day daylight time starts (2026-03-08)", () => {
    expect(createdAtStartOfHouseholdDay("2026-03-08").toISOString()).toBe("2026-03-08T06:00:00.000Z");
  });

  it("is still daylight-time midnight on the day daylight time ends (2026-11-01)", () => {
    expect(createdAtStartOfHouseholdDay("2026-11-01").toISOString()).toBe("2026-11-01T05:00:00.000Z");
  });

  it("is on the row's own household day, and one minute earlier is the day before", () => {
    for (const day of ["2026-05-14", "2026-09-10", "2026-10-04", "2026-12-31"]) {
      const t = createdAtStartOfHouseholdDay(day);
      expect(householdDateOf(t)).toBe(day);
      expect(householdDateOf(new Date(t.getTime() - 60_000))).not.toBe(day);
    }
  });
});
