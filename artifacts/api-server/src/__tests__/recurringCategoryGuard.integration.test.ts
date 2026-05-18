import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

/**
 * Task #697 — cross-household / unknown categoryId guard on
 * POST /recurring-items. The "My budget" guard already has UI coverage
 * via #693; this test pins the more security-sensitive branch:
 * validateBillCategoryLink must reject a categoryId that belongs to a
 * *different* household so a leaky regression can't quietly let bills
 * cross household boundaries.
 */

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const OTHER_USER = `other-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
  budgetCategoriesTable,
  recurringItemsTable,
} from "@workspace/db";
import recurringRouter from "../routes/recurring";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(recurringRouter);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
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
  await db
    .delete(recurringItemsTable)
    .where(eq(recurringItemsTable.userId, TEST_USER));
  await db
    .delete(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db
    .delete(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, OTHER_USER));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("POST /recurring-items — categoryId household guard (#697)", () => {
  it("rejects a categoryId that belongs to a different household with 400 'Invalid categoryId'", async () => {
    // Provision a separate household and seed a category there. The
    // active TEST_USER request should never be able to reach it.
    const other = await createTestHousehold(OTHER_USER);
    const [otherCat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: OTHER_USER,
        householdId: other.householdId,
        name: `Other Household Cat ${randomUUID().slice(0, 6)}`,
        groupName: "Essential — Housing",
        kind: "expense",
        sourceKind: "manual",
        sortOrder: 0,
      })
      .returning();

    const res = await fetch(`${baseUrl}/recurring-items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Should be rejected",
        kind: "bill",
        amount: "10.00",
        frequency: "monthly",
        categoryId: otherCat!.id,
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Invalid categoryId");

    // Defensive: the row must not have landed in either household.
    const inserted = await db
      .select()
      .from(recurringItemsTable)
      .where(eq(recurringItemsTable.name, "Should be rejected"));
    expect(inserted.length).toBe(0);
  });

  it("rejects a categoryId that does not exist at all with 400 'Invalid categoryId'", async () => {
    const res = await fetch(`${baseUrl}/recurring-items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Bogus category",
        kind: "bill",
        amount: "10.00",
        frequency: "monthly",
        categoryId: randomUUID(),
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Invalid categoryId");
  });
});
