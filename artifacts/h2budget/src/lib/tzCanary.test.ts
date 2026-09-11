import { describe, expect, it } from "vitest";

/**
 * The timezone canary.
 *
 * CI runs the web suite under TZ=UTC, America/Chicago, America/New_York and
 * America/Los_Angeles, so a date bug east or west of the household's calendar
 * fails a push. A mistyped zone (`TZ: America/Chicgo`) raises nothing: Node
 * resolves no zone, runs in UTC, and every date test passes, so the four-zone
 * guard would quietly become four UTC runs. This file fails instead.
 *
 * With TZ unset (a plain local run) the process uses the machine's zone, which
 * is neither known nor wrong, so there is nothing to check and the tests skip.
 */
const tz = process.env.TZ || undefined;

// January 15, 2026 at noon UTC: standard time in every CI zone, no DST edge.
const WINTER_INSTANT = new Date("2026-01-15T12:00:00Z");

/** Minutes behind UTC (`getTimezoneOffset`) at WINTER_INSTANT, per non-UTC CI zone. */
const CI_ZONE_WINTER_OFFSET: Record<string, number> = {
  "America/Chicago": 360,
  "America/New_York": 300,
  "America/Los_Angeles": 480,
};

describe("timezone canary: the suite runs in the zone CI asked for", () => {
  it.runIf(tz === "UTC")("TZ=UTC resolves to UTC, zero offset", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC");
    expect(WINTER_INSTANT.getTimezoneOffset()).toBe(0);
  });

  it.runIf(tz !== undefined && tz !== "UTC")(
    `TZ=${tz} resolves to that zone, not a silent UTC fallback`,
    () => {
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(tz);
    },
  );

  it.runIf(tz !== undefined && tz in CI_ZONE_WINTER_OFFSET)(
    `TZ=${tz} is offset from UTC`,
    () => {
      const offset = WINTER_INSTANT.getTimezoneOffset();
      expect(offset).not.toBe(0);
      expect(offset).toBe(CI_ZONE_WINTER_OFFSET[tz!]);
    },
  );
});
