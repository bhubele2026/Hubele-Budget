import { describe, it, expect } from "vitest";
import { expandDebtMin } from "./debtMinSchedule";
import { debtsTable, recurringItemsTable } from "@workspace/db";

type DebtRow = typeof debtsTable.$inferSelect;
type RecurringRow = typeof recurringItemsTable.$inferSelect;

function debt(overrides: Partial<DebtRow> = {}): DebtRow {
  return {
    id: "d-1",
    userId: "u",
    name: "Visa",
    balance: "1000.00",
    originalBalance: null,
    apr: "0.0000",
    minPayment: "50.00",
    payment: "0.00",
    type: null,
    status: "active",
    sortOrder: 0,
    dueDay: 15,
    statementDay: null,
    notes: null,
    lastBalanceUpdate: null,
    plaidAccountId: null,
    plaidLastSyncedAt: null,
    balanceSource: "manual",
    aprSource: "manual",
    minPaymentSource: "manual",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as DebtRow;
}

function rec(overrides: Partial<RecurringRow> = {}): RecurringRow {
  return {
    id: "ri-1",
    userId: "u",
    name: "Visa min",
    kind: "expense",
    amount: "50",
    frequency: "monthly",
    dayOfMonth: 15,
    anchorDate: null,
    active: "true",
    debtId: "d-1",
    categoryId: null,
    createdAt: new Date(),
    ...overrides,
  } as RecurringRow;
}

describe("expandDebtMin", () => {
  it("emits one event per month at dueDay for an active unlinked debt", () => {
    const events = expandDebtMin(
      debt({ dueDay: 15 }),
      null,
      new Date(2026, 0, 1),
      new Date(2026, 2, 31),
    );
    expect(events.map((e) => e.date)).toEqual([
      "2026-01-15",
      "2026-02-15",
      "2026-03-15",
    ]);
    for (const e of events) {
      expect(e.amount).toBe(-50);
      expect(e.kind).toBe("expense");
      expect(e.itemId).toBe("debt:d-1");
      expect(e.label).toBe("Visa minimum");
    }
  });

  it("emits no events when the debt is paid off (zero balance)", () => {
    const events = expandDebtMin(
      debt({ balance: "0.00" }),
      null,
      new Date(2026, 0, 1),
      new Date(2026, 5, 30),
    );
    expect(events).toEqual([]);
  });

  it("emits no events when the debt status is not active", () => {
    const events = expandDebtMin(
      debt({ status: "archived" }),
      null,
      new Date(2026, 0, 1),
      new Date(2026, 5, 30),
    );
    expect(events).toEqual([]);
  });

  it("emits no events when minPayment is zero", () => {
    const events = expandDebtMin(
      debt({ minPayment: "0.00" }),
      null,
      new Date(2026, 0, 1),
      new Date(2026, 5, 30),
    );
    expect(events).toEqual([]);
  });

  it("emits no events when the debt is linked to a recurring item", () => {
    const events = expandDebtMin(
      debt(),
      rec(),
      new Date(2026, 0, 1),
      new Date(2026, 5, 30),
    );
    expect(events).toEqual([]);
  });

  it("clamps dueDay to the last day of short months when dueDay > 28", () => {
    const events = expandDebtMin(
      debt({ dueDay: 31 }),
      null,
      new Date(2026, 0, 1),
      new Date(2026, 4, 31),
    );
    expect(events.map((e) => e.date)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
    ]);
  });

  it("clamps Feb 29 in a leap year", () => {
    const events = expandDebtMin(
      debt({ dueDay: 30 }),
      null,
      new Date(2028, 1, 1),
      new Date(2028, 2, 31),
    );
    expect(events.map((e) => e.date)).toEqual(["2028-02-29", "2028-03-30"]);
  });

  it("falls back to day 1 when dueDay is null or out of range", () => {
    const eventsNull = expandDebtMin(
      debt({ dueDay: null }),
      null,
      new Date(2026, 0, 1),
      new Date(2026, 1, 28),
    );
    expect(eventsNull.map((e) => e.date)).toEqual(["2026-01-01", "2026-02-01"]);

    const eventsZero = expandDebtMin(
      debt({ dueDay: 0 }),
      null,
      new Date(2026, 0, 1),
      new Date(2026, 1, 28),
    );
    expect(eventsZero.map((e) => e.date)).toEqual(["2026-01-01", "2026-02-01"]);
  });

  it("excludes events before `from` even within the starting month", () => {
    const events = expandDebtMin(
      debt({ dueDay: 15 }),
      null,
      new Date(2026, 0, 20),
      new Date(2026, 2, 31),
    );
    expect(events.map((e) => e.date)).toEqual(["2026-02-15", "2026-03-15"]);
  });

  it("excludes events after `to`", () => {
    const events = expandDebtMin(
      debt({ dueDay: 15 }),
      null,
      new Date(2026, 0, 1),
      new Date(2026, 1, 10),
    );
    expect(events.map((e) => e.date)).toEqual(["2026-01-15"]);
  });

  it("crosses year boundaries", () => {
    const events = expandDebtMin(
      debt({ dueDay: 5 }),
      null,
      new Date(2026, 10, 1),
      new Date(2027, 1, 28),
    );
    expect(events.map((e) => e.date)).toEqual([
      "2026-11-05",
      "2026-12-05",
      "2027-01-05",
      "2027-02-05",
    ]);
  });

  it("uses the absolute value of minPayment as a negative expense", () => {
    const events = expandDebtMin(
      debt({ minPayment: "75.50" }),
      null,
      new Date(2026, 0, 1),
      new Date(2026, 0, 31),
    );
    expect(events).toHaveLength(1);
    expect(events[0].amount).toBe(-75.5);
  });
});
