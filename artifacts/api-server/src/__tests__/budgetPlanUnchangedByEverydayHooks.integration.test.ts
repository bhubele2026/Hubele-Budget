// (PR8r, plan: "Budget plannedTotal / planBySource stay unchanged, pinned by a
// test") The Budget plan is bills + debt payments. Linking the everyday payoff
// hooks, a confirmed bill match on a weekly-flagged row, Amex charges and the
// Amex payment move the forecast curve and the actuals — never the plan. Pinned
// here so a later PR (PR10 switches the Budget actuals onto the classifier)
// cannot move the plan by accident.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import { and, eq } from "drizzle-orm";

const TEST_USER = `pr8r-budget-plan-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
  forecastResolutionsTable,
  mappingRulesTable,
  recurringItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import budgetRouter from "../routes/budget";
import settingsRouter from "../routes/settings";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";

const routes = express.Router();
routes.use(settingsRouter);
routes.use(budgetRouter);
const { request } = createTestApp(routes);

const MONTH = "2026-09-01";

type Bucket = { planned: string; actual: string; lineCount: number };
type Detail = {
  lines: Array<{ categoryId: string; plannedAmount: string }>;
  planBySource: {
    income: Bucket;
    bills: Bucket;
    debts: Bucket;
    unbacked: Bucket;
    plannedTotal: string;
    actualTotal: string;
    net: string;
  };
};

async function month(): Promise<Detail> {
  const res = await request("GET", `/budget/months/${MONTH}`);
  expect(res.status).toBe(200);
  return res.json as Detail;
}

/** Everything the plan is made of: each source's planned amount, the total, the net, and every line's planned amount. */
const planOnly = (d: Detail) => ({
  income: d.planBySource.income.planned,
  bills: d.planBySource.bills.planned,
  debts: d.planBySource.debts.planned,
  unbacked: d.planBySource.unbacked.planned,
  plannedTotal: d.planBySource.plannedTotal,
  net: d.planBySource.net,
  lines: d.lines.map((l) => [l.categoryId, l.plannedAmount]).sort(),
});

async function itemNamed(name: string): Promise<string> {
  const [item] = await db
    .select({ id: recurringItemsTable.id })
    .from(recurringItemsTable)
    .where(and(eq(recurringItemsTable.householdId, TEST_HOUSEHOLD_ID), eq(recurringItemsTable.name, name)));
  if (!item) throw new Error(`seeded item not found: ${name}`);
  return item.id;
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  expect((await request("POST", "/budget/seed-defaults")).status).toBe(200);
  await db
    .insert(settingsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      preferences: { budgetMay2026AmountsV1: true },
      weeklyAllowanceAmount: "400.00",
      monthlyAllowanceAmount: "350.00",
    })
    .onConflictDoUpdate({
      target: settingsTable.userId,
      set: { preferences: { budgetMay2026AmountsV1: true }, weeklyAllowanceAmount: "400.00", monthlyAllowanceAmount: "350.00" },
    });
});

afterAll(async () => {
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(mappingRulesTable).where(eq(mappingRulesTable.userId, TEST_USER));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, TEST_USER));
  await db.delete(budgetLinesTable).where(eq(budgetLinesTable.userId, TEST_USER));
  await db.delete(budgetMonthsTable).where(eq(budgetMonthsTable.userId, TEST_USER));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db.delete(avalancheSettingsTable).where(eq(avalancheSettingsTable.userId, TEST_USER));
  await db.delete(settingsTable).where(eq(settingsTable.userId, TEST_USER));
});

describe("Budget plannedTotal / planBySource — unchanged by the everyday hooks (PR8r)", () => {
  it("linking the hooks changes nothing on the Budget page, actuals included; the matched and Amex rows move no planned amount", async () => {
    const before = await month();
    expect(Number(before.planBySource.plannedTotal)).toBeGreaterThan(0);

    const weekly = await itemNamed("Weekly Spend");
    const monthly = await itemNamed("Monthly Spend");
    const linked = await request("PUT", "/settings", {
      preferences: { everydayHooks: { weeklyItemId: weekly, monthlyItemId: monthly } },
    });
    expect(linked.status).toBe(200);
    // The hooks alone: the whole page's plan-by-source is identical, actuals too.
    const afterLink = await month();
    expect(afterLink.planBySource).toEqual(before.planBySource);
    expect(planOnly(afterLink)).toEqual(planOnly(before));

    // A weekly-flagged row confirmed as a bill's payment, an Amex charge, and the Amex payment.
    const [paid] = await db
      .insert(transactionsTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, occurredOn: "2026-09-09", description: "UTILITY CO 3310", amount: "-145.00", weeklyAllowance: true })
      .returning({ id: transactionsTable.id });
    const truStage = await itemNamed("TruStage / Ethos");
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      recurringItemId: truStage,
      occurrenceDate: "2026-09-15",
      status: "matched",
      matchedTxnId: paid!.id,
    });
    await db.insert(transactionsTable).values([
      { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, occurredOn: "2026-09-08", description: "GREEN GROCER 118", amount: "120.00", source: "amex", weeklyAllowance: true },
      { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, occurredOn: "2026-09-15", description: "AMERICAN EXPRESS ACH PMT W4419", amount: "-120.00" },
    ]);
    const afterRows = await month();
    expect(planOnly(afterRows)).toEqual(planOnly(before));
  });
});
