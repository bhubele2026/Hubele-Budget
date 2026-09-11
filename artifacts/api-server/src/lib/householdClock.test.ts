import { afterEach, describe, expect, it } from "vitest";
import {
  householdDayOf,
  householdMonthStartDate,
  householdTodayDate,
  householdTodayISO,
} from "./householdClock";

// The server's calendar is the household's (America/Chicago) whatever timezone
// the process runs in. Render is UTC; a laptop is Central. Both are covered.
const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  // Assigning undefined would set the literal string "undefined".
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const localISO = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

for (const tz of ["UTC", "America/Chicago"]) {
  describe(`server household clock with the process in ${tz}`, () => {
    it("Saturday 8:30pm Central is Saturday on the server, as a string and as a local Date", () => {
      process.env.TZ = tz;
      const now = new Date("2026-09-13T01:30:00Z");
      expect(householdTodayISO(now)).toBe("2026-09-12");
      const today = householdTodayDate(now);
      expect(localISO(today)).toBe("2026-09-12");
      expect(today.getDay()).toBe(6);
    });

    it("an evening bank snapshot keeps its own Central day", () => {
      process.env.TZ = tz;
      expect(householdDayOf("2026-09-11T02:30:00Z")).toBe("2026-09-10");
      expect(householdDayOf(new Date("2026-09-11T02:30:00Z"))).toBe("2026-09-10");
    });

    it("the last evening of a month still starts that month", () => {
      process.env.TZ = tz;
      expect(localISO(householdMonthStartDate(new Date("2026-10-01T02:00:00Z")))).toBe(
        "2026-09-01",
      );
    });
  });
}
