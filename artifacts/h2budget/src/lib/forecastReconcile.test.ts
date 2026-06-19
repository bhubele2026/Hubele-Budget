import { describe, it, expect } from "vitest";
import { computeBankReconcile, type ReconcileInput } from "./forecastReconcile";
import type {
  BankLine,
  PlanLine,
  Transaction,
} from "./forecastMatch";

const txn = (overrides: Partial<Transaction> & { id: string }): Transaction => ({
  occurredOn: "2026-05-10",
  description: "txn",
  amount: "0",
  forecastFlag: true,
  source: "manual",
  ...overrides,
});

const bankLine = (overrides: {
  id: string;
  date: string;
  amount: number;
  status?: BankLine["status"];
}): BankLine => ({
  kind: "bank",
  date: overrides.date,
  amount: overrides.amount,
  status: overrides.status ?? "matched",
  txn: txn({
    id: overrides.id,
    occurredOn: overrides.date,
    amount: String(overrides.amount),
  }),
});

const planLine = (overrides: {
  itemId: string;
  date: string;
  amount: number;
  label?: string;
  status?: PlanLine["status"];
  matchedTxnId?: string | null;
}): PlanLine => ({
  kind: "plan",
  date: overrides.date,
  itemId: overrides.itemId,
  label: overrides.label ?? overrides.itemId,
  amount: overrides.amount,
  status: overrides.status ?? "future",
  matchedTxnId: overrides.matchedTxnId ?? null,
});

const baseInput = (
  overrides: Partial<ReconcileInput> = {},
): ReconcileInput => ({
  allBank: [],
  allPlan: [],
  bankSnapshot: { at: "2026-05-15T12:00:00.000Z", balance: 1000 },
  settingsStartingBalance: 1000,
  fromDate: "2026-05-01",
  monthFilter: "2026-05",
  checkingPlaidAccountIds: new Set<string>(),
  ...overrides,
});

describe("computeBankReconcile", () => {
  it("clean reconciliation: no contributors, gap is zero, isReconciled-friendly", () => {
    // Settings start = bank snapshot. No matched plans, no unplanned bank
    // activity prior to the snapshot. The like-for-like projection equals
    // the snapshot exactly.
    const result = computeBankReconcile(baseInput());
    expect(result.gap).toBe(0);
    expect(result.contributors).toEqual([]);
    expect(result.largestContributor).toBeNull();
    expect(result.matchedAmountDelta).toBe(0);
    expect(result.startingBalanceDelta).toBe(0);
    expect(result.hasBank).toBe(true);
    expect(result.isPriorMonth).toBe(false);
    expect(result.bankEnd).toBe(1000);
  });

  it("counts pending / matched / unplanned bank rows in the selected month", () => {
    const result = computeBankReconcile(
      baseInput({
        allBank: [
          bankLine({ id: "p1", date: "2026-05-03", amount: -10, status: "pending_bank" }),
          bankLine({ id: "p2", date: "2026-05-04", amount: -20, status: "pending_bank" }),
          bankLine({ id: "m1", date: "2026-05-05", amount: -30, status: "matched" }),
          bankLine({ id: "u1", date: "2026-05-06", amount: -40, status: "ignored_unforecasted" }),
          // Out-of-month — should not count.
          bankLine({ id: "x1", date: "2026-04-30", amount: -50, status: "matched" }),
        ],
      }),
    );
    expect(result.pending).toBe(2);
    expect(result.matched).toBe(1);
    expect(result.unplanned).toBe(1);
    expect(result.total).toBe(4);
  });

  it("matched-amount drift: plan amount differs from matched bank txn", () => {
    // Plan said -100, bank cleared at -120 → plan - bank = 20 drift.
    const bank = bankLine({
      id: "b1",
      date: "2026-05-05",
      amount: -120,
      status: "matched",
    });
    const plan = planLine({
      itemId: "rent",
      date: "2026-05-05",
      amount: -100,
      label: "Rent",
      status: "matched",
      matchedTxnId: "b1",
    });
    const result = computeBankReconcile(
      baseInput({
        allBank: [bank],
        allPlan: [plan],
        // Settings start matches the snapshot so we isolate matched drift.
        settingsStartingBalance: 1000,
        // Snapshot must reflect what bank actually shows: 1000 + (-120) = 880.
        bankSnapshot: { at: "2026-05-15T00:00:00.000Z", balance: 880 },
      }),
    );
    expect(result.matchedAmountDelta).toBe(20);
    expect(result.startingBalanceDelta).toBe(0);
    expect(result.gap).toBe(20);
    expect(result.contributors).toHaveLength(1);
    expect(result.contributors[0]?.kind).toBe("matched");
    expect(result.largestContributor?.kind).toBe("matched");
  });

  it("starting-balance drift: residual after matched-amount accounting", () => {
    // No matched plans; settings start says 1000 but bank snapshot says
    // 950 → residual is 50 (forecastAtSnapshot − bankAtSnapshot).
    const result = computeBankReconcile(
      baseInput({
        settingsStartingBalance: 1000,
        bankSnapshot: { at: "2026-05-15T00:00:00.000Z", balance: 950 },
      }),
    );
    expect(result.matchedAmountDelta).toBe(0);
    expect(result.startingBalanceDelta).toBe(50);
    expect(result.gap).toBe(50);
    expect(result.contributors).toHaveLength(1);
    expect(result.contributors[0]?.kind).toBe("starting");
  });

  it("combined: matched drift + starting drift, sorted by magnitude, gap is Σ|delta|", () => {
    // Plan -100 vs bank -120 ⇒ matched delta +20.
    // Settings start 1000, but if matched drift were 0 the snapshot should
    // be 1000 + (-120) = 880. We set snapshot to 830 ⇒ extra 50 starting
    // drift on top of the matched drift. rawGap = 70, matched = 20,
    // starting = 50. Σ|delta| gap = 70.
    const bank = bankLine({
      id: "b1",
      date: "2026-05-05",
      amount: -120,
      status: "matched",
    });
    const plan = planLine({
      itemId: "rent",
      date: "2026-05-05",
      amount: -100,
      label: "Rent",
      status: "matched",
      matchedTxnId: "b1",
    });
    const result = computeBankReconcile(
      baseInput({
        allBank: [bank],
        allPlan: [plan],
        settingsStartingBalance: 1000,
        bankSnapshot: { at: "2026-05-15T00:00:00.000Z", balance: 830 },
      }),
    );
    expect(result.matchedAmountDelta).toBe(20);
    expect(result.startingBalanceDelta).toBe(50);
    expect(result.gap).toBe(70);
    expect(result.contributors).toHaveLength(2);
    // Sorted by |delta| desc: starting (50) before matched (20).
    expect(result.contributors[0]?.kind).toBe("starting");
    expect(result.contributors[1]?.kind).toBe("matched");
    expect(result.largestContributor?.kind).toBe("starting");
  });

  it("opposite-signed contributors do NOT cancel — gap is Σ|delta|", () => {
    // Two matched plans whose drifts point opposite directions. Signed
    // sum would be ~0; the canonical gap must still flag both rows.
    const bA = bankLine({ id: "ba", date: "2026-05-03", amount: -120, status: "matched" });
    const bB = bankLine({ id: "bb", date: "2026-05-04", amount: -80, status: "matched" });
    const pA = planLine({
      itemId: "a", date: "2026-05-03", amount: -100, label: "A",
      status: "matched", matchedTxnId: "ba",
    });
    const pB = planLine({
      itemId: "b", date: "2026-05-04", amount: -100, label: "B",
      status: "matched", matchedTxnId: "bb",
    });
    // Snapshot reflects actual cleared bank: 1000 + (-120) + (-80) = 800.
    const result = computeBankReconcile(
      baseInput({
        allBank: [bA, bB],
        allPlan: [pA, pB],
        settingsStartingBalance: 1000,
        bankSnapshot: { at: "2026-05-15T00:00:00.000Z", balance: 800 },
      }),
    );
    // Plan-A drift = -100 - (-120) = +20; Plan-B drift = -100 - (-80) = -20.
    expect(result.matchedAmountDelta).toBe(0);
    expect(result.startingBalanceDelta).toBe(0);
    expect(result.gap).toBe(40);
    expect(result.contributors).toHaveLength(2);
  });

  it("ignores unfunded projected plan items: large pending/future plans in window do NOT create a starting-balance contributor", () => {
    // Repro of the bug: inbox is clear (no matched-amount drift), the
    // settings starting balance equals the bank snapshot exactly, and
    // there are big projected plan items in the (fromDate, snapshotDate]
    // window that haven't cleared the bank yet. The old code folded
    // those plan amounts into the snapshot-side projection, then dumped
    // the residual into "starting balance off". The corrected identity
    // is purely bank-side, so projected plans must not move the gap.
    const result = computeBankReconcile(
      baseInput({
        allPlan: [
          // Big future plan dated in window — has not hit the bank.
          planLine({ itemId: "p1", date: "2026-05-10", amount: -7518.54, status: "future" }),
          // Pending plan in window — also not yet at the bank.
          planLine({ itemId: "p2", date: "2026-05-12", amount: -250, status: "pending_plan" }),
          // Plan after the snapshot — irrelevant either way.
          planLine({ itemId: "p3", date: "2026-05-20", amount: -100, status: "future" }),
        ],
        settingsStartingBalance: 1000,
        bankSnapshot: { at: "2026-05-15T00:00:00.000Z", balance: 1000 },
      }),
    );
    expect(result.gap).toBe(0);
    expect(result.contributors).toEqual([]);
    expect(result.largestContributor).toBeNull();
    expect(result.startingBalanceDelta).toBe(0);
    expect(result.matchedAmountDelta).toBe(0);
  });

  it("isPriorMonth shorts forecastEnd to the snapshot start balance", () => {
    const result = computeBankReconcile(
      baseInput({
        monthFilter: "2026-04",
        bankSnapshot: { at: "2026-05-15T00:00:00.000Z", balance: 1234 },
      }),
    );
    expect(result.isPriorMonth).toBe(true);
    // forecastEnd is set to startBal (snapshot balance) without projecting.
    expect(result.forecastEnd).toBe(1234);
  });

  it("forecastEnd projects unresolved planned items past the snapshot through end of month", () => {
    // Two plan items after the snapshot: one pending (counted) and one
    // already matched (excluded — it's in the snapshot already).
    const result = computeBankReconcile(
      baseInput({
        allPlan: [
          planLine({ itemId: "p1", date: "2026-05-20", amount: -50, status: "pending_plan" }),
          planLine({ itemId: "p2", date: "2026-05-25", amount: -75, status: "matched", matchedTxnId: "x" }),
          planLine({ itemId: "p3", date: "2026-06-02", amount: -999, status: "future" }),
        ],
        bankSnapshot: { at: "2026-05-15T00:00:00.000Z", balance: 1000 },
      }),
    );
    expect(result.forecastEnd).toBe(950);
  });

  it("partial match leaves a residual: bank cleared LESS than the planned bill ⇒ non-zero gap, does not reconcile-to-zero", () => {
    // A planned bill of -100 the user matched to a bank txn that only
    // cleared -60 (e.g. a partial payment, or matched the wrong/smaller
    // charge). The planned bill is NOT fully satisfied: the reconcile gap
    // must surface the -40 residual and refuse to read as a clean
    // (gap === 0) reconcile. This is the inverse of the existing
    // overshoot ("matched-amount drift") case and the key guard that
    // reconcile-to-zero only fires at EXACTLY zero.
    const bank = bankLine({
      id: "b1",
      date: "2026-05-05",
      amount: -60,
      status: "matched",
    });
    const plan = planLine({
      itemId: "rent",
      date: "2026-05-05",
      amount: -100,
      label: "Rent",
      status: "matched",
      matchedTxnId: "b1",
    });
    const result = computeBankReconcile(
      baseInput({
        allBank: [bank],
        allPlan: [plan],
        settingsStartingBalance: 1000,
        // Bank actually shows 1000 + (-60) = 940 so the ONLY drift is the
        // matched-amount residual, isolating the partial-match signal.
        bankSnapshot: { at: "2026-05-15T00:00:00.000Z", balance: 940 },
      }),
    );
    // plan(-100) - bank(-60) = -40 residual.
    expect(result.matchedAmountDelta).toBe(-40);
    expect(result.startingBalanceDelta).toBe(0);
    expect(result.gap).toBe(40);
    expect(result.gap).not.toBe(0); // must NOT reconcile-to-zero
    expect(result.contributors).toHaveLength(1);
    expect(result.contributors[0]?.kind).toBe("matched");
    expect(result.largestContributor?.kind).toBe("matched");
  });

  it("reconcile-to-zero only fires at EXACTLY zero: a sub-0.01 residual collapses to a clean gap", () => {
    // A penny-rounding residual below the 0.01 reporting threshold must
    // collapse to gap === 0 (clean reconcile) and contribute no row —
    // the boundary that keeps floating-point dust from blocking a clean
    // month while a real partial residual (prior test) still surfaces.
    const bank = bankLine({
      id: "b1",
      date: "2026-05-05",
      amount: -100.004,
      status: "matched",
    });
    const plan = planLine({
      itemId: "rent",
      date: "2026-05-05",
      amount: -100,
      label: "Rent",
      status: "matched",
      matchedTxnId: "b1",
    });
    const result = computeBankReconcile(
      baseInput({
        allBank: [bank],
        allPlan: [plan],
        settingsStartingBalance: 1000,
        // 1000 + (-100.004) rounds to 899.996 → 900.00 at 2dp.
        bankSnapshot: { at: "2026-05-15T00:00:00.000Z", balance: 900 },
      }),
    );
    expect(result.gap).toBe(0);
    expect(result.contributors).toEqual([]);
    expect(result.largestContributor).toBeNull();
  });
});
