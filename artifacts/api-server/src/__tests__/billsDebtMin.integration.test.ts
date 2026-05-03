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
    .delete(recurringItemsTable)
    .where(eq(recurringItemsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
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

async function getBills(): Promise<{
  income: unknown[];
  bills: unknown[];
  debtMins: Array<{
    debtId: string;
    debtName: string;
    amount: string;
    minPayment: string;
    source: string;
    locked: boolean;
    linkedRecurringId: string | null;
    nextOccurrence: string | null;
  }>;
  monthly: { bills: string; debtMin: string; totalOutflow: string; net: string };
}> {
  const r = await fetch(`${baseUrl}/bills/summary`);
  expect(r.status).toBe(200);
  return r.json();
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
});
