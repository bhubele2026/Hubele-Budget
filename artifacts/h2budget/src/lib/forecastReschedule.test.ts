import { describe, it, expect } from "vitest";
import {
  buildBucket,
  buildLineRegister,
  shouldCelebrateClear,
  type Resolution,
  type Transaction,
} from "./forecastMatch";
import type { CashEvent } from "./forecast";

const baseOpts = {
  txns: [],
  closedMonths: new Set<string>(),
  startBalance: 1000,
  fromISO: "2026-05-01",
  toISO: "2026-08-31",
  today: new Date("2026-05-15"),
};

function ev(itemId: string, date: string, amount: number, label = "rent"): CashEvent {
  return { itemId, date, amount, label } as CashEvent;
}

describe("Forecast reschedule overrides", () => {
  it("moves an occurrence to the rescheduled date and keeps it pending/future", () => {
    const events = [ev("rec-1", "2026-05-20", -1200)];
    const resolutions: Resolution[] = [
      {
        id: "r1",
        recurringItemId: "rec-1",
        occurrenceDate: "2026-05-20",
        status: "rescheduled",
        matchedTxnId: null,
        rescheduledTo: "2026-06-05",
      },
    ];
    const { allPlan } = buildLineRegister({ ...baseOpts, events, resolutions });
    expect(allPlan).toHaveLength(1);
    expect(allPlan[0].date).toBe("2026-06-05");
    expect(allPlan[0].itemId).toBe("rec-1");
    // 2026-06-05 is after today (2026-05-15) → future
    expect(allPlan[0].status).toBe("future");
    // The resolutionId surfaced is the rescheduled marker so Undo can delete it.
    expect(allPlan[0].resolutionId).toBe("r1");
  });

  it("rescheduling to a past date relative to today still yields pending_plan", () => {
    const events = [ev("rec-2", "2026-05-20", -200)];
    const resolutions: Resolution[] = [
      {
        id: "r2",
        recurringItemId: "rec-2",
        occurrenceDate: "2026-05-20",
        status: "rescheduled",
        matchedTxnId: null,
        // The API rejects this; here we just verify the projector tolerates it
        rescheduledTo: "2026-05-10",
      },
    ];
    const { allPlan } = buildLineRegister({ ...baseOpts, events, resolutions });
    expect(allPlan[0].date).toBe("2026-05-10");
    expect(allPlan[0].status).toBe("pending_plan");
  });

  it("does not duplicate the occurrence when no events exist at the new date", () => {
    const events = [ev("rec-3", "2026-05-20", -500)];
    const resolutions: Resolution[] = [
      {
        id: "r3",
        recurringItemId: "rec-3",
        occurrenceDate: "2026-05-20",
        status: "rescheduled",
        matchedTxnId: null,
        rescheduledTo: "2026-06-20",
      },
    ];
    const { allPlan } = buildLineRegister({ ...baseOpts, events, resolutions });
    expect(allPlan).toHaveLength(1);
    expect(allPlan[0].date).toBe("2026-06-20");
  });

  it("preserves the original occurrence date so re-moves replace cleanly", () => {
    const events = [ev("rec-5", "2026-05-20", -300)];
    const resolutions: Resolution[] = [
      {
        id: "r5",
        recurringItemId: "rec-5",
        occurrenceDate: "2026-05-20",
        status: "rescheduled",
        matchedTxnId: null,
        rescheduledTo: "2026-06-05",
      },
    ];
    const { allPlan } = buildLineRegister({ ...baseOpts, events, resolutions });
    expect(allPlan[0].date).toBe("2026-06-05");
    expect(allPlan[0].originalDate).toBe("2026-05-20");
  });

  it("ignores rescheduledTo when status is not rescheduled", () => {
    const events = [ev("rec-4", "2026-05-20", -100)];
    const resolutions: Resolution[] = [
      {
        id: "r4",
        recurringItemId: "rec-4",
        occurrenceDate: "2026-05-20",
        status: "matched",
        matchedTxnId: "tx-1",
        rescheduledTo: "2026-06-20",
      },
    ];
    const { allPlan } = buildLineRegister({ ...baseOpts, events, resolutions });
    expect(allPlan[0].date).toBe("2026-05-20");
    expect(allPlan[0].status).toBe("matched");
  });
});

describe("shouldCelebrateClear (confetti gating)", () => {
  it("celebrates only when inbox empty AND reconciled to bank", () => {
    expect(
      shouldCelebrateClear({ inboxCount: 0, isReconciledToBank: true }),
    ).toBe(true);
  });

  it("does not celebrate when the inbox still has cards", () => {
    expect(
      shouldCelebrateClear({ inboxCount: 3, isReconciledToBank: true }),
    ).toBe(false);
  });

  it("does not celebrate when inbox is empty but balance is off", () => {
    expect(
      shouldCelebrateClear({ inboxCount: 0, isReconciledToBank: false }),
    ).toBe(false);
  });
});

describe("Missed bucket panel — buildBucket + Undo source rows", () => {
  it("returns missed plan rows for the selected month with their resolutionId", () => {
    const events = [ev("rec-9", "2026-05-10", -75, "internet")];
    const resolutions: Resolution[] = [
      {
        id: "miss-1",
        recurringItemId: "rec-9",
        occurrenceDate: "2026-05-10",
        status: "missed",
        matchedTxnId: null,
      },
    ];
    const register = buildLineRegister({
      ...baseOpts,
      events,
      resolutions,
    });
    const bucket = buildBucket({
      allPlan: register.allPlan,
      allBank: register.allBank,
      resolutions,
      closedMonths: new Set<string>(),
      monthFilter: "2026-05",
    });
    const missed = bucket.filter((b) => b.status === "missed");
    expect(missed).toHaveLength(1);
    expect(missed[0].id).toBe("miss-1");
    expect(missed[0].label).toBe("internet");
    expect(missed[0].date).toBe("2026-05-10");
  });

  it("scopes the missed bucket to the selected month and excludes other months", () => {
    const events = [
      ev("rec-a", "2026-05-10", -50),
      ev("rec-b", "2026-06-15", -90),
    ];
    const resolutions: Resolution[] = [
      {
        id: "miss-may",
        recurringItemId: "rec-a",
        occurrenceDate: "2026-05-10",
        status: "missed",
        matchedTxnId: null,
      },
      {
        id: "miss-jun",
        recurringItemId: "rec-b",
        occurrenceDate: "2026-06-15",
        status: "missed",
        matchedTxnId: null,
      },
    ];
    const register = buildLineRegister({
      ...baseOpts,
      events,
      resolutions,
    });
    const may = buildBucket({
      allPlan: register.allPlan,
      allBank: register.allBank,
      resolutions,
      closedMonths: new Set<string>(),
      monthFilter: "2026-05",
    }).filter((b) => b.status === "missed");
    expect(may.map((m) => m.id)).toEqual(["miss-may"]);
  });
});

describe("Moved-from bucket panel — buildBucket emits rescheduled rows", () => {
  it("returns rescheduled overrides keyed by the ORIGINAL occurrence month", () => {
    const events = [ev("rec-mv", "2026-05-20", -1200, "rent")];
    const resolutions: Resolution[] = [
      {
        id: "mv-1",
        recurringItemId: "rec-mv",
        occurrenceDate: "2026-05-20",
        status: "rescheduled",
        matchedTxnId: null,
        rescheduledTo: "2026-06-05",
      },
    ];
    const register = buildLineRegister({ ...baseOpts, events, resolutions });
    const may = buildBucket({
      allPlan: register.allPlan,
      allBank: register.allBank,
      resolutions,
      closedMonths: new Set<string>(),
      monthFilter: "2026-05",
    }).filter((b) => b.status === "rescheduled");
    expect(may).toHaveLength(1);
    expect(may[0].id).toBe("mv-1");
    expect(may[0].label).toBe("rent");
    expect(may[0].amount).toBe(-1200);
    expect(may[0].date).toBe("2026-05-20");
    expect(may[0].rescheduledTo).toBe("2026-06-05");
  });

  it("does NOT show the moved row in the destination month's bucket", () => {
    const events = [ev("rec-mv2", "2026-05-20", -300, "internet")];
    const resolutions: Resolution[] = [
      {
        id: "mv-2",
        recurringItemId: "rec-mv2",
        occurrenceDate: "2026-05-20",
        status: "rescheduled",
        matchedTxnId: null,
        rescheduledTo: "2026-06-05",
      },
    ];
    const register = buildLineRegister({ ...baseOpts, events, resolutions });
    const jun = buildBucket({
      allPlan: register.allPlan,
      allBank: register.allBank,
      resolutions,
      closedMonths: new Set<string>(),
      monthFilter: "2026-06",
    }).filter((b) => b.status === "rescheduled");
    expect(jun).toHaveLength(0);
  });

  it("falls back to empty label/zero amount when the original event is outside the loaded window", () => {
    // No events loaded → planByOriginalKey can't recover the label, but the
    // bucket still emits the row so the user can Undo.
    const resolutions: Resolution[] = [
      {
        id: "mv-orphan",
        recurringItemId: "rec-gone",
        occurrenceDate: "2026-05-15",
        status: "rescheduled",
        matchedTxnId: null,
        rescheduledTo: "2026-06-15",
      },
    ];
    const register = buildLineRegister({
      ...baseOpts,
      events: [],
      resolutions,
    });
    const may = buildBucket({
      allPlan: register.allPlan,
      allBank: register.allBank,
      resolutions,
      closedMonths: new Set<string>(),
      monthFilter: "2026-05",
    }).filter((b) => b.status === "rescheduled");
    expect(may).toHaveLength(1);
    expect(may[0].id).toBe("mv-orphan");
    expect(may[0].label).toBe("");
    expect(may[0].amount).toBe(0);
    expect(may[0].rescheduledTo).toBe("2026-06-15");
  });

  it("hides the moved row when the original month is closed", () => {
    const events = [ev("rec-mv3", "2026-05-20", -75, "phone")];
    const resolutions: Resolution[] = [
      {
        id: "mv-3",
        recurringItemId: "rec-mv3",
        occurrenceDate: "2026-05-20",
        status: "rescheduled",
        matchedTxnId: null,
        rescheduledTo: "2026-06-05",
      },
    ];
    const register = buildLineRegister({ ...baseOpts, events, resolutions });
    const may = buildBucket({
      allPlan: register.allPlan,
      allBank: register.allBank,
      resolutions,
      closedMonths: new Set<string>(["2026-05"]),
      monthFilter: "2026-05",
    });
    expect(may).toEqual([]);
  });

  it("ignores rescheduled rows missing rescheduledTo / occurrenceDate / itemId", () => {
    const resolutions: Resolution[] = [
      {
        id: "mv-bad-1",
        recurringItemId: null,
        occurrenceDate: "2026-05-20",
        status: "rescheduled",
        matchedTxnId: null,
        rescheduledTo: "2026-06-05",
      },
      {
        id: "mv-bad-2",
        recurringItemId: "rec-x",
        occurrenceDate: null,
        status: "rescheduled",
        matchedTxnId: null,
        rescheduledTo: "2026-06-05",
      },
      {
        id: "mv-bad-3",
        recurringItemId: "rec-x",
        occurrenceDate: "2026-05-20",
        status: "rescheduled",
        matchedTxnId: null,
        rescheduledTo: null,
      },
    ];
    const register = buildLineRegister({
      ...baseOpts,
      events: [],
      resolutions,
    });
    const bucket = buildBucket({
      allPlan: register.allPlan,
      allBank: register.allBank,
      resolutions,
      closedMonths: new Set<string>(),
      monthFilter: "2026-05",
    });
    expect(bucket.filter((b) => b.status === "rescheduled")).toEqual([]);
  });
});

describe("Reschedule → match suppresses the original event exactly once", () => {
  function bankTxn(id: string, date: string, amount: string): Transaction {
    return {
      id,
      occurredOn: date,
      description: `tx-${id}`,
      amount,
      forecastFlag: true,
      plaidAccountId: "chase-acct",
    };
  }

  it("after a reschedule is matched at the original key, the plan row resolves to matched and is not double-counted", () => {
    // Simulates the post-API state: the rescheduled resolution is
    // replaced (not duplicated) by the matched resolution at the
    // original occurrence key, because the match upsert keys off
    // PlanLine.originalDate.
    const events = [ev("rec-7", "2026-05-20", -300, "rent")];
    const txns = [bankTxn("tx-rent", "2026-06-05", "-300.00")];
    const resolutions: Resolution[] = [
      {
        id: "match-rent",
        recurringItemId: "rec-7",
        occurrenceDate: "2026-05-20",
        status: "matched",
        matchedTxnId: "tx-rent",
      },
    ];
    const { allPlan, allBank } = buildLineRegister({
      ...baseOpts,
      events,
      txns,
      resolutions,
    });
    expect(allPlan).toHaveLength(1);
    expect(allPlan[0].status).toBe("matched");
    expect(allPlan[0].matchedTxnId).toBe("tx-rent");
    expect(allBank[0].status).toBe("matched");
  });
});
