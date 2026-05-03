import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq } from "drizzle-orm";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
    next();
  },
}));

import { db, debtsTable, debtBalanceHistoryTable } from "@workspace/db";
import debtsRouter from "../routes/debts";

const app = express();
app.use(express.json());
app.use(debtsRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db
    .delete(debtBalanceHistoryTable)
    .where(eq(debtBalanceHistoryTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
}

beforeAll(async () => {
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

beforeEach(cleanup);

describe("debts.originalBalance anchor for /avalanche progress", () => {
  it("populates originalBalance from the create payload", async () => {
    const res = await fetch(`${baseUrl}/debts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Visa A",
        balance: "5000",
        apr: "0.2499",
        minPayment: "50",
        payment: "50",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; originalBalance: string };
    expect(Number(body.originalBalance)).toBe(5000);
  });

  it("does NOT lower originalBalance when balance shrinks (real progress)", async () => {
    const created = await fetch(`${baseUrl}/debts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Visa B", balance: "8000", apr: "0.2", minPayment: "100", payment: "100" }),
    }).then((r) => r.json() as Promise<{ id: string }>);

    const patched = await fetch(`${baseUrl}/debts/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ balance: "6000" }),
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as { balance: string; originalBalance: string };
    expect(Number(body.balance)).toBe(6000);
    expect(Number(body.originalBalance)).toBe(8000);
  });

  it("bumps originalBalance when a manual edit pushes balance higher", async () => {
    const created = await fetch(`${baseUrl}/debts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Visa C", balance: "1000", apr: "0.2", minPayment: "25", payment: "25" }),
    }).then((r) => r.json() as Promise<{ id: string }>);

    const patched = await fetch(`${baseUrl}/debts/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ balance: "1500" }),
    });
    const body = (await patched.json()) as { originalBalance: string };
    expect(Number(body.originalBalance)).toBe(1500);
  });

  it("backfills originalBalance for legacy debts on GET /debts", async () => {
    // Simulate a legacy row created before the anchor existed.
    const [row] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        name: "Legacy Loan",
        balance: "2000",
        apr: "0.1",
        minPayment: "75",
        payment: "75",
        originalBalance: null,
      })
      .returning();
    // Pretend we have a higher historical snapshot from before the user paid down.
    await db.insert(debtBalanceHistoryTable).values({
      userId: TEST_USER,
      debtId: row.id,
      recordedOn: "2025-01-01",
      balance: "3000",
    });

    const list = (await fetch(`${baseUrl}/debts`).then((r) => r.json())) as Array<{
      id: string;
      originalBalance: string | null;
    }>;
    const me = list.find((d) => d.id === row.id);
    expect(me).toBeDefined();
    expect(Number(me!.originalBalance)).toBe(3000);

    // Persisted, not just shaped on the way out.
    const [reread] = await db
      .select()
      .from(debtsTable)
      .where(and(eq(debtsTable.id, row.id), eq(debtsTable.userId, TEST_USER)));
    expect(Number(reread.originalBalance)).toBe(3000);
  });
});
