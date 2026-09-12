import { describe, it, expect } from "vitest";
import {
  buildBucket,
  buildClientSuggestions,
  buildLineRegister,
  filterDropdownPlans,
  type CashSignalMatch,
  type Resolution,
  type Transaction,
} from "./forecastMatch";
import { computeBankReconcile } from "./forecastReconcile";
import { rowDecisionsByTxn } from "./forecastRowState";
import { applyResolutionWrite } from "./forecastResolutionCache";
import type { CashEvent } from "./forecast";

// (One-time bill move, owner decision 9) A $300 one-time bill matched to the
// −$300 row dated 9/19 was moved to 10/20, outside the matcher's window. The
// server stored `needs_review` (keeping the row id); a partial stores
// `needs_review_partial`. On the web both are unresolved on both sides — the
// plan is planned, the row is in Review — and the pair shows as needing review.

const TODAY = new Date(2026, 8, 19);
const base = {
  closedMonths: new Set<string>(),
  startBalance: 2000,
  fromISO: "2026-09-01",
  toISO: "2026-11-30",
  today: TODAY,
};

const roof: CashEvent = { itemId: "roof", date: "2026-10-20", label: "Roof repair", amount: -300 } as CashEvent;
const txn = (id: string, occurredOn: string, amount: string, description = "ROOF CO"): Transaction => ({
  id,
  occurredOn,
  description,
  amount,
  forecastFlag: true,
  source: "manual",
});
const res = (over: Partial<Resolution> & { id: string; status: string }): Resolution => ({
  recurringItemId: null,
  occurrenceDate: null,
  matchedTxnId: null,
  ...over,
});
const review = res({
  id: "rv",
  status: "needs_review",
  recurringItemId: "roof",
  occurrenceDate: "2026-10-20",
  matchedTxnId: "t1",
  txnDate: "2026-09-19",
  txnDescription: "ROOF CO",
  txnAmount: "-300.00",
});
const reviewPartial = { ...review, id: "rvp", status: "needs_review_partial", txnAmount: "-200.00" };
const matched = { ...review, id: "m", status: "matched" };

describe("register — a needs-review pair is unresolved and asks for an answer", () => {
  it("keeps the plan open with the pair to answer, and the row pending with it", () => {
    const { allPlan, allBank } = buildLineRegister({
      ...base,
      events: [roof],
      txns: [txn("t1", "2026-09-19", "-300.00")],
      resolutions: [review],
    });
    expect(allPlan[0]).toMatchObject({
      status: "future",
      amount: -300,
      resolutionId: undefined,
      matchedTxnId: null,
      probablyPaid: {
        needsReview: "match",
        offCurve: false,
        txnId: "t1",
        planDate: "2026-10-20",
        txnAmount: -300,
        difference: 0,
        dayDelta: -31,
        txnDate: "2026-09-19",
        txnDescription: "ROOF CO",
      },
    });
    expect(allBank[0]).toMatchObject({ status: "pending_bank", resolutionId: undefined, resolutionStatus: undefined });
    expect(allBank[0]!.suggestedPlan?.itemId).toBe("roof");
  });

  it("a partial that needs review keeps the WHOLE plan planned and says it was a partial", () => {
    const { allPlan, allBank } = buildLineRegister({
      ...base,
      events: [roof],
      txns: [txn("t1", "2026-09-19", "-200.00")],
      resolutions: [reviewPartial],
    });
    expect(allPlan[0]).toMatchObject({
      status: "future",
      amount: -300,
      probablyPaid: { needsReview: "partial", offCurve: false, txnAmount: -200, difference: -100 },
    });
    expect(allBank[0]).toMatchObject({ status: "pending_bank" });
  });

  it("a matched pair, by contrast, is decided on both sides", () => {
    const { allPlan, allBank } = buildLineRegister({
      ...base,
      events: [roof],
      txns: [txn("t1", "2026-09-19", "-300.00")],
      resolutions: [matched],
    });
    expect(allPlan[0]).toMatchObject({ status: "matched", matchedTxnId: "t1" });
    expect(allPlan[0]!.probablyPaid).toBeUndefined();
    expect(allBank[0]).toMatchObject({ status: "matched" });
  });

  it("uses the bundle's row fields when the row is outside the register window, and a due date past today stays pending", () => {
    const due: CashEvent = { ...roof, date: "2026-09-01" };
    const { allPlan } = buildLineRegister({
      ...base,
      events: [due],
      txns: [],
      resolutions: [{ ...review, occurrenceDate: "2026-09-01" }],
    });
    expect(allPlan[0]).toMatchObject({
      status: "pending_plan",
      probablyPaid: { needsReview: "match", txnId: "t1", txnAmount: -300, dayDelta: 18, txnDate: "2026-09-19" },
    });
  });

  it("a server suggestion for the same row or plan never replaces the pair", () => {
    const water: CashEvent = { itemId: "water", date: "2026-09-18", label: "Water", amount: -300 } as CashEvent;
    const serverPair: CashSignalMatch = {
      planKey: "water|2026-09-18",
      planItemId: "water",
      planDate: "2026-09-18",
      txnId: "t1",
      planAmount: "-300.00",
      txnAmount: "-300.00",
      difference: "0.00",
      dayDelta: 1,
      confidence: "low",
      ambiguous: false,
      offCurve: false,
    };
    const { allPlan, allBank } = buildLineRegister({
      ...base,
      events: [roof, water],
      txns: [txn("t1", "2026-09-19", "-300.00")],
      resolutions: [review],
      matches: [serverPair],
    });
    expect(allPlan.find((p) => p.itemId === "water")!.probablyPaid).toBeUndefined();
    expect(allBank[0]!.suggestedPlan?.itemId).toBe("roof");
  });

  it("offers no client suggestion for the row, keeps the plan in the manual dropdown, and writes no bucket row", () => {
    const { allPlan, allBank, rows } = buildLineRegister({
      ...base,
      events: [roof],
      txns: [txn("t1", "2026-09-19", "-300.00")],
      resolutions: [review],
    });
    expect(buildClientSuggestions(allBank, allPlan).get("t1")).toEqual([]);
    expect(filterDropdownPlans(allPlan, new Date(2026, 9, 1))).toHaveLength(1);
    expect(rows.some((r) => r.kind === "bank" && r.status === "pending_bank")).toBe(true);
    for (const month of ["2026-09", "2026-10"]) {
      expect(buildBucket({ allPlan, allBank, resolutions: [review, reviewPartial], closedMonths: new Set(), monthFilter: month })).toEqual([]);
    }
  });
});

describe("reconcile — the moved bill counts again, the row is pending", () => {
  const input = (resolutions: Resolution[], monthFilter: string) => {
    const { allPlan, allBank } = buildLineRegister({
      ...base,
      events: [roof],
      txns: [txn("t1", "2026-09-19", "-300.00")],
      resolutions,
    });
    return computeBankReconcile({
      allBank,
      allPlan,
      bankSnapshot: { at: "2026-09-19T15:00:00.000Z", balance: 2000 },
      settingsStartingBalance: 2000,
      fromDate: "2026-09-01",
      monthFilter,
      checkingPlaidAccountIds: new Set(),
    });
  };

  it("needs review: October ends at 1,700 and September has one pending row", () => {
    expect(input([review], "2026-10").forecastEnd).toBe(1700);
    expect(input([review], "2026-09")).toMatchObject({ pending: 1, matched: 0 });
    expect(input([reviewPartial], "2026-10").forecastEnd).toBe(1700);
  });

  it("matched: October ends at 2,000 and September's row is matched", () => {
    expect(input([matched], "2026-10").forecastEnd).toBe(2000);
    expect(input([matched], "2026-09")).toMatchObject({ pending: 0, matched: 1 });
  });
});

describe("row state and the cached bundle", () => {
  it("rowDecisionsByTxn: neither needs-review status is the row's decision", () => {
    expect(rowDecisionsByTxn([review]).has("t1")).toBe(false);
    expect(rowDecisionsByTxn([reviewPartial]).has("t1")).toBe(false);
    expect(rowDecisionsByTxn([matched]).get("t1")).toEqual({ status: "matched" });
  });

  it("applyResolutionWrite: Confirm, Partial and Not this on the pair replace it; a rejection of another pair or a move keeps it", () => {
    const answer = (status: string, txnId = "t1") =>
      res({ id: `new-${status}-${txnId}`, status, recurringItemId: "roof", occurrenceDate: "2026-10-20", matchedTxnId: txnId });
    for (const pending of [review, reviewPartial]) {
      expect(applyResolutionWrite([pending], answer("matched")).map((r) => r.status)).toEqual(["matched"]);
      expect(applyResolutionWrite([pending], answer("partial")).map((r) => r.status)).toEqual(["partial"]);
      expect(applyResolutionWrite([pending], answer("not_match")).map((r) => r.status)).toEqual(["not_match"]);
      expect(applyResolutionWrite([pending], answer("not_match", "t9")).map((r) => r.status).sort()).toEqual(
        [pending.status, "not_match"].sort(),
      );
      const move = res({ id: "mv", status: "rescheduled", recurringItemId: "roof", occurrenceDate: "2026-10-20", rescheduledTo: "2026-10-22" });
      expect(applyResolutionWrite([pending], move).map((r) => r.status).sort()).toEqual([pending.status, "rescheduled"].sort());
    }
  });
});
