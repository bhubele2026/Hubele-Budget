import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";

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
const MONTH = "2026-05-01";

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(mappingRulesTable).where(eq(mappingRulesTable.userId, TEST_USER));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, TEST_USER));
  await db.delete(budgetLinesTable).where(eq(budgetLinesTable.userId, TEST_USER));
  await db.delete(budgetMonthsTable).where(eq(budgetMonthsTable.userId, TEST_USER));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db.delete(settingsTable).where(eq(settingsTable.userId, TEST_USER));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function insertCat(name: string, groupName: string, kind: "income" | "expense" = "expense") {
  const [row] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: TEST_USER, name, groupName, kind, sourceKind: "manual", sortOrder: 0 })
    .returning();
  return row!;
}

async function insertLine(categoryId: string, planned: string, monthStart = MONTH) {
  await db
    .insert(budgetMonthsTable)
    .values({ userId: TEST_USER, monthStart })
    .onConflictDoNothing();
  await db
    .insert(budgetLinesTable)
    .values({ userId: TEST_USER, monthStart, categoryId, plannedAmount: planned })
    .onConflictDoNothing();
}

describe("budget category v2 migration", () => {
  it("merges old categories into new ones, summing planned amounts and re-pointing references", async () => {
    // Seed legacy state: three old utility categories + one transaction + one rule.
    const mge = await insertCat("Electric & Gas (MGE)", "Essential — Housing");
    const water = await insertCat("Water/Sewer (City of Madison)", "Essential — Housing");
    const phone = await insertCat("Phone (Verizon)", "Essential — Housing");
    await insertLine(mge.id, "241.00");
    await insertLine(water.id, "101.02");
    await insertLine(phone.id, "342.00");

    // A transaction tagged to the old MGE category — Actual should follow.
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      occurredOn: "2026-05-10",
      amount: "-150.00",
      description: "MGE Electric",
      source: "amex",
      categoryId: mge.id,
    });

    // A user mapping rule pointing at the old water category.
    await db.insert(mappingRulesTable).values({
      userId: TEST_USER,
      pattern: "City of Madison",
      matchType: "contains",
      categoryId: water.id,
      priority: 100,
    });

    // Trigger migration via the endpoint.
    const res = await fetch(`${baseUrl}/budget/months/${MONTH}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    // Old categories should be gone.
    const remaining = await db
      .select()
      .from(budgetCategoriesTable)
      .where(
        and(
          eq(budgetCategoriesTable.userId, TEST_USER),
          inArray(budgetCategoriesTable.name, [
            "Electric & Gas (MGE)",
            "Water/Sewer (City of Madison)",
            "Phone (Verizon)",
          ]),
        ),
      );
    expect(remaining).toHaveLength(0);

    // New "Utilities" category should exist with summed planned amount.
    const utilitiesGroup = body.groups.find(
      (g: { groupName: string }) => g.groupName === "Housing & Utilities",
    );
    expect(utilitiesGroup).toBeTruthy();
    const utilitiesLine = utilitiesGroup.lines.find(
      (l: { categoryName: string }) => l.categoryName === "Utilities",
    );
    expect(utilitiesLine).toBeTruthy();
    expect(parseFloat(utilitiesLine.plannedAmount)).toBeCloseTo(684.02, 2); // 241 + 101.02 + 342
    expect(parseFloat(utilitiesLine.actualAmount)).toBeCloseTo(150.0, 2);

    // Mapping rule should now point at the new Utilities category.
    const utilCatRow = await db
      .select()
      .from(budgetCategoriesTable)
      .where(
        and(
          eq(budgetCategoriesTable.userId, TEST_USER),
          eq(budgetCategoriesTable.name, "Utilities"),
        ),
      );
    expect(utilCatRow).toHaveLength(1);
    const rules = await db
      .select()
      .from(mappingRulesTable)
      .where(eq(mappingRulesTable.userId, TEST_USER));
    expect(rules).toHaveLength(1);
    expect(rules[0]!.categoryId).toBe(utilCatRow[0]!.id);

    // Flag should be set so subsequent runs are no-ops.
    const [s] = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.userId, TEST_USER));
    expect(s).toBeTruthy();
    const prefs = s!.preferences as { budgetCategoriesV2?: boolean } | null;
    expect(prefs?.budgetCategoriesV2).toBe(true);

    // A second call should be a no-op (no errors, no duplicate rows).
    const res2 = await fetch(`${baseUrl}/budget/months/${MONTH}`);
    expect(res2.status).toBe(200);
    const allCats = await db
      .select()
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.userId, TEST_USER));
    const utilCats = allCats.filter((c) => c.name === "Utilities");
    expect(utilCats).toHaveLength(1);
  });
});
