import { describe, it, expect } from "vitest";
import { expandItem, expandAll, buildDaily, type CashEvent, type RecurringLite } from "./forecast";
import { buildLineRegister, type Transaction, type Resolution } from "./forecastMatch";

function item(overrides: Partial<RecurringLite> & { id: string; name: string }): RecurringLite {
  return {
    kind: "expense",
    amount: "100",
    frequency: "monthly",
    dayOfMonth: 1,
    anchorDate: null,
    active: "true",
    ...overrides,
  };
}

describe("Cash signal projection math (#47)", () => {
  describe("expandItem", () => {
    it("expands a monthly bill into the correct number of occurrences", () => {
      const rent = item({ id: "rent", name: "Rent", amount: "1200", dayOfMonth: 1 });
      const from = new Date(2026, 0, 1);
      const to = new Date(2026, 5, 30);
      const events = expandItem(rent, from, to);
      expect(events).toHaveLength(6);
      expect(events[0].date).toBe("2026-01-01");
      expect(events[5].date).toBe("2026-06-01");
      expect(events.every((e) => e.amount === -1200)).toBe(true);
    });

    it("expands a weekly item correctly", () => {
      const weekly = item({
        id: "w1",
        name: "Groceries",
        amount: "150",
        frequency: "weekly",
        anchorDate: "2026-05-01",
      });
      const from = new Date(2026, 4, 1);
      const to = new Date(2026, 4, 31);
      const events = expandItem(weekly, from, to);
      expect(events.length).toBeGreaterThanOrEqual(4);
      expect(events.length).toBeLessThanOrEqual(5);
      expect(events[0].date).toBe("2026-05-01");
    });

    it("returns empty for inactive items", () => {
      const inactive = item({ id: "x", name: "Off", active: "false" });
      const events = expandItem(inactive, new Date(2026, 0, 1), new Date(2026, 11, 31));
      expect(events).toHaveLength(0);
    });

    it("expands biweekly correctly", () => {
      const bw = item({
        id: "pay",
        name: "Paycheck",
        kind: "income",
        amount: "2000",
        frequency: "biweekly",
        anchorDate: "2026-05-01",
      });
      const from = new Date(2026, 4, 1);
      const to = new Date(2026, 4, 31);
      const events = expandItem(bw, from, to);
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].amount).toBe(2000);
    });

    it("expands semimonthly with two dates per month", () => {
      const semi = item({
        id: "sm",
        name: "Pay",
        kind: "income",
        amount: "1500",
        frequency: "semimonthly",
        dayOfMonth: 1,
      });
      const from = new Date(2026, 4, 1);
      const to = new Date(2026, 4, 31);
      const events = expandItem(semi, from, to);
      expect(events).toHaveLength(2);
    });

    it("handles onetime items", () => {
      const ot = item({
        id: "ot",
        name: "Tax refund",
        kind: "income",
        amount: "500",
        frequency: "onetime",
        anchorDate: "2026-05-15",
      });
      const from = new Date(2026, 4, 1);
      const to = new Date(2026, 4, 31);
      const events = expandItem(ot, from, to);
      expect(events).toHaveLength(1);
      expect(events[0].date).toBe("2026-05-15");
      expect(events[0].amount).toBe(500);
    });
  });

  describe("expandAll", () => {
    it("merges and sorts events from multiple items", () => {
      const items = [
        item({ id: "a", name: "A", amount: "100", dayOfMonth: 15 }),
        item({ id: "b", name: "B", amount: "200", dayOfMonth: 1 }),
      ];
      const from = new Date(2026, 4, 1);
      const to = new Date(2026, 4, 31);
      const events = expandAll(items, from, to);
      expect(events).toHaveLength(2);
      expect(events[0].date).toBe("2026-05-01");
      expect(events[1].date).toBe("2026-05-15");
    });
  });

  describe("buildDaily", () => {
    it("projects daily balances correctly", () => {
      const events: CashEvent[] = [
        { date: "2026-05-01", itemId: "pay", label: "Pay", kind: "income", amount: 3000 },
        { date: "2026-05-05", itemId: "rent", label: "Rent", kind: "expense", amount: -1200 },
        { date: "2026-05-15", itemId: "util", label: "Utilities", kind: "expense", amount: -200 },
      ];
      const startBalance = 500;
      const from = new Date(2026, 4, 1);
      const to = new Date(2026, 4, 15);
      const days = buildDaily(events, startBalance, from, to);
      expect(days).toHaveLength(15);
      expect(days[0].balance).toBe(3500);
      expect(days[4].balance).toBe(2300);
      expect(days[14].balance).toBe(2100);
    });

    it("handles empty events", () => {
      const days = buildDaily([], 1000, new Date(2026, 4, 1), new Date(2026, 4, 3));
      expect(days).toHaveLength(3);
      expect(days.every((d) => d.balance === 1000)).toBe(true);
    });
  });

  describe("buildLineRegister running balance", () => {
    it("computes projected running balance when no bank txns exist", () => {
      const events: CashEvent[] = [
        { date: "2026-06-01", itemId: "pay", label: "Pay", kind: "income", amount: 3000 },
        { date: "2026-06-05", itemId: "rent", label: "Rent", kind: "expense", amount: -1200 },
        { date: "2026-06-15", itemId: "util", label: "Utilities", kind: "expense", amount: -200 },
      ];
      const { rows } = buildLineRegister({
        events,
        txns: [],
        resolutions: [],
        closedMonths: new Set(),
        startBalance: 500,
        fromISO: "2026-06-01",
        toISO: "2026-06-30",
        today: new Date("2026-05-15"),
      });
      expect(rows).toHaveLength(3);
      expect(rows[0].runningBalance).toBe(3500);
      expect(rows[1].runningBalance).toBe(2300);
      expect(rows[2].runningBalance).toBe(2100);
    });

    it("computes running balance with bank transactions", () => {
      const txns: Transaction[] = [
        { id: "t1", occurredOn: "2026-05-02", description: "Deposit", amount: "3000", forecastFlag: true },
        { id: "t2", occurredOn: "2026-05-05", description: "Rent", amount: "-1200", forecastFlag: true },
      ];
      const { rows } = buildLineRegister({
        events: [],
        txns,
        resolutions: [],
        closedMonths: new Set(),
        startBalance: 500,
        fromISO: "2026-05-01",
        toISO: "2026-05-31",
        today: new Date("2026-05-15"),
      });
      const bankRows = rows.filter((r) => r.kind === "bank");
      expect(bankRows).toHaveLength(2);
      expect(bankRows[0].runningBalance).toBe(3500);
      expect(bankRows[1].runningBalance).toBe(2300);
    });

    it("skips items before snapshot anchor in running balance", () => {
      const txns: Transaction[] = [
        { id: "t0", occurredOn: "2026-05-01", description: "Old", amount: "-500", forecastFlag: true },
        { id: "t1", occurredOn: "2026-05-10", description: "New", amount: "-200", forecastFlag: true },
      ];
      const { rows } = buildLineRegister({
        events: [],
        txns,
        resolutions: [],
        closedMonths: new Set(),
        startBalance: 1000,
        fromISO: "2026-05-01",
        toISO: "2026-05-31",
        today: new Date("2026-05-15"),
        snapshotISO: "2026-05-05",
      });
      const bankRows = rows.filter((r) => r.kind === "bank");
      expect(bankRows).toHaveLength(2);
      expect(bankRows[0].runningBalance).toBe(1000);
      expect(bankRows[1].runningBalance).toBe(800);
    });
  });
});
