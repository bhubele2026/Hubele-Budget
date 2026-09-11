import { describe, expect, it } from "vitest";
import { isInSnapshot, PLAID_HELD_AHEAD_DAYS } from "@workspace/avalanche-core";

/**
 * The one rule for "the bank snapshot already holds this row" (PR4b).
 * Balance read at 10:00 America/Chicago on 2026-05-01 (15:00Z) unless noted.
 */
const SNAP_AT = new Date("2026-05-01T15:00:00Z");
const SNAP_DAY = "2026-05-01";
const BEFORE = new Date("2026-05-01T14:00:00Z"); // 09:00 CT
const AFTER = new Date("2026-05-01T19:00:00Z"); // 14:00 CT
const TIME_BEFORE = new Date("2026-05-01T13:12:34Z"); // 08:12 CT, a real time
const TIME_AFTER = new Date("2026-05-01T19:07:12Z"); // 14:07 CT, a real time

type Opts = { amount?: number; createdAt?: Date; occurredAt?: Date | null; plaid?: boolean };
const row = (occurredOn: string, o: Opts = {}) => ({
  occurredOn,
  amount: o.amount ?? -40,
  createdAt: o.createdAt ?? BEFORE,
  occurredAt: o.occurredAt ?? null,
  plaidAccountId: o.plaid === false ? null : "chase-1",
});
const held = (r: ReturnType<typeof row>, snapAt = SNAP_AT, snapDay = SNAP_DAY) => isInSnapshot(r, snapAt, snapDay);

describe("isInSnapshot — before and on the snapshot day", () => {
  it("holds a row dated before the snapshot day, whenever it arrived or happened", () => {
    expect(held(row("2026-04-30", { createdAt: AFTER, occurredAt: TIME_AFTER }))).toBe(true);
    expect(held(row("2026-04-30", { plaid: false }))).toBe(true);
  });

  it("holds a snapshot-day row with no transaction time, even if it arrived after the read (feed latency)", () => {
    expect(held(row(SNAP_DAY, { createdAt: BEFORE }))).toBe(true);
    expect(held(row(SNAP_DAY, { createdAt: AFTER }))).toBe(true);
    expect(held(row(SNAP_DAY, { createdAt: AFTER, plaid: false }))).toBe(true);
  });

  it("holds a snapshot-day row whose own time is before the read", () => {
    expect(held(row(SNAP_DAY, { createdAt: AFTER, occurredAt: TIME_BEFORE }))).toBe(true);
  });

  it("counts a snapshot-day charge or deposit whose own time is after the read", () => {
    expect(held(row(SNAP_DAY, { createdAt: AFTER, occurredAt: TIME_AFTER }))).toBe(false);
    expect(held(row(SNAP_DAY, { amount: 2000, createdAt: AFTER, occurredAt: TIME_AFTER }))).toBe(false);
  });

  it("holds a snapshot-day row the ledger had at the read, even with a later time (a re-keyed pending row takes the posting time)", () => {
    expect(held(row(SNAP_DAY, { createdAt: BEFORE, occurredAt: TIME_AFTER }))).toBe(true);
    expect(held(row(SNAP_DAY, { amount: 2000, createdAt: BEFORE, occurredAt: TIME_AFTER }))).toBe(true);
  });

  it("treats a whole-hour or unparsable time as a placeholder, not evidence", () => {
    expect(held(row(SNAP_DAY, { createdAt: AFTER, occurredAt: new Date("2026-05-01T20:00:00Z") }))).toBe(true);
    expect(held(row(SNAP_DAY, { createdAt: AFTER, occurredAt: new Date("not a date") }))).toBe(true);
  });
});

describe("isInSnapshot — Plaid charges dated ahead of the snapshot day", () => {
  it("holds a charge dated up to five days ahead that the ledger already had at the read", () => {
    expect(PLAID_HELD_AHEAD_DAYS).toBe(5);
    expect(held(row("2026-05-03", { createdAt: BEFORE }))).toBe(true);
    expect(held(row("2026-05-06", { createdAt: BEFORE }))).toBe(true);
  });

  it("holds a charge dated ahead that arrived later but happened before the read", () => {
    expect(held(row("2026-05-03", { createdAt: AFTER, occurredAt: TIME_BEFORE }))).toBe(true);
  });

  it("counts a charge dated ahead that arrived after the read with no earlier time", () => {
    expect(held(row("2026-05-03", { createdAt: AFTER }))).toBe(false);
  });

  it("counts a charge six or more days ahead, even if the ledger had it at the read", () => {
    expect(held(row("2026-05-07", { createdAt: BEFORE }))).toBe(false);
  });

  it("counts a pending DEPOSIT dated ahead that existed at the read: the available balance leaves it out", () => {
    expect(held(row("2026-05-02", { amount: 2000, createdAt: BEFORE }))).toBe(false);
  });

  it("counts a manual row dated after the snapshot day, even if typed before the read", () => {
    expect(held(row("2026-05-02", { createdAt: BEFORE, plaid: false }))).toBe(false);
  });
});

describe("isInSnapshot — household days", () => {
  it("a 21:30 Chicago read on 09-10 is snapshot day 09-10", () => {
    const snapAt = new Date("2026-09-11T02:30:00Z"); // 21:30 CDT on 09-10
    const snapDay = "2026-09-10";
    // A charge dated 09-11, already in the ledger at 20:00 CT on 09-10: held.
    expect(held(row("2026-09-11", { createdAt: new Date("2026-09-11T01:00:00Z") }), snapAt, snapDay)).toBe(true);
    // Dated 09-10 with a real time of 21:45 CT, after the read: counts.
    expect(
      held(row("2026-09-10", { createdAt: new Date("2026-09-11T02:50:00Z"), occurredAt: new Date("2026-09-11T02:45:31Z") }), snapAt, snapDay),
    ).toBe(false);
  });

  it("rolls the five-day window across a month end", () => {
    const snapAt = new Date("2026-05-29T15:00:00Z");
    const created = new Date("2026-05-29T14:00:00Z");
    expect(held(row("2026-06-03", { createdAt: created }), snapAt, "2026-05-29")).toBe(true); // +5
    expect(held(row("2026-06-04", { createdAt: created }), snapAt, "2026-05-29")).toBe(false); // +6
  });
});
