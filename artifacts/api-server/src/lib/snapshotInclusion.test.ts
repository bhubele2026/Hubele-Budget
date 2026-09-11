import { describe, expect, it } from "vitest";
import { isInSnapshot, PLAID_HELD_AHEAD_DAYS } from "@workspace/avalanche-core";

/**
 * The one rule for "the bank snapshot already holds this row" (PR4b).
 * Snapshot read at 10:00 America/Chicago on 2026-05-01 (15:00Z) unless noted.
 */
const SNAP_AT = new Date("2026-05-01T15:00:00Z");
const SNAP_DAY = "2026-05-01";
const BEFORE = new Date("2026-05-01T14:00:00Z"); // 09:00 CT
const AFTER = new Date("2026-05-01T19:00:00Z"); // 14:00 CT

const plaid = (occurredOn: string, createdAt: Date) => ({ occurredOn, createdAt, plaidAccountId: "chase-1" });
const manual = (occurredOn: string, createdAt: Date) => ({ occurredOn, createdAt, plaidAccountId: null });

describe("isInSnapshot", () => {
  it("holds a row dated before the snapshot day, whenever it arrived", () => {
    expect(isInSnapshot(plaid("2026-04-30", AFTER), SNAP_AT, SNAP_DAY)).toBe(true);
    expect(isInSnapshot(manual("2026-04-30", AFTER), SNAP_AT, SNAP_DAY)).toBe(true);
  });

  it("holds a snapshot-day row that arrived before or at the read, and counts one that arrived after", () => {
    expect(isInSnapshot(plaid(SNAP_DAY, BEFORE), SNAP_AT, SNAP_DAY)).toBe(true);
    expect(isInSnapshot(plaid(SNAP_DAY, SNAP_AT), SNAP_AT, SNAP_DAY)).toBe(true);
    expect(isInSnapshot(plaid(SNAP_DAY, AFTER), SNAP_AT, SNAP_DAY)).toBe(false);
    expect(isInSnapshot(manual(SNAP_DAY, AFTER), SNAP_AT, SNAP_DAY)).toBe(false);
    expect(isInSnapshot(manual(SNAP_DAY, BEFORE), SNAP_AT, SNAP_DAY)).toBe(true);
  });

  it("holds a Plaid row dated up to five days ahead that already existed at the read", () => {
    expect(PLAID_HELD_AHEAD_DAYS).toBe(5);
    expect(isInSnapshot(plaid("2026-05-03", BEFORE), SNAP_AT, SNAP_DAY)).toBe(true);
    expect(isInSnapshot(plaid("2026-05-06", BEFORE), SNAP_AT, SNAP_DAY)).toBe(true);
    expect(isInSnapshot(plaid("2026-05-03", AFTER), SNAP_AT, SNAP_DAY)).toBe(false);
  });

  it("counts a Plaid row dated six or more days ahead, even if it existed at the read", () => {
    expect(isInSnapshot(plaid("2026-05-07", BEFORE), SNAP_AT, SNAP_DAY)).toBe(false);
  });

  it("counts a manual row dated after the snapshot day, even if typed before the read", () => {
    expect(isInSnapshot(manual("2026-05-02", BEFORE), SNAP_AT, SNAP_DAY)).toBe(false);
  });

  it("uses household days: a 21:30 Chicago read on 09-10 is snapshot day 09-10", () => {
    const snapAt = new Date("2026-09-11T02:30:00Z"); // 21:30 CDT on 09-10
    const snapDay = "2026-09-10";
    // Dated 09-11 but already pending at 20:00 CT on 09-10: the balance holds it.
    expect(isInSnapshot(plaid("2026-09-11", new Date("2026-09-11T01:00:00Z")), snapAt, snapDay)).toBe(true);
    // Dated 09-10 and arriving at 21:45 CT, after the read: it counts.
    expect(isInSnapshot(plaid("2026-09-10", new Date("2026-09-11T02:45:00Z")), snapAt, snapDay)).toBe(false);
  });

  it("rolls the five-day window across a month end", () => {
    const snapAt = new Date("2026-05-29T15:00:00Z");
    const created = new Date("2026-05-29T14:00:00Z");
    expect(isInSnapshot(plaid("2026-06-03", created), snapAt, "2026-05-29")).toBe(true); // +5
    expect(isInSnapshot(plaid("2026-06-04", created), snapAt, "2026-05-29")).toBe(false); // +6
  });
});
