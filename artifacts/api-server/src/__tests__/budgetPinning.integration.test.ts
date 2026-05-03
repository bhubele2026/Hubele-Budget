import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq } from "drizzle-orm";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = TEST_USER;
    next();
  },
}));

import {
  db,
  avalancheSettingsTable,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  mappingRulesTable,
  recurringItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import budgetRouter from "../routes/budget";

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(budgetRouter);

let server: Server;
let baseUrl: string;
const MONTH = "2026-06-01";

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Seed defaults so we have categories.
  await fetch(`${baseUrl}/budget/seed-defaults`, { method: "POST" });

  // Pre-set the May 2026 reconciliation flag so it doesn't fire and pin
  // earlier months — we want this test focused on June 2026.
  await db
    .insert(settingsTable)
    .values({
      userId: TEST_USER,
      preferences: { budgetMay2026AmountsV1: true },
    })
    .onConflictDoUpdate({
      target: settingsTable.userId,
      set: { preferences: { budgetMay2026AmountsV1: true } },
    });
});

afterAll(async () => {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(mappingRulesTable).where(eq(mappingRulesTable.userId, TEST_USER));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, TEST_USER));
  await db.delete(budgetLinesTable).where(eq(budgetLinesTable.userId, TEST_USER));
  await db.delete(budgetMonthsTable).where(eq(budgetMonthsTable.userId, TEST_USER));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db.delete(avalancheSettingsTable).where(eq(avalancheSettingsTable.userId, TEST_USER));
  await db.delete(settingsTable).where(eq(settingsTable.userId, TEST_USER));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type DetailLine = {
  categoryId: string;
  categoryName: string;
  plannedAmount: string;
  sourceKind: "manual" | "auto_bills" | "auto_debts";
  pinned: boolean;
};
type Detail = {
  monthStart: string;
  monthPinned: boolean;
  groups: Array<{ groupName: string; lines: DetailLine[] }>;
};

const fetchMonth = async (month: string): Promise<Detail> => {
  const res = await fetch(`${baseUrl}/budget/months/${month}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Detail;
};

const findLine = (detail: Detail, name: string): DetailLine => {
  for (const g of detail.groups) {
    for (const l of g.lines) if (l.categoryName === name) return l;
  }
  throw new Error(`line not found: ${name}`);
};

describe("Budget pinning (task #115)", () => {
  it("month-level pin snapshots derived auto values and locks them", async () => {
    // Add an income recurring item so an auto_bills line has a derived value.
    const cats = await db
      .select()
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.userId, TEST_USER));
    const hannah = cats.find((c) => c.name === "Hannah's paycheck (Exact)");
    expect(hannah).toBeTruthy();

    // Wipe any seeded recurring items and add exactly one we control. Two
    // paychecks ($1000 each) land in June via biweekly anchor — derives $2000.
    await db
      .delete(recurringItemsTable)
      .where(eq(recurringItemsTable.userId, TEST_USER));
    await db.insert(recurringItemsTable).values({
      userId: TEST_USER,
      name: "Hannah's paycheck (Exact)",
      kind: "income",
      amount: "1000.00",
      frequency: "biweekly",
      anchorDate: "2026-06-05",
      categoryId: hannah!.id,
    });

    // Initial fetch: derived from recurring expansion.
    const before = await fetchMonth(MONTH);
    expect(before.monthPinned).toBe(false);
    const beforeLine = findLine(before, "Hannah's paycheck (Exact)");
    expect(parseFloat(beforeLine.plannedAmount)).toBeCloseTo(2000, 2);
    expect(beforeLine.pinned).toBe(false);

    // Pin the month.
    const pinRes = await fetch(`${baseUrl}/budget/months/${MONTH}/pin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    expect(pinRes.status).toBe(200);
    const pinBody = (await pinRes.json()) as {
      monthPinned: boolean;
      linesPinned: number;
    };
    expect(pinBody.monthPinned).toBe(true);
    expect(pinBody.linesPinned).toBeGreaterThan(0);

    // Now change the recurring item so the derivation would yield $5000.
    await db
      .update(recurringItemsTable)
      .set({ amount: "2500.00" })
      .where(eq(recurringItemsTable.userId, TEST_USER));

    const afterPin = await fetchMonth(MONTH);
    expect(afterPin.monthPinned).toBe(true);
    const afterLine = findLine(afterPin, "Hannah's paycheck (Exact)");
    // Pinned snapshot should still report $2000 even though derivation = $5000.
    expect(parseFloat(afterLine.plannedAmount)).toBeCloseTo(2000, 2);
    expect(afterLine.pinned).toBe(true);

    // Unpin.
    const unpinRes = await fetch(`${baseUrl}/budget/months/${MONTH}/pin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pinned: false }),
    });
    expect(unpinRes.status).toBe(200);

    const afterUnpin = await fetchMonth(MONTH);
    expect(afterUnpin.monthPinned).toBe(false);
    const afterUnpinLine = findLine(afterUnpin, "Hannah's paycheck (Exact)");
    // Falls back to live derivation again ($5000).
    expect(parseFloat(afterUnpinLine.plannedAmount)).toBeCloseTo(5000, 2);
    expect(afterUnpinLine.pinned).toBe(false);
  });

  it("per-line pin only locks that one auto-pulled line", async () => {
    const JULY = "2026-07-01";
    // First fetch to make sure derivation works ($2500 * 2 paychecks in July).
    const before = await fetchMonth(JULY);
    const julyLine = findLine(before, "Hannah's paycheck (Exact)");
    const julyBefore = parseFloat(julyLine.plannedAmount);
    expect(julyBefore).toBeGreaterThan(0);
    expect(julyLine.pinned).toBe(false);

    // Pin just this one line.
    const pinRes = await fetch(`${baseUrl}/budget/lines/pin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        monthStart: JULY,
        categoryId: julyLine.categoryId,
        pinned: true,
      }),
    });
    expect(pinRes.status).toBe(200);

    // Change recurring so derivation would yield a different value.
    await db
      .update(recurringItemsTable)
      .set({ amount: "9999.00" })
      .where(eq(recurringItemsTable.userId, TEST_USER));

    const after = await fetchMonth(JULY);
    expect(after.monthPinned).toBe(false);
    const afterLine = findLine(after, "Hannah's paycheck (Exact)");
    expect(parseFloat(afterLine.plannedAmount)).toBeCloseTo(julyBefore, 2);
    expect(afterLine.pinned).toBe(true);

    // Verify the row was actually persisted with pinned=true.
    const [persisted] = await db
      .select()
      .from(budgetLinesTable)
      .where(
        and(
          eq(budgetLinesTable.userId, TEST_USER),
          eq(budgetLinesTable.monthStart, JULY),
          eq(budgetLinesTable.categoryId, julyLine.categoryId),
        ),
      );
    expect(persisted?.pinned).toBe(true);
  });
});
