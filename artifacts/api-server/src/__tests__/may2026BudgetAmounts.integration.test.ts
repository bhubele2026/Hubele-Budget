import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = TEST_USER;
    req.actualUserId = TEST_USER;
    req.householdId = TEST_HOUSEHOLD_ID;
    req.householdOwnerId = TEST_USER;
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
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(budgetRouter);

let server: Server;
let baseUrl: string;
const MONTH = "2026-05-01";

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
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
  await db.delete(avalancheSettingsTable).where(eq(avalancheSettingsTable.userId, TEST_USER));
  await db.delete(settingsTable).where(eq(settingsTable.userId, TEST_USER));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const CANONICAL: Array<[string, number]> = [
  ["Hannah's paycheck (Exact)", 4499.99],
  ["Brad's paycheck (KFI)", 8100.0],
  ["Other Income", 88.0],
  ["Mortgage (Lakeview)", 1989.81],
  ["HELOC (Figure)", 677.4],
  ["Utilities", 774.24],
  ["Home Maintenance & Warranty", 53.85],
  ["Health", 0],
  ["Insurance", 345.13],
  ["Groceries", 460.0],
  ["Dining & Coffee", 460.0],
  ["Car Payments", 1324.35],
  ["Gas, Maintenance & Parking", 250.0],
  ["Childcare & Activities", 0],
  ["Pets", 0],
  ["Subscriptions", 315.62],
  ["Shopping", 0],
  ["Entertainment", 0],
  ["Charitable Giving & Education", 0],
  ["Misc / Buffer", 237.58],
  ["Emergency Fund", 0],
  ["Investments & Retirement", 0],
  ["Kids' Savings / 529", 0],
  ["Tax Sinking Fund", 0],
];

describe("May 2026 budget amounts reconciliation (task #106)", () => {
  it("seeds defaults then reconciles May 2026 to the canonical source-of-truth amounts", async () => {
    // 1. Seed defaults for a fresh user.
    const seedRes = await fetch(`${baseUrl}/budget/seed-defaults`, {
      method: "POST",
    });
    expect(seedRes.status).toBe(200);

    // 2. Hand-edit a couple of manual categories to simulate prior drift, so
    //    we can prove the reconciliation forces them back to canonical.
    const cats = await db
      .select()
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.userId, TEST_USER));
    const byName = new Map(cats.map((c) => [c.name, c]));
    const misc = byName.get("Misc / Buffer")!;
    const utilities = byName.get("Utilities")!;
    await db
      .update(budgetLinesTable)
      .set({ plannedAmount: "0" })
      .where(eq(budgetLinesTable.categoryId, misc.id));
    await db
      .update(budgetLinesTable)
      .set({ plannedAmount: "100.00" })
      .where(eq(budgetLinesTable.categoryId, utilities.id));

    // 3. Hit the May 2026 budget endpoint, which triggers reconciliation.
    const res = await fetch(`${baseUrl}/budget/months/${MONTH}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: Array<{
        groupName: string;
        plannedTotal: string;
        lines: Array<{ categoryName: string; plannedAmount: string }>;
      }>;
    };

    // Build a flat lookup of category planned amounts.
    const planned = new Map<string, number>();
    for (const g of body.groups) {
      for (const l of g.lines) {
        planned.set(l.categoryName, parseFloat(l.plannedAmount));
      }
    }

    for (const [name, expected] of CANONICAL) {
      expect(planned.get(name), `expected ${name} = ${expected}`).toBeCloseTo(
        expected,
        2,
      );
    }

    // 4. Group totals derived from the per-line canonical values (per-line
    //    table is the source of truth; the prose totals in the task spec
    //    omit the Home Maintenance line for Housing & Utilities).
    const groupTotal = (name: string) => {
      const g = body.groups.find((g) => g.groupName === name);
      expect(g, `missing group ${name}`).toBeTruthy();
      return parseFloat(g!.plannedTotal);
    };
    expect(groupTotal("Income")).toBeCloseTo(12687.99, 2);
    expect(groupTotal("Housing & Utilities")).toBeCloseTo(3495.3, 2); // 1989.81+677.40+774.24+53.85
    expect(groupTotal("Insurance & Health")).toBeCloseTo(345.13, 2);
    expect(groupTotal("Food")).toBeCloseTo(920.0, 2);
    expect(groupTotal("Transportation")).toBeCloseTo(1574.35, 2);
    // Avalanche group's "Avalanche payment" line mirrors manualExtra. The
    // May-2026 reconcile intentionally NO LONGER force-sets manualExtra (it
    // used to clobber the user's own avalanche slider with a hardcoded
    // $6,225 and surface a giant Forecast row), so the managed line — and
    // therefore the group total — defaults to $0.00.
    expect(groupTotal("Avalanche — Extra to Highest APR")).toBeCloseTo(
      0.0,
      2,
    );

    // 5. Avalanche manualExtra is NOT touched by the May-2026 reconcile.
    // The managed-line sync (ensureSettings) creates the row at the $0
    // default; the user controls the real value via the Avalanche slider.
    const [av] = await db
      .select()
      .from(avalancheSettingsTable)
      .where(eq(avalancheSettingsTable.userId, TEST_USER));
    expect(av).toBeTruthy();
    expect(parseFloat(av!.manualExtra)).toBeCloseTo(0.0, 2);

    // 6. The per-user flag should be set so reconciliation is a no-op next time.
    const [s] = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.userId, TEST_USER));
    expect(s).toBeTruthy();
    const prefs = s!.preferences as { budgetMay2026AmountsV1?: boolean } | null;
    expect(prefs?.budgetMay2026AmountsV1).toBe(true);

    // 7. After reconciliation, a user edit on Misc / Buffer survives a refresh
    //    (i.e. reconciliation doesn't run a second time and clobber the edit).
    await db
      .update(budgetLinesTable)
      .set({ plannedAmount: "999.00" })
      .where(eq(budgetLinesTable.categoryId, misc.id));
    const res2 = await fetch(`${baseUrl}/budget/months/${MONTH}`);
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as typeof body;
    const miscLine = body2.groups
      .flatMap((g) => g.lines)
      .find((l) => l.categoryName === "Misc / Buffer");
    expect(parseFloat(miscLine!.plannedAmount)).toBeCloseTo(999.0, 2);
  });
});
