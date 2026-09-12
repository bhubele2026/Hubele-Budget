import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq } from "drizzle-orm";

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

// The canonical amounts (task #106). They equal the seed amounts, which is why
// the reset can no longer tell a drifted line from a user's edit.
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

// Manual categories with no bill linked: the Budget page shows their stored
// line as is, so the response can be checked as well as the row. (Pets is not
// one: the bill-link heal points "Dog Waste Removal" at it, so its planned
// amount comes from that bill unless the month is pinned.)
const PLAIN_ENVELOPES = [
  "Health",
  "Groceries",
  "Dining & Coffee",
  "Childcare & Activities",
  "Shopping",
  "Entertainment",
  "Charitable Giving & Education",
  "Emergency Fund",
  "Investments & Retirement",
  "Kids' Savings / 529",
  "Tax Sinking Fund",
];

async function mayLinesByName(): Promise<Map<string, { planned: string; pinned: boolean }>> {
  const rows = await db
    .select({
      name: budgetCategoriesTable.name,
      planned: budgetLinesTable.plannedAmount,
      pinned: budgetLinesTable.pinned,
    })
    .from(budgetLinesTable)
    .innerJoin(budgetCategoriesTable, eq(budgetCategoriesTable.id, budgetLinesTable.categoryId))
    .where(
      and(
        eq(budgetLinesTable.householdId, TEST_HOUSEHOLD_ID),
        eq(budgetLinesTable.monthStart, MONTH),
      ),
    );
  return new Map(rows.map((r) => [r.name, { planned: r.planned, pinned: r.pinned }]));
}

async function mayMonthPinned(): Promise<boolean | undefined> {
  const [m] = await db
    .select({ pinned: budgetMonthsTable.pinned })
    .from(budgetMonthsTable)
    .where(
      and(
        eq(budgetMonthsTable.householdId, TEST_HOUSEHOLD_ID),
        eq(budgetMonthsTable.monthStart, MONTH),
      ),
    );
  return m?.pinned;
}

describe("May 2026 budget amounts reconciliation (task #106, owner decision 3)", () => {
  it("never overwrites a seeded household's May 2026 lines and never pins the month", async () => {
    // 1. Seed defaults for a fresh user: May 2026 lines at the canonical amounts.
    const seedRes = await fetch(`${baseUrl}/budget/seed-defaults`, {
      method: "POST",
    });
    expect(seedRes.status).toBe(200);

    const seeded = await mayLinesByName();
    for (const [name, expected] of CANONICAL) {
      expect(parseFloat(seeded.get(name)!.planned), `seeded ${name}`).toBeCloseTo(expected, 2);
    }

    // 2. The household edits two lines. The old reset forced both back.
    const cats = await db
      .select()
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.userId, TEST_USER));
    const byName = new Map(cats.map((c) => [c.name, c]));
    const misc = byName.get("Misc / Buffer")!;
    const groceries = byName.get("Groceries")!;
    await db
      .update(budgetLinesTable)
      .set({ plannedAmount: "0" })
      .where(eq(budgetLinesTable.categoryId, misc.id));
    await db
      .update(budgetLinesTable)
      .set({ plannedAmount: "512.34" })
      .where(eq(budgetLinesTable.categoryId, groceries.id));
    const before = await mayLinesByName();

    // 3. Hit the May 2026 budget endpoint, which runs the reconciliation.
    const res = await fetch(`${baseUrl}/budget/months/${MONTH}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: Array<{ lines: Array<{ categoryName: string; plannedAmount: string }> }>;
    };

    // Every May line the household had is exactly as it was, and none is pinned.
    const after = await mayLinesByName();
    for (const [name, line] of before) {
      expect(after.get(name), `May line ${name}`).toEqual(line);
      expect(after.get(name)!.pinned, `May line ${name} pinned`).toBe(false);
    }
    expect(after.get("Misc / Buffer")!.planned).toBe("0.00");
    expect(after.get("Groceries")!.planned).toBe("512.34");
    expect(await mayMonthPinned()).toBe(false);

    // Plain envelopes show their stored line on the page.
    const planned = new Map<string, number>();
    for (const g of body.groups) {
      for (const l of g.lines) planned.set(l.categoryName, parseFloat(l.plannedAmount));
    }
    expect(planned.get("Groceries")).toBeCloseTo(512.34, 2);
    for (const name of PLAIN_ENVELOPES.filter((n) => n !== "Groceries")) {
      const expected = CANONICAL.find(([n]) => n === name)![1];
      expect(planned.get(name), `expected ${name} = ${expected}`).toBeCloseTo(expected, 2);
    }

    // 4. Avalanche manualExtra is NOT touched by the May-2026 reconcile.
    const [av] = await db
      .select()
      .from(avalancheSettingsTable)
      .where(eq(avalancheSettingsTable.userId, TEST_USER));
    expect(av).toBeTruthy();
    expect(parseFloat(av!.manualExtra)).toBeCloseTo(0.0, 2);

    // 5. The per-household gate is set so the pass is a no-op next time.
    const [s] = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.userId, TEST_USER));
    expect(s).toBeTruthy();
    const prefs = s!.preferences as { budgetMay2026AmountsV1?: boolean } | null;
    expect(prefs?.budgetMay2026AmountsV1).toBe(true);

    // 6. A later edit survives a refresh too.
    await db
      .update(budgetLinesTable)
      .set({ plannedAmount: "999.00" })
      .where(eq(budgetLinesTable.categoryId, misc.id));
    const res2 = await fetch(`${baseUrl}/budget/months/${MONTH}`);
    expect(res2.status).toBe(200);
    expect((await mayLinesByName()).get("Misc / Buffer")!.planned).toBe("999.00");
    expect(await mayMonthPinned()).toBe(false);
  });
});
