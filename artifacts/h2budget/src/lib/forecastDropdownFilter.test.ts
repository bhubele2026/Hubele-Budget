import { describe, it, expect } from "vitest";
import { filterDropdownPlans, type PlanLine } from "./forecastMatch";

function plan(
  itemId: string,
  date: string,
  opts: { matchedTxnId?: string | null } = {},
): PlanLine {
  return {
    kind: "plan",
    date,
    itemId,
    label: itemId,
    amount: -50,
    status: "pending_plan",
    matchedTxnId: opts.matchedTxnId ?? null,
  };
}

describe("filterDropdownPlans (#457)", () => {
  // Mid-month anchor so end-of-month (May 31) is later than today+21d
  // (Jun 1). Lets the same fixture cover the "include early next month"
  // and "exclude further out" cases.
  const today = new Date(2026, 4, 11); // May 11, 2026

  it("excludes plans dated before the first day of the current month", () => {
    const out = filterDropdownPlans([plan("rent-apr", "2026-04-30")], today);
    expect(out).toEqual([]);
  });

  it("includes plans dated within the current month", () => {
    const out = filterDropdownPlans([plan("netflix", "2026-05-20")], today);
    expect(out.map((p) => p.itemId)).toEqual(["netflix"]);
  });

  it("includes plans within 21 days of today even when in the next month", () => {
    // today = May 11, today+21d = Jun 1 → June 1 should be included.
    const out = filterDropdownPlans([plan("ps", "2026-06-01")], today);
    expect(out.map((p) => p.itemId)).toEqual(["ps"]);
  });

  it("excludes plans further out than max(end of month, today+21d)", () => {
    // max(May 31, Jun 1) = Jun 1, so Jun 2 is out.
    const out = filterDropdownPlans([plan("ps-jun2", "2026-06-02")], today);
    expect(out).toEqual([]);
  });

  it("excludes plans already matched to a bank transaction", () => {
    const out = filterDropdownPlans(
      [plan("electric", "2026-05-15", { matchedTxnId: "txn_123" })],
      today,
    );
    expect(out).toEqual([]);
  });

  it("uses end-of-month as the upper bound when it's later than today+21d", () => {
    // Anchor near start of month so May 31 > today+21d (May 22).
    const earlyMonth = new Date(2026, 4, 1); // May 1, 2026
    const out = filterDropdownPlans(
      [
        plan("late-may", "2026-05-31"),
        plan("early-jun", "2026-06-01"),
      ],
      earlyMonth,
    );
    expect(out.map((p) => p.itemId)).toEqual(["late-may"]);
  });
});
