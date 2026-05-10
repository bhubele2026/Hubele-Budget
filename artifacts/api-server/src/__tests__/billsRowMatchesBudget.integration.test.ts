import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq } from "drizzle-orm";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

let TEST_HOUSEHOLD_ID: string;
vi.mock("../middlewares/requireAuth", () => ({
    requireAuth: (
      req: {
        userId?: string;
        actualUserId?: string;
        householdId?: string;
        householdOwnerId?: string;
      },
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
import billsRouter from "../routes/bills";

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(budgetRouter);
app.use(billsRouter);

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

// (#492) Lock the "single source of truth" rule: the per-row monthlyAmount
// the Bills page renders as the "/mo" hint must equal the Budget page's
// "Budgeted" column for the same recurring line and same viewed month. The
// May 2026 anchor produces three biweekly Brad paychecks (5/01, 5/15, 5/29
// — anchor 2026-05-01) so the calendar-expanded total is $12,150 and we
// can prove the smoothed 26/12 multiplier ($8,775) is no longer the source.
describe("Bills row hint matches Budget budgeted column (#492)", () => {
  it("biweekly income's bills/summary monthlyAmount equals budget months plannedAmount", async () => {
    // Seed defaults so the budget categories (incl. "Brad's paycheck (KFI)"
    // with sourceKind=auto_bills) exist for this user.
    const seedRes = await fetch(`${baseUrl}/budget/seed-defaults`, {
      method: "POST",
    });
    expect(seedRes.status).toBe(200);

    // Replace the seeded biweekly Brad paycheck with one anchored to
    // 2026-05-01 so May 2026 expands to exactly 3 paydays of $4,050.
    const cats = await db
      .select()
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.userId, TEST_USER));
    const brad = cats.find((c) => c.name === "Brad's paycheck (KFI)");
    expect(brad).toBeTruthy();

    await db
      .delete(recurringItemsTable)
      .where(eq(recurringItemsTable.userId, TEST_USER));
    await db.insert(recurringItemsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Brad's paycheck (KFI)",
      kind: "income",
      amount: "4050.00",
      frequency: "biweekly",
      anchorDate: "2026-05-01",
      categoryId: brad!.id,
      active: "true",
    });

    // Pre-set the per-user reconciliation flag so the budget endpoint
    // skips the one-time May 2026 pin (which would otherwise force the
    // Brad line to a canonical $8,100 and pin the month). We want live
    // calendar expansion to win — that's what the task's "Budget page
    // shows $12,150 for May 2026" assertion relies on.
    await db
      .insert(settingsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        preferences: { budgetMay2026AmountsV1: true },
      })
      .onConflictDoUpdate({
        target: settingsTable.userId,
        set: { preferences: { budgetMay2026AmountsV1: true } },
      });

    // Bills page: per-row monthlyAmount used for the "/mo" hint.
    const billsRes = await fetch(`${baseUrl}/bills/summary`);
    expect(billsRes.status).toBe(200);
    const billsBody = (await billsRes.json()) as {
      income: Array<{
        item: { name: string; frequency: string };
        monthlyAmount: string;
      }>;
    };
    const bradBills = billsBody.income.find(
      (r) => r.item.name === "Brad's paycheck (KFI)",
    );
    expect(bradBills).toBeTruthy();
    expect(bradBills!.item.frequency).toBe("biweekly");

    // Budget page: plannedAmount column for the same line in the same month.
    const budgetRes = await fetch(`${baseUrl}/budget/months/${MONTH}`);
    expect(budgetRes.status).toBe(200);
    const budgetBody = (await budgetRes.json()) as {
      groups: Array<{
        lines: Array<{ categoryName: string; plannedAmount: string }>;
      }>;
    };
    const bradBudget = budgetBody.groups
      .flatMap((g) => g.lines)
      .find((l) => l.categoryName === "Brad's paycheck (KFI)");
    expect(bradBudget).toBeTruthy();

    const billsAmt = parseFloat(bradBills!.monthlyAmount);
    const budgetAmt = parseFloat(bradBudget!.plannedAmount);

    // Both come from expandItem() over the same window, so they must be
    // exactly equal — and not the smoothed 26/12 figure.
    expect(billsAmt).toBeCloseTo(12150, 2);
    expect(budgetAmt).toBeCloseTo(12150, 2);
    expect(billsAmt).toBeCloseTo(budgetAmt, 2);
    expect(billsAmt).not.toBeCloseTo(8775, 2);
  });
});
