import { describe, it, expect } from "vitest";
import { hookPayoffsOf, hookPayoffWords } from "./forecastHooks";

// (WP8) The register's words for an everyday hook: display only.
const signal = {
  hookAmountIgnored: [{ itemId: "ws", cadence: "weekly" as const, storedAmount: "450.00" }],
  events: [
    { date: "2026-10-10", label: "Weekly Spend", amount: "-477.57", itemId: "ws", occurrenceKey: "ws|2026-10-10" },
    { date: "2026-10-17", label: "Weekly Spend", amount: "-450.00", itemId: "ws", occurrenceKey: "ws|2026-10-17" },
    // An overdue occurrence moved to the next business day keeps its occurrence key.
    { date: "2026-10-08", label: "Weekly Spend", amount: "-120.00", itemId: "ws", originalDate: "2026-09-26", assumption: "overdue_assumed_unpaid" },
    { date: "2026-10-12", label: "Mortgage", amount: "-1650.00", itemId: "mort", occurrenceKey: "mort|2026-10-12" },
  ],
  overdueAssumedPaid: [
    {
      planKey: "ws|2026-10-03", itemId: "ws", occurrenceDate: "2026-10-03", dueDate: "2026-10-03", label: "Weekly Spend",
      daysOverdue: 4, planAmount: "-120.00", txnId: "tx-pay", txnAmount: "-120.00", confidence: "card_payment", unpaidRemainder: "0.00",
    },
    {
      planKey: "mort|2026-10-01", itemId: "mort", occurrenceDate: "2026-10-01", dueDate: "2026-10-01", label: "Mortgage",
      daysOverdue: 6, planAmount: "-1650.00", txnId: "tx-mort", txnAmount: "-1650.00", confidence: "high", unpaidRemainder: "0.00",
    },
  ],
};

describe("hookPayoffsOf", () => {
  it("keys each hook occurrence by its plan key: the payoff, the plan, and the row that paid it", () => {
    const m = hookPayoffsOf(signal as never, (id) => (id === "tx-pay" ? "AMERICAN EXPRESS ACH PMT" : null));
    expect([...m.keys()].sort()).toEqual(["ws|2026-09-26", "ws|2026-10-03", "ws|2026-10-10", "ws|2026-10-17"]);
    expect(m.get("ws|2026-10-10")).toEqual({ planKey: "ws|2026-10-10", cadence: "weekly", plan: 450, payoff: 477.57, paidOnEvidence: null });
    expect(m.get("ws|2026-09-26")!.payoff).toBe(120);
    expect(m.get("ws|2026-10-03")).toMatchObject({ payoff: null, paidOnEvidence: { txnId: "tx-pay", amount: 120, description: "AMERICAN EXPRESS ACH PMT" } });
    // Not a hook: nothing.
    expect(m.has("mort|2026-10-12")).toBe(false);
    expect(m.has("mort|2026-10-01")).toBe(false);
  });

  it("no hooks, or no signal: empty", () => {
    expect(hookPayoffsOf(undefined).size).toBe(0);
    expect(hookPayoffsOf({ ...signal, hookAmountIgnored: undefined } as never).size).toBe(0);
  });
});

describe("hookPayoffWords", () => {
  it("the dashboard's words: card payoff and the plan; on evidence, the row; a row with no description says its amount", () => {
    const m = hookPayoffsOf(signal as never, (id) => (id === "tx-pay" ? "AMERICAN EXPRESS ACH PMT" : null));
    expect(hookPayoffWords(m.get("ws|2026-10-10")!)).toBe("card payoff $477.57 · plan $450");
    expect(hookPayoffWords(m.get("ws|2026-10-03")!)).toBe("paid on evidence by AMERICAN EXPRESS ACH PMT · plan $450");
    const unnamed = hookPayoffsOf(signal as never);
    expect(hookPayoffWords(unnamed.get("ws|2026-10-03")!)).toBe("paid on evidence by a $120.00 card payment · plan $450");
    expect(hookPayoffWords({ planKey: "k", cadence: "weekly", plan: 451.2, payoff: null, paidOnEvidence: null })).toBe("card payoff · plan $451.20");
  });
});
