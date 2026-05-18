import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const OTHER_USER = `test-other-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

let TEST_HOUSEHOLD_ID: string;
let OTHER_HOUSEHOLD_ID: string;

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
  budgetCategoriesTable,
  recurringItemsTable,
} from "@workspace/db";
import recurringRouter from "../routes/recurring";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use(recurringRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db
    .delete(recurringItemsTable)
    .where(eq(recurringItemsTable.userId, TEST_USER));
  await db
    .delete(recurringItemsTable)
    .where(eq(recurringItemsTable.userId, OTHER_USER));
  await db
    .delete(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db
    .delete(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, OTHER_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  OTHER_HOUSEHOLD_ID = (await createTestHousehold(OTHER_USER)).householdId;
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

// (#697) validateBillCategoryLink must refuse any categoryId that does
// not belong to the caller's household — both the cross-household leak
// case and the "no such category anywhere" case. The "My budget" group
// guard has its own UI test (#693); this file locks down the more
// security-sensitive household boundary at the API level so a future
// refactor cannot silently drop the householdId check and start letting
// one family's bills point at another family's category rows.
describe("POST /recurring-items category household guard (#697)", () => {
  it("rejects a categoryId that belongs to a different household with 400 'Invalid categoryId'", async () => {
    // Seed a category owned by OTHER_HOUSEHOLD_ID — never the caller's.
    const [foreignCat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: OTHER_USER,
        householdId: OTHER_HOUSEHOLD_ID,
        name: "Neighbor's Rent",
        kind: "expense",
        groupName: "Housing",
      })
      .returning();

    const res = await fetch(`${baseUrl}/recurring-items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Rent",
        kind: "bill",
        amount: "1200",
        frequency: "monthly",
        dayOfMonth: 1,
        categoryId: foreignCat.id,
        active: "true",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid categoryId");

    // And no recurring row leaked in for the caller.
    const rows = await db
      .select()
      .from(recurringItemsTable)
      .where(eq(recurringItemsTable.userId, TEST_USER));
    expect(rows).toHaveLength(0);
  });

  it("rejects a categoryId that does not exist at all with 400 'Invalid categoryId'", async () => {
    const ghostId = randomUUID();
    const res = await fetch(`${baseUrl}/recurring-items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Rent",
        kind: "bill",
        amount: "1200",
        frequency: "monthly",
        dayOfMonth: 1,
        categoryId: ghostId,
        active: "true",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid categoryId");

    const rows = await db
      .select()
      .from(recurringItemsTable)
      .where(eq(recurringItemsTable.userId, TEST_USER));
    expect(rows).toHaveLength(0);
  });

  it("accepts a categoryId that belongs to the caller's own household (control)", async () => {
    const [ownCat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "My Rent",
        kind: "expense",
        groupName: "Housing",
      })
      .returning();

    const res = await fetch(`${baseUrl}/recurring-items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Rent",
        kind: "bill",
        amount: "1200",
        frequency: "monthly",
        dayOfMonth: 1,
        categoryId: ownCat.id,
        active: "true",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { categoryId: string };
    expect(body.categoryId).toBe(ownCat.id);
  });
});
