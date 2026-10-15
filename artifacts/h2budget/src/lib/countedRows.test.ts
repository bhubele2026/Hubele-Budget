import { describe, expect, it } from "vitest";
import { countedRows, countedSpendRows, isCounted, isCountedSpend } from "./countedRows";
import { bucketSpendInWindow } from "./bucketSpend";
import { actualMonthFlow } from "./billsActual";
import { asksForAnswer, filterForecastTxns } from "./forecastMatch";

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


// ⭐ (F6 round 5, review finding 3) A hold the bank snapshot held and its reversal
// arrive `expiredHold: false, expiredPair: true`: on the ledger (cash walks and
// cash flows count both, net 0 — as the register and the Banking review's money
// in / out do) but no spending, and never asked about.
describe("isCountedSpend — a held pair is cash, not spending", () => {
  it("expiredPair counts in cash (`isCounted`) but not as spending; an expired hold counts in neither", () => {
    expect(isCounted({ expiredHold: false, expiredPair: true })).toBe(true);
    expect(isCountedSpend({ expiredHold: false, expiredPair: true })).toBe(false);
    expect(isCountedSpend({ expiredHold: true })).toBe(false);
    expect(isCountedSpend({ expiredHold: false, expiredPair: false })).toBe(true);
    expect(isCountedSpend({})).toBe(true);
    const a = { id: "a" };
    const pair = { id: "p", expiredPair: true };
    expect(countedSpendRows([a, pair])).toEqual([a]);
  });

  it("a cash flow counts the held pair (net 0); the bucket helper (spending) leaves it out", () => {
    const rows = [
      { occurredOn: "2026-10-01", amount: "-80.00", weeklyAllowance: true, expiredPair: true },
      { occurredOn: "2026-10-08", amount: "80.00", expiredPair: true },
      { occurredOn: "2026-10-06", amount: "-45.00", weeklyAllowance: true },
    ];
    expect(actualMonthFlow(rows, "2026-10-01", "2026-11-01")).toEqual({ income: 80, spend: 125, net: -45 });
    expect(bucketSpendInWindow(rows, "weekly", "2026-09-27", "2026-10-10")).toBe(45);
  });

  it("the Reconcile inbox never asks about a held pair; its running balance walks it (`filterForecastTxns`)", () => {
    const txn = { forecastFlag: true, source: "plaid:lakeside", plaidAccountId: "chk", occurredOn: "2026-10-01", expiredHold: false, expiredPair: true };
    expect(filterForecastTxns([txn], new Set(["chk"]), "2026-10-15")).toEqual([txn]);
    expect(asksForAnswer(txn)).toBe(false);
    expect(asksForAnswer({ expiredHold: false, expiredPair: false })).toBe(true);
  });
});
