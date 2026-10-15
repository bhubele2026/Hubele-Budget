import { describe, expect, it } from "vitest";
import { countedRows, isCounted } from "./countedRows";
import { bucketSpendInWindow } from "./bucketSpend";

// (F6 round 4) The one browser test every sum asks: does the server's list row count?
describe("isCounted — an expired hold counts nowhere; every other row counts", () => {
  it("only `expiredHold: true` is left out; absent, false and null count (older responses, manual rows)", () => {
    expect(isCounted({ expiredHold: true })).toBe(false);
    expect(isCounted({ expiredHold: false })).toBe(true);
    expect(isCounted({ expiredHold: null })).toBe(true);
    expect(isCounted({})).toBe(true);
  });
  it("countedRows keeps the order and the very same row objects", () => {
    const a = { id: "a" };
    const b = { id: "b", expiredHold: true };
    const c = { id: "c", expiredHold: false };
    const out = countedRows([a, b, c]);
    expect(out).toEqual([a, c]);
    expect(out[0]).toBe(a);
  });
});

describe("the bucket helper (one source for bucket spend) skips an expired hold too", () => {
  it("weekly: a real −30 counts; an expired −500 beside it does not", () => {
    const rows = [
      { occurredOn: "2026-05-05", amount: "-500.00", weeklyAllowance: true, expiredHold: true },
      { occurredOn: "2026-05-06", amount: "-30.00", weeklyAllowance: true },
    ];
    expect(bucketSpendInWindow(rows, "weekly", "2026-05-03", "2026-05-09")).toBe(30);
  });
});

