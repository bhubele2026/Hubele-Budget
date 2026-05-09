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
});
