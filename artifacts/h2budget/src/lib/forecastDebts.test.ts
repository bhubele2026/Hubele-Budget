import { describe, it, expect } from "vitest";
import {
  filterEventsByPayoff,
  linkRecurringToDebts,
  type PayoffInfo,
} from "./forecastDebts";
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

describe("linkRecurringToDebts", () => {
  it("regression: does NOT link a non-debt bill to a debt just because the dollar amount matches", () => {
    // State Farm Insurance is a recurring premium, not a debt payment.
    // Its monthly amount happened to equal the Synchrony / Ashley
    // Furniture minimum payment within $0.50, which previously caused
    // it to inherit the Avalanche payoff badge ("ends Jun 2026").
    const debts = [
      { id: "synchrony", name: "Ashley Furniture / Synchrony", minPayment: "125.00" },
    ];
    const recurring = [
      {
        id: "rec-statefarm",
        name: "State Farm Insurance",
        amount: "125.00",
        kind: "expense",
        active: true,
      },
    ];
    const out = linkRecurringToDebts(debts, recurring);
    expect(out.has("rec-statefarm")).toBe(false);
  });

  it("links by explicit debtId on the recurring item", () => {
    const debts = [{ id: "d1", name: "Loan", minPayment: "50" }];
    const recurring = [
      {
        id: "r1",
        name: "Misc",
        amount: "75",
        kind: "expense",
        active: true,
        debtId: "d1",
      },
    ];
    const out = linkRecurringToDebts(debts, recurring);
    expect(out.get("r1")).toBe("d1");
  });

  it("links when the recurring name overlaps the debt name", () => {
    const debts = [{ id: "disco", name: "Discover", minPayment: "40" }];
    const recurring = [
      {
        id: "r-disco",
        name: "Discover Card Payment",
        amount: "40",
        kind: "expense",
        active: true,
      },
    ];
    const out = linkRecurringToDebts(debts, recurring);
    expect(out.get("r-disco")).toBe("disco");
  });
});
