import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

/**
 * (D3) The income side of `/reports/spending-facts`.
 *
 * The Reports hub divides real spend by `realIncome` to say what share of what
 * the household EARNED it spent. That only means something if the denominator
 * is earnings — not every dollar that happened to land in an account. This
 * seeds one month of the ways money arrives and asserts which of them count.
 */

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

import { db, budgetCategoriesTable, transactionsTable } from "@workspace/db";
import reportsRouter from "../routes/reports";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use("/api", reportsRouter);

let server: Server;
let baseUrl: string;

const FROM = "2026-05-01";
const TO = "2026-05-31";

type SpendingFacts = {
  realSpend: { total: number; transactionCount: number };
  realIncome: { total: number; transactionCount: number };
  dailyNet: { date: string; net: number }[];
};

async function deleteAllForUser(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, TEST_USER));
}

async function facts(): Promise<SpendingFacts> {
  const res = await fetch(
    `${baseUrl}/api/reports/spending-facts?from=${FROM}&to=${TO}`,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as SpendingFacts;
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await deleteAllForUser();

  const cat = async (name: string, kind: string, debtId: string | null = null) => {
    const [row] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: `${name}-${randomUUID().slice(0, 6)}`,
        kind,
        sourceKind: "manual",
        debtId,
      })
      .returning();
    return row!.id;
  };
  // "Transfer" must keep its exact name — the filter screens it by name.
  const transferCat = async () => {
    const [row] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Transfer",
        kind: "income",
        sourceKind: "manual",
      })
      .returning();
    return row!.id;
  };

  const paycheckId = await cat("Paycheck", "income");
  const groceriesId = await cat("Groceries", "expense");
  const transferId = await transferCat();

  await db.insert(transactionsTable).values([
    // Earned: two paychecks, one of them wearing the ACH noise the spend
    // filter screens on.
    {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-01",
      description: "ACME PAYROLL",
      amount: "2000.00",
      categoryId: paycheckId,
      source: "manual",
    },
    {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-15",
      description: "ORIG CO NAME:ACME ACH PMT WEB ID: 1234567890",
      amount: "1500.00",
      categoryId: paycheckId,
      source: "manual",
    },
    // Not earned: money moved from savings, a refund, and an uncategorized
    // deposit nobody has claimed yet.
    {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-05",
      description: "ONLINE TRANSFER FROM SAV",
      amount: "900.00",
      categoryId: transferId,
      source: "manual",
    },
    {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-06",
      description: "TARGET RETURN",
      amount: "45.00",
      categoryId: groceriesId,
      source: "manual",
    },
    {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-07",
      description: "MYSTERY DEPOSIT",
      amount: "300.00",
      categoryId: null,
      source: "manual",
    },
    // Spent, so the net has both sides on one day.
    {
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-01",
      description: "HY-VEE",
      amount: "-125.00",
      categoryId: groceriesId,
      source: "manual",
    },
  ]);

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

describe("GET /reports/spending-facts — realIncome", () => {
  it("counts only what was earned", async () => {
    const f = await facts();
    // 2000 + 1500. The transfer in, the refund and the unclaimed deposit are
    // all money that arrived; none of it is income.
    expect(f.realIncome.total).toBe(3500);
    expect(f.realIncome.transactionCount).toBe(2);
  });

  it("⚠️ keeps a paycheck whose raw string carries ACH transfer tokens", async () => {
    const f = await facts();
    // If the description screen the spend side uses were applied here, the
    // 15th's deposit would vanish and the total would read 2000.
    expect(f.realIncome.total).toBeGreaterThan(2000);
  });
});

describe("GET /reports/spending-facts — dailyNet", () => {
  it("covers every day in the range, quiet days included", async () => {
    const f = await facts();
    expect(f.dailyNet.length).toBe(31);
    expect(f.dailyNet[0]!.date).toBe("2026-05-01");
    expect(f.dailyNet[30]!.date).toBe("2026-05-31");
  });

  it("nets earnings against real spend, day by day", async () => {
    const f = await facts();
    const on = (d: string) => f.dailyNet.find((x) => x.date === d)!.net;
    expect(on("2026-05-01")).toBe(1875); // 2000 earned − 125 spent
    expect(on("2026-05-15")).toBe(1500);
    expect(on("2026-05-20")).toBe(0);
    // The transfer in does not lift the day it landed on.
    expect(on("2026-05-05")).toBe(0);
  });

  it("sums to realIncome − realSpend across the range", async () => {
    const f = await facts();
    const sum = f.dailyNet.reduce((s, d) => s + d.net, 0);
    expect(Math.round(sum * 100) / 100).toBe(
      Math.round((f.realIncome.total - f.realSpend.total) * 100) / 100,
    );
  });
});
