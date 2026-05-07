import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
    next();
  },
}));

import {
  db,
  debtsTable,
  recurringItemsTable,
  forecastSettingsTable,
  forecastResolutionsTable,
  transactionsTable,
  avalancheSettingsTable,
} from "@workspace/db";
import billsRouter from "../routes/bills";
import forecastRouter from "../routes/forecast";

const app = express();
app.use(express.json());
app.use(billsRouter);
app.use(forecastRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db
    .delete(forecastResolutionsTable)
    .where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(recurringItemsTable)
    .where(eq(recurringItemsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await db
    .delete(avalancheSettingsTable)
    .where(eq(avalancheSettingsTable.userId, TEST_USER));
}

async function setManualExtra(amount: string): Promise<void> {
  await db
    .insert(avalancheSettingsTable)
    .values({ userId: TEST_USER, manualExtra: amount })
    .onConflictDoUpdate({
      target: avalancheSettingsTable.userId,
      set: { manualExtra: amount },
    });
}

beforeAll(async () => {
  await cleanup();
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await cleanup();
  await new Promise<void>((res) => server.close(() => res()));
});

beforeEach(async () => {
  await cleanup();
});

type SummaryRow = {
  item: { id: string; name: string };
  nextOccurrence: string | null;
  monthlyAmount: string;
  actualAmount: string;
};
async function getBills(): Promise<{
  income: SummaryRow[];
  bills: SummaryRow[];
  debtMins: Array<{
    debtId: string;
    debtName: string;
    amount: string;
    minPayment: string;
    source: string;
    locked: boolean;
    linkedRecurringId: string | null;
    nextOccurrence: string | null;
    endsThisCycle?: boolean;
  }>;
  monthly: { bills: string; debtMin: string; totalOutflow: string; net: string };
}> {
  const r = await fetch(`${baseUrl}/bills/summary`);
  expect(r.status).toBe(200);
  return (await r.json()) as Awaited<ReturnType<typeof getBills>>;
}

async function insertDebt(over: Partial<typeof debtsTable.$inferInsert> = {}) {
  const [d] = await db
    .insert(debtsTable)
    .values({
      userId: TEST_USER,
      name: "Capital One",
      balance: "5000",
      apr: "0.2299",
      minPayment: "75",
      payment: "75",
      status: "active",
      dueDay: 15,
      minPaymentSource: "plaid",
      ...over,
    })
    .returning();
  return d;
}

async function insertRecurring(
  over: Partial<typeof recurringItemsTable.$inferInsert> = {},
) {
  const [r] = await db
    .insert(recurringItemsTable)
    .values({
      userId: TEST_USER,
      name: "Capital One",
      kind: "bill",
      amount: "75",
      frequency: "monthly",
      dayOfMonth: 15,
      active: "true",
      ...over,
    })
    .returning();
  return r;
}

describe("bills/summary debt minimums", () => {
  it("emits one virtual locked debt-min row per active debt with min>0", async () => {
    const d = await insertDebt({ name: "MasterCard", minPayment: "120", dueDay: 5 });
    const summary = await getBills();
    expect(summary.debtMins).toHaveLength(1);
    const row = summary.debtMins[0];
    expect(row.debtId).toBe(d.id);
    expect(row.debtName).toBe("MasterCard");
    expect(row.locked).toBe(true);
    expect(row.minPayment).toBe("120.00");
    expect(Number(row.amount)).toBe(-120);
    expect(row.source).toBe("plaid");
    expect(row.linkedRecurringId).toBeNull();
    expect(row.nextOccurrence).toMatch(/-05$/);
    expect(summary.monthly.debtMin).toBe("120.00");
  });

  it("skips inactive debts and debts with zero minimum", async () => {
    await insertDebt({ name: "Paid off", status: "paid" });
    await insertDebt({ name: "Zero min", minPayment: "0" });
    const summary = await getBills();
    expect(summary.debtMins).toHaveLength(0);
    expect(summary.monthly.debtMin).toBe("0.00");
  });

  it("dedups: linked recurring item is suppressed from bills and used for nextOccurrence", async () => {
    const d = await insertDebt({ name: "Discover", minPayment: "60", dueDay: 20 });
    await insertRecurring({
      name: "Discover",
      amount: "60",
      debtId: d.id,
      dayOfMonth: 22,
    });
    // Add an unrelated bill to confirm it survives
    await insertRecurring({
      name: "Internet",
      amount: "75",
      debtId: null,
      dayOfMonth: 1,
    });
    const summary = await getBills();
    expect(summary.bills).toHaveLength(1);
    expect((summary.bills[0] as { item: { name: string } }).item.name).toBe(
      "Internet",
    );
    expect(summary.debtMins).toHaveLength(1);
    expect(summary.debtMins[0].linkedRecurringId).not.toBeNull();
    expect(summary.debtMins[0].nextOccurrence).toMatch(/-22$/);
    // No double counting: bills total is just the unrelated bill, debtMin is the debt.
    expect(summary.monthly.bills).toBe("75.00");
    expect(summary.monthly.debtMin).toBe("60.00");
  });

  it("preserves a manually-entered recurring as a regular bill when it is NOT linked to any debt", async () => {
    await insertDebt({ name: "Loan", minPayment: "200", dueDay: 1 });
    await insertRecurring({
      name: "Loan-ish",
      amount: "199",
      debtId: null,
    });
    const summary = await getBills();
    expect(summary.bills).toHaveLength(1);
    expect(summary.debtMins).toHaveLength(1);
    expect(summary.monthly.bills).toBe("199.00");
    expect(summary.monthly.debtMin).toBe("200.00");
    expect(summary.monthly.totalOutflow).toBe("399.00");
  });

  it("debtMin total equals the sum of locked debt-min rows", async () => {
    await insertDebt({ name: "A", minPayment: "30" });
    await insertDebt({ name: "B", minPayment: "45.50" });
    await insertDebt({ name: "C", minPayment: "0.99" });
    const summary = await getBills();
    const sum = summary.debtMins.reduce(
      (s, r) => s + Math.abs(Number(r.amount)),
      0,
    );
    expect(sum.toFixed(2)).toBe(summary.monthly.debtMin);
    expect(summary.monthly.debtMin).toBe("76.49");
  });

  it("surfaces a one-cycle 'stops at payoff' row for debts archived this calendar month", async () => {
    const d = await insertDebt({
      name: "Just Paid Off",
      minPayment: "150",
      dueDay: 7,
      status: "archived",
      balance: "0",
    });
    // updatedAt defaults to now via the schema, so the archived debt qualifies
    const summary = await getBills();
    expect(summary.debtMins).toHaveLength(1);
    const row = summary.debtMins[0];
    expect(row.debtId).toBe(d.id);
    expect(row.endsThisCycle).toBe(true);
    expect(row.amount).toBe("0.00"); // doesn't inflate the total
    expect(row.minPayment).toBe("150.00"); // historical amount preserved for UI
    expect(row.nextOccurrence).toBeNull();
    expect(row.locked).toBe(true);
    // Total stays at $0 — the bill is gone, no double counting
    expect(summary.monthly.debtMin).toBe("0.00");
  });

  it("does NOT surface a 'stops at payoff' row for debts archived in a previous calendar month", async () => {
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 2);
    const d = await insertDebt({
      name: "Old Payoff",
      minPayment: "100",
      status: "archived",
      balance: "0",
    });
    // Force updatedAt to two months ago — should be filtered out
    await db
      .update(debtsTable)
      .set({ updatedAt: lastMonth })
      .where(eq(debtsTable.id, d.id));
    const summary = await getBills();
    expect(summary.debtMins).toHaveLength(0);
  });

  it("does NOT surface 'stops at payoff' for archived debt with non-zero balance", async () => {
    await insertDebt({
      name: "Archived With Balance",
      minPayment: "60",
      status: "archived",
      balance: "500",
    });
    const summary = await getBills();
    expect(summary.debtMins).toHaveLength(0);
  });

  it("flips an ACTIVE debt to 'stops at payoff' the moment its balance hits zero", async () => {
    // Plaid sync (or a manual balance edit) zeroes out the balance but the
    // debt is still status='active'. The Bills page must immediately stop
    // showing this as a normal locked row and instead show the celebratory
    // "stops at payoff" treatment so the bill doesn't silently disappear
    // from the totals.
    const d = await insertDebt({
      name: "Plaid-zeroed CC",
      minPayment: "85",
      dueDay: 12,
      status: "active",
      balance: "0",
    });
    const summary = await getBills();
    expect(summary.debtMins).toHaveLength(1);
    const row = summary.debtMins[0];
    expect(row.debtId).toBe(d.id);
    expect(row.endsThisCycle).toBe(true);
    expect(row.amount).toBe("0.00");
    expect(row.minPayment).toBe("85.00");
    expect(summary.monthly.debtMin).toBe("0.00");
  });

  it("'stops at payoff' rows still suppress their linked recurring item (dedup)", async () => {
    const d = await insertDebt({
      name: "Final Discover",
      minPayment: "60",
      status: "archived",
      balance: "0",
    });
    await insertRecurring({
      name: "Final Discover",
      amount: "60",
      debtId: d.id,
      dayOfMonth: 22,
    });
    const summary = await getBills();
    // The linked recurring item must NOT appear in regular bills
    expect(summary.bills).toHaveLength(0);
    expect(summary.debtMins).toHaveLength(1);
    expect(summary.debtMins[0].endsThisCycle).toBe(true);
    expect(summary.debtMins[0].linkedRecurringId).not.toBeNull();
    // Both totals are zero — the bill is gone everywhere
    expect(summary.monthly.bills).toBe("0.00");
    expect(summary.monthly.debtMin).toBe("0.00");
  });

  it("(#70) reports actualAmount per bill from matched txns this month and zero when none", async () => {
    // Two unrelated recurring bills. Rent has a matched txn this month;
    // Internet has none, so its actualAmount should remain 0.00.
    const rent = await insertRecurring({
      name: "Rent",
      amount: "1200",
      dayOfMonth: 1,
    });
    const internet = await insertRecurring({
      name: "Internet",
      amount: "75",
      dayOfMonth: 5,
    });

    const today = new Date();
    const monthStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
    const lastMonthEnd = (() => {
      const d = new Date(today.getFullYear(), today.getMonth(), 0);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    })();

    const [rentTxn] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        occurredOn: monthStart,
        description: "Rent payment",
        amount: "-1200",
        source: "plaid:bank",
      })
      .returning();
    // A second matched resolution from last month, to confirm we
    // window by occurrence_date (this txn must NOT count this month).
    const [oldRentTxn] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        occurredOn: lastMonthEnd,
        description: "Rent payment (old)",
        amount: "-1200",
        source: "plaid:bank",
      })
      .returning();

    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      recurringItemId: rent.id,
      occurrenceDate: monthStart,
      status: "matched",
      matchedTxnId: rentTxn.id,
    });
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      recurringItemId: rent.id,
      occurrenceDate: lastMonthEnd,
      status: "matched",
      matchedTxnId: oldRentTxn.id,
    });

    const summary = await getBills();
    const rentRow = summary.bills.find((r) => r.item.id === rent.id);
    const internetRow = summary.bills.find((r) => r.item.id === internet.id);
    expect(rentRow?.actualAmount).toBe("1200.00");
    expect(internetRow?.actualAmount).toBe("0.00");
  });

  it("(#70) sums multiple matched txns against the same bill within the month", async () => {
    const utility = await insertRecurring({
      name: "Electric",
      amount: "200",
      dayOfMonth: 10,
    });
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const day1 = `${y}-${m}-05`;
    const day2 = `${y}-${m}-12`;

    const [t1] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        occurredOn: day1,
        description: "Electric partial 1",
        amount: "-50",
        source: "plaid:bank",
      })
      .returning();
    const [t2] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        occurredOn: day2,
        description: "Electric partial 2",
        amount: "-90",
        source: "plaid:bank",
      })
      .returning();
    await db.insert(forecastResolutionsTable).values([
      {
        userId: TEST_USER,
        recurringItemId: utility.id,
        occurrenceDate: day1,
        status: "matched",
        matchedTxnId: t1.id,
      },
      {
        userId: TEST_USER,
        recurringItemId: utility.id,
        occurrenceDate: day2,
        status: "matched",
        matchedTxnId: t2.id,
      },
    ]);

    const summary = await getBills();
    const row = summary.bills.find((r) => r.item.id === utility.id);
    // Two partial payments, sum is 140; under planned 200 → "partial".
    expect(row?.actualAmount).toBe("140.00");
    expect(row?.monthlyAmount).toBe("200.00");
  });

  it("forecast events include synthetic debt-min events for unlinked debts and skip them when linked", async () => {
    const d1 = await insertDebt({ name: "Unlinked", minPayment: "50", dueDay: 10 });
    const d2 = await insertDebt({ name: "Linked", minPayment: "80", dueDay: 1 });
    await insertRecurring({ name: "Linked", amount: "80", debtId: d2.id });
    const r = await fetch(`${baseUrl}/forecast?days=120`);
    expect(r.status).toBe(200);
    const f = (await r.json()) as {
      events: Array<{ itemId: string; amount: number; label: string }>;
    };
    const debtEvents = f.events.filter((e) => e.itemId === `debt:${d1.id}`);
    expect(debtEvents.length).toBeGreaterThan(0);
    expect(debtEvents[0].amount).toBe(-50);
    // d2 should not appear as a synthetic debt event (linked recurring carries it)
    const linkedSynthetic = f.events.filter(
      (e) => e.itemId === `debt:${d2.id}`,
    );
    expect(linkedSynthetic).toHaveLength(0);
  });

  it("surfaces avalanche extra as a locked end-of-month bill row when manualExtra > 0", async () => {
    await insertDebt({ name: "MasterCard", minPayment: "120", balance: "5000" });
    await setManualExtra("200");
    const summary = await getBills();
    const extra = summary.debtMins.find((r) => r.debtId === "avalanche-extra");
    expect(extra).toBeDefined();
    expect(extra?.locked).toBe(true);
    expect(extra?.source).toBe("manual");
    expect(extra?.linkedRecurringId).toBeNull();
    expect(extra?.amount).toBe("-200.00");
    expect(extra?.minPayment).toBe("200.00");
    expect(extra?.debtName).toBe("Avalanche extra payment");
    // Pinned to the last day of the current month
    const today = new Date();
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const dd = String(monthEnd.getDate()).padStart(2, "0");
    expect(extra?.nextOccurrence).toMatch(new RegExp(`-${dd}$`));
    // Total includes the extra: 120 min + 200 extra = 320
    expect(summary.monthly.debtMin).toBe("320.00");
  });

  it("hides avalanche extra row when manualExtra is 0", async () => {
    await insertDebt({ name: "MasterCard", minPayment: "120" });
    await setManualExtra("0");
    const summary = await getBills();
    expect(summary.debtMins.find((r) => r.debtId === "avalanche-extra")).toBeUndefined();
    expect(summary.monthly.debtMin).toBe("120.00");
  });

  it("hides avalanche extra row when there are no active debts", async () => {
    await setManualExtra("200");
    const summary = await getBills();
    expect(summary.debtMins.find((r) => r.debtId === "avalanche-extra")).toBeUndefined();
  });

  it("forecast events include avalanche extra at month-end and stop at the simulated payoff", async () => {
    // Tiny debt + chunky extra → avalanche pays off within a month or two.
    await insertDebt({
      name: "Small CC",
      balance: "100",
      apr: "0.0",
      minPayment: "25",
    });
    await setManualExtra("500");
    const r = await fetch(`${baseUrl}/forecast?days=365`);
    expect(r.status).toBe(200);
    const f = (await r.json()) as {
      events: Array<{ itemId: string; date: string; amount: number; label: string }>;
    };
    const extras = f.events.filter((e) => e.itemId === "avalanche:extra");
    // At least one (this month) but capped at payoff (no full year of them).
    expect(extras.length).toBeGreaterThan(0);
    expect(extras.length).toBeLessThan(6);
    expect(extras[0].amount).toBe(-500);
    expect(extras[0].label).toBe("Avalanche extra payment");
    // Each event sits on the last day of its month
    for (const e of extras) {
      const [y, m, d] = e.date.split("-").map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      expect(d).toBe(lastDay);
    }
  });

  it("forecast emits no avalanche-extra events when manualExtra is 0", async () => {
    await insertDebt({ name: "MasterCard", minPayment: "120", balance: "5000" });
    await setManualExtra("0");
    const r = await fetch(`${baseUrl}/forecast?days=120`);
    const f = (await r.json()) as {
      events: Array<{ itemId: string }>;
    };
    expect(f.events.filter((e) => e.itemId === "avalanche:extra")).toHaveLength(0);
  });
});
