import { describe, expect, it } from "vitest";
import {
  householdDayOfAt,
  householdMonthStartOf,
  householdToday,
} from "./householdDay";

// The browser uses the household calendar (America/Chicago), the same one the
// server uses since PR2a. These instants sit in the 7pm–midnight Central window
// where the UTC date is already tomorrow — exactly where the old
// `toISOString().slice(0, 10)` pattern went wrong.

describe("householdDayOfAt", () => {
  it("returns a bare YYYY-MM-DD unchanged — it is already a day", () => {
    // Parsed as an instant it would be UTC midnight: 7pm the previous evening
    // in Chicago.
    expect(householdDayOfAt("2026-05-15")).toBe("2026-05-15");
  });

  it("keeps a 9:30pm Central bank snapshot on its own day", () => {
    expect(householdDayOfAt("2026-09-11T02:30:00.000Z")).toBe("2026-09-10");
  });

  it("gives the same day as UTC during the daytime", () => {
    expect(householdDayOfAt("2026-05-15T17:00:00.000Z")).toBe("2026-05-15");
  });

  it("falls back to the text's own date prefix on a malformed timestamp instead of throwing", () => {
    // Stored jsonb (a Chase snapshot `at`, a legacy Amex anchor) is untyped. An
    // Invalid Date would make Intl throw a RangeError in the middle of a render.
    expect(householdDayOfAt("")).toBe("");
    expect(householdDayOfAt("not-a-date")).toBe("not-a-date");
  });
});

describe("householdToday and householdMonthStartOf", () => {
  it("Saturday 8:30pm Central is still Saturday", () => {
    expect(householdToday(new Date("2026-09-13T01:30:00Z"))).toBe("2026-09-12");
  });

  it("the last evening of a month is still that month", () => {
    expect(householdMonthStartOf(new Date("2026-10-01T02:00:00Z"))).toBe("2026-09-01");
  });
});
