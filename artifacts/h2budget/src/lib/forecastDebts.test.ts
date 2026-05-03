import { describe, it, expect } from "vitest";
import { filterEventsByPayoff, type PayoffInfo } from "./forecastDebts";
import type { CashEvent } from "./forecast";

function ev(itemId: string, date: string, amount: number): CashEvent {
  return { itemId, date, label: itemId, kind: "expense", amount };
}

describe("filterEventsByPayoff", () => {
  const payoffs = new Map<string, PayoffInfo>([
    [
      "debtA",
      {
        debtId: "debtA",
        debtName: "Card A",
        payoffDate: new Date(2026, 5, 1),
        payoffYM: "2026-06",
        lastMinPaid: 50,
      },
    ],
  ]);

  it("drops synthetic debt-min events past payoff (no recurring link)", () => {
    const events = [
      ev("debt:debtA", "2026-05-15", -100),
      ev("debt:debtA", "2026-06-15", -100),
      ev("debt:debtA", "2026-07-15", -100),
      ev("debt:debtB", "2026-07-15", -25),
    ];
    const out = filterEventsByPayoff(events, new Map(), payoffs);
    expect(out.map((e) => e.date)).toEqual([
      "2026-05-15",
      "2026-06-15",
      "2026-07-15",
    ]);
    expect(out.find((e) => e.itemId === "debt:debtA" && e.date === "2026-07-15")).toBeUndefined();
    expect(out.find((e) => e.itemId === "debt:debtB")).toBeDefined();
  });

  it("scales the payoff-month event to lastMinPaid for synthetic debt events", () => {
    const events = [ev("debt:debtA", "2026-06-15", -100)];
    const out = filterEventsByPayoff(events, new Map(), payoffs);
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBeCloseTo(-50, 2);
  });

  it("still filters via the recurring-item link map", () => {
    const links = new Map<string, string>([["recur1", "debtA"]]);
    const events = [
      ev("recur1", "2026-06-15", -100),
      ev("recur1", "2026-07-15", -100),
    ];
    const out = filterEventsByPayoff(events, links, payoffs);
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe("2026-06-15");
  });

  it("keeps non-debt events unchanged", () => {
    const events = [ev("rentItem", "2026-09-01", -2000)];
    const out = filterEventsByPayoff(events, new Map(), payoffs);
    expect(out).toEqual(events);
  });
});
