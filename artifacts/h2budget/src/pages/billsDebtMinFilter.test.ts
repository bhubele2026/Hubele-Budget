import { describe, it, expect } from "vitest";
import {
  filterDebtMinRowsByPayoff,
  type PayoffInfo,
} from "@/lib/forecastDebts";
import type { BillsDebtMinRow } from "@workspace/api-client-react";

function row(overrides: Partial<BillsDebtMinRow>): BillsDebtMinRow {
  return {
    debtId: "debt-x",
    debtName: "Card X",
    amount: "50",
    minPayment: "50",
    nextOccurrence: "2026-07-15",
    source: "manual",
    locked: false,
    linkedRecurringId: null,
    dueDay: 15,
    ...overrides,
  };
}

function payoff(debtId: string, payoffYM: string): PayoffInfo {
  const [y, m] = payoffYM.split("-").map(Number);
  return {
    debtId,
    debtName: `Debt ${debtId}`,
    payoffDate: new Date(y, m - 1, 28),
    payoffYM,
    lastMinPaid: 25,
  };
}

describe("Bills page — filterDebtMinRowsByPayoff", () => {
  it("hides a debt-min row when the debt is killed before its next due date", () => {
    // Card A is predicted dead in May 2026, but its next minimum is due
    // in July 2026 — Bills should hide that row.
    const rows = [
      row({ debtId: "cardA", amount: "50", nextOccurrence: "2026-07-15" }),
    ];
    const payoffs = new Map([["cardA", payoff("cardA", "2026-05")]]);

    const out = filterDebtMinRowsByPayoff(rows, payoffs);
    expect(out).toEqual([]);
  });

  it("keeps a row whose payoff month is the same as the next due month", () => {
    // Same-month edge case: payoff month >= next due month must remain
    // visible so the user still sees the final minimum payment.
    const rows = [
      row({ debtId: "cardB", amount: "75", nextOccurrence: "2026-06-10" }),
    ];
    const payoffs = new Map([["cardB", payoff("cardB", "2026-06")]]);

    const out = filterDebtMinRowsByPayoff(rows, payoffs);
    expect(out).toHaveLength(1);
    expect(out[0]?.debtId).toBe("cardB");
  });

  it("keeps a row whose payoff month is after the next due month", () => {
    const rows = [
      row({ debtId: "cardC", amount: "40", nextOccurrence: "2026-04-01" }),
    ];
    const payoffs = new Map([["cardC", payoff("cardC", "2026-09")]]);

    const out = filterDebtMinRowsByPayoff(rows, payoffs);
    expect(out).toHaveLength(1);
    expect(out[0]?.debtId).toBe("cardC");
  });

  it("keeps a row whose debt is missing from the payoffs map (still alive in sim)", () => {
    // No payoff entry == sim never killed it; the row must remain visible.
    const rows = [
      row({ debtId: "cardZ", amount: "33", nextOccurrence: "2026-12-01" }),
    ];
    const payoffs = new Map<string, PayoffInfo>();

    const out = filterDebtMinRowsByPayoff(rows, payoffs);
    expect(out).toHaveLength(1);
    expect(out[0]?.debtId).toBe("cardZ");
  });

  it("keeps a row that has no nextOccurrence even when the debt has a payoff", () => {
    // We don't know when the next minimum would land, so we can't safely
    // hide it — fall back to keeping the row visible.
    const rows = [
      row({ debtId: "cardD", amount: "20", nextOccurrence: null }),
    ];
    const payoffs = new Map([["cardD", payoff("cardD", "2026-01")]]);

    const out = filterDebtMinRowsByPayoff(rows, payoffs);
    expect(out).toHaveLength(1);
    expect(out[0]?.debtId).toBe("cardD");
  });

  it("Debt minimums total reflects only the surviving rows after filtering", () => {
    // Mixed scenario covering all three branches at once:
    //  - cardA: killed before next due → hidden (was $50)
    //  - cardB: payoff month >= next due → kept ($75)
    //  - cardC: missing from payoffs → kept ($40)
    //  - cardD: no nextOccurrence → kept ($20)
    // Surviving total must be 75 + 40 + 20 = $135, not the raw $185.
    const rows = [
      row({ debtId: "cardA", amount: "50", nextOccurrence: "2026-07-15" }),
      row({ debtId: "cardB", amount: "75", nextOccurrence: "2026-06-10" }),
      row({ debtId: "cardC", amount: "40", nextOccurrence: "2026-04-01" }),
      row({ debtId: "cardD", amount: "20", nextOccurrence: null }),
    ];
    const payoffs = new Map<string, PayoffInfo>([
      ["cardA", payoff("cardA", "2026-05")],
      ["cardB", payoff("cardB", "2026-06")],
      ["cardD", payoff("cardD", "2026-01")],
    ]);

    const surviving = filterDebtMinRowsByPayoff(rows, payoffs);
    const ids = surviving.map((r) => r.debtId).sort();
    expect(ids).toEqual(["cardB", "cardC", "cardD"]);

    // Mirrors the Bills "Debt minimums" card total:
    //   debtMin = sum(|Number(row.amount)|) over surviving rows.
    const debtMin = surviving.reduce(
      (s, r) => s + Math.abs(Number(r.amount) || 0),
      0,
    );
    expect(debtMin).toBe(135);

    // And the raw (unfiltered) total would have been higher — proves the
    // filter actually removed something from the total.
    const rawTotal = rows.reduce(
      (s, r) => s + Math.abs(Number(r.amount) || 0),
      0,
    );
    expect(rawTotal).toBe(185);
    expect(debtMin).toBeLessThan(rawTotal);
  });
});
