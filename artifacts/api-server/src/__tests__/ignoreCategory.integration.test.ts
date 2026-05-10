import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

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
  budgetCategoriesTable,
  mappingRulesTable,
  transactionsTable,
} from "@workspace/db";
import budgetRouter from "../routes/budget";
import transactionsRouter from "../routes/transactions";
import mappingRouter from "../routes/mapping";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use("/api", budgetRouter);
app.use(transactionsRouter);
app.use(mappingRouter);

let server: Server;
let baseUrl: string;

async function deleteAllForUser(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(mappingRulesTable).where(eq(mappingRulesTable.userId, TEST_USER));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await deleteAllForUser();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await deleteAllForUser();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

describe("system-managed Ignore category (#624)", () => {
  it("GET /api/budget/categories lazy-seeds an Ignore row with excludeFromBudget=true", async () => {
    const r = await api("GET", "/api/budget/categories");
    expect(r.status).toBe(200);
    const rows = r.json as Array<{
      id: string;
      name: string;
      excludeFromBudget: boolean;
    }>;
    const ignore = rows.find((c) => c.name === "Ignore");
    expect(ignore).toBeTruthy();
    expect(ignore!.excludeFromBudget).toBe(true);
  });

  it("Picking Ignore on a transaction excludes it from /budget/months actuals & summary", async () => {
    // Seed a real spending category + the Ignore category so we have
    // something to compare against.
    const r0 = await api("GET", "/api/budget/categories");
    const cats = r0.json as Array<{
      id: string;
      name: string;
      excludeFromBudget: boolean;
    }>;
    const ignoreCat = cats.find((c) => c.name === "Ignore")!;
    const [coffeeCat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: `Coffee-${randomUUID().slice(0, 6)}`,
        kind: "expense",
        sourceKind: "manual",
      })
      .returning();

    // Two May 2026 transactions: one categorized as Coffee ($-30), one
    // tagged Ignore ($-1000). The Ignore row should be invisible in
    // every Budget roll-up.
    await db.insert(transactionsTable).values([
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-10",
        description: "STARBUCKS #1",
        amount: "-30.00",
        categoryId: coffeeCat!.id,
        source: "manual",
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-11",
        description: "BIG ONE-OFF I DON'T WANT IN BUDGET",
        amount: "-1000.00",
        categoryId: ignoreCat.id,
        source: "manual",
      },
    ]);

    const r = await api("GET", "/api/budget/months/2026-05-01");
    expect(r.status).toBe(200);
    const month = r.json as {
      lines: Array<{
        categoryId: string;
        categoryName: string;
        actualAmount: string | number;
      }>;
      summary: {
        expenses: { actual: string | number };
      };
    };
    // Ignore must not be listed as its own row.
    expect(
      month.lines.find((l) => l.categoryName === "Ignore"),
    ).toBeUndefined();
    // Coffee actual must reflect only the $30 transaction, not the
    // $1000 ignored row.
    const coffee = month.lines.find((l) => l.categoryId === coffeeCat!.id);
    expect(coffee).toBeTruthy();
    expect(Number(coffee!.actualAmount)).toBe(30);
    // Summary expenses.actual must exclude the ignored $1000.
    expect(Number(month.summary.expenses.actual)).toBeLessThan(1000);
  });

  it("PATCH categoryId=Ignore leaves the underlying transaction row's balance-relevant fields unchanged", async () => {
    // (#624 step 6) Picking Ignore must NOT mutate amount, isTransfer,
    // account routing, allowance flags, etc — the row stays in account
    // ledger and balance math identically. Only categoryId changes.
    const r0 = await api("GET", "/api/budget/categories");
    const cats = r0.json as Array<{ id: string; name: string }>;
    const ignoreCat = cats.find((c) => c.name === "Ignore")!;

    const [row] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-15",
        description: "BIG REIMBURSABLE EXPENSE",
        amount: "-456.78",
        isTransfer: false,
        weeklyAllowance: true,
        monthlyAllowance: false,
        unplannedAllowance: false,
        source: "manual",
      })
      .returning();

    const r = await api("PATCH", `/transactions/${row!.id}`, {
      categoryId: ignoreCat.id,
    });
    expect(r.status).toBe(200);

    const [after] = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.id, row!.id));
    expect(after!.categoryId).toBe(ignoreCat.id);
    // Balance-affecting + row-identity fields untouched.
    expect(after!.amount).toBe(row!.amount);
    expect(after!.occurredOn).toBe(row!.occurredOn);
    expect(after!.description).toBe(row!.description);
    expect(after!.isTransfer).toBe(false);
    // Allowance flags must NOT be auto-cleared (that's Transfer-only).
    expect(after!.weeklyAllowance).toBe(true);
    expect(after!.monthlyAllowance).toBe(false);
    expect(after!.unplannedAllowance).toBe(false);
  });

  it("POST /mapping-rules targeting Ignore returns 400 with the shared error", async () => {
    const r0 = await api("GET", "/api/budget/categories");
    const cats = r0.json as Array<{ id: string; name: string }>;
    const ignoreCat = cats.find((c) => c.name === "Ignore")!;

    const r = await api("POST", "/mapping-rules", {
      pattern: "ANYTHING",
      matchType: "contains",
      categoryId: ignoreCat.id,
    });
    expect(r.status).toBe(400);
    const body = r.json as { error: string };
    expect(body.error).toMatch(/system category|Ignore/i);
  });

  it("PATCH /mapping-rules/:id repointing to Ignore returns 400", async () => {
    // Create a real category and a rule pointing at it, then try to
    // repoint that rule at Ignore — must be rejected.
    const [coffeeCat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: `Coffee2-${randomUUID().slice(0, 6)}`,
        kind: "expense",
        sourceKind: "manual",
      })
      .returning();
    const create = await api("POST", "/mapping-rules", {
      pattern: "STARBUCKS",
      matchType: "contains",
      categoryId: coffeeCat!.id,
    });
    expect(create.status).toBe(201);
    const created = create.json as { id: string };

    const r0 = await api("GET", "/api/budget/categories");
    const cats = r0.json as Array<{ id: string; name: string }>;
    const ignoreCat = cats.find((c) => c.name === "Ignore")!;

    const r = await api("PATCH", `/mapping-rules/${created.id}`, {
      categoryId: ignoreCat.id,
    });
    expect(r.status).toBe(400);
  });
});
