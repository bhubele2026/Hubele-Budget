import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
    next();
  },
}));

import { db, debtsTable } from "@workspace/db";
import debtsRouter from "../routes/debts";

const app = express();
app.use(express.json());
app.use(debtsRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
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

// APR is stored & consumed as a decimal (0.2499 for 24.99%). The route
// rejects anything outside [0, 1).
describe("POST /debts — APR validation", () => {
  it("accepts a valid decimal APR (0.2499)", async () => {
    const res = await fetch(`${baseUrl}/debts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Visa Test",
        balance: "1000",
        apr: "0.2499",
        minPayment: "50",
        payment: "50",
      }),
    });
    expect([200, 201]).toContain(res.status);
  });

  it("rejects a percentage-shaped APR (24.99)", async () => {
    const res = await fetch(`${baseUrl}/debts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Visa Bad",
        balance: "1000",
        apr: "24.99",
        minPayment: "50",
        payment: "50",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? "").toMatch(/decimal/i);
    // Nothing was written.
    const rows = await db
      .select()
      .from(debtsTable)
      .where(eq(debtsTable.userId, TEST_USER));
    expect(rows).toHaveLength(0);
  });

  it("rejects APR = 1.0 (boundary)", async () => {
    const res = await fetch(`${baseUrl}/debts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Edge",
        balance: "1000",
        apr: "1.0",
        minPayment: "50",
        payment: "50",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts 0 APR", async () => {
    const res = await fetch(`${baseUrl}/debts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Promo",
        balance: "1000",
        apr: "0",
        minPayment: "50",
        payment: "50",
      }),
    });
    expect([200, 201]).toContain(res.status);
  });
});

describe("PATCH /debts/:id — APR validation", () => {
  it("rejects a percentage-shaped APR on update without mutating the row", async () => {
    const create = await fetch(`${baseUrl}/debts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Card",
        balance: "1000",
        apr: "0.18",
        minPayment: "50",
        payment: "50",
      }),
    });
    const created = (await create.json()) as { id: string };

    const res = await fetch(`${baseUrl}/debts/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apr: "29.99" }),
    });
    expect(res.status).toBe(400);

    const [row] = await db
      .select()
      .from(debtsTable)
      .where(eq(debtsTable.id, created.id));
    expect(Number(row.apr)).toBeCloseTo(0.18, 4);
  });
});
