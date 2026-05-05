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

vi.mock("../lib/plaidLiabilities", () => ({
  fetchLiabilitiesForItem: vi.fn(async () => []),
}));

import {
  db,
  debtsTable,
  debtBalanceHistoryTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
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
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
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

describe("(#292) auto-archive paid-off debts so the Bills 'Stops at payoff' row fires", () => {
  it("manual PATCH zeroing balance flips status to archived", async () => {
    const created = (await fetch(`${baseUrl}/debts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Visa Killer",
        balance: "1500",
        apr: "0.2",
        minPayment: "50",
        payment: "50",
      }),
    }).then((r) => r.json())) as { id: string; status: string };
    expect(created.status).toBe("active");

    const patched = await fetch(`${baseUrl}/debts/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ balance: "0" }),
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as { status: string; balance: string; updatedAt: string };
    expect(body.status).toBe("archived");
    expect(Number(body.balance)).toBe(0);

    // updatedAt must be in the current month so the Bills "stops at payoff"
    // row passes its justPaidOffDebt check.
    const updated = new Date(body.updatedAt);
    const now = new Date();
    expect(updated.getFullYear()).toBe(now.getFullYear());
    expect(updated.getMonth()).toBe(now.getMonth());
  });

  it("manual PATCH leaves status alone if user explicitly sent status in the same write", async () => {
    const created = (await fetch(`${baseUrl}/debts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Manual Status Card",
        balance: "200",
        apr: "0.1",
        minPayment: "10",
        payment: "10",
      }),
    }).then((r) => r.json())) as { id: string };

    const patched = await fetch(`${baseUrl}/debts/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ balance: "0", status: "active" }),
    });
    const body = (await patched.json()) as { status: string };
    expect(body.status).toBe("active");
  });

  it("manual PATCH on a non-zero balance does NOT touch status", async () => {
    const created = (await fetch(`${baseUrl}/debts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Still Owing",
        balance: "1000",
        apr: "0.2",
        minPayment: "50",
        payment: "50",
      }),
    }).then((r) => r.json())) as { id: string };

    const patched = await fetch(`${baseUrl}/debts/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ balance: "500" }),
    });
    const body = (await patched.json()) as { status: string };
    expect(body.status).toBe("active");
  });

  it("Plaid refresh that reports liabilityBalance=0 auto-archives the debt", async () => {
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        itemId: `item-${randomUUID()}`,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionName: "TestBank",
        institutionSlug: "testbank",
      })
      .returning();
    const [acct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        itemId: item!.id,
        accountId: `acct-${randomUUID()}`,
        name: "Visa Card",
        mask: "1234",
        type: "credit",
        subtype: "credit card",
        liabilityBalance: "0.00",
        liabilityApr: "0.20",
        liabilityMinPayment: "25.00",
      })
      .returning();
    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        name: "Plaid Card",
        balance: "1500",
        apr: "0.2",
        minPayment: "25",
        plaidAccountId: acct!.id,
        balanceSource: "plaid",
        status: "active",
      })
      .returning();

    const res = await fetch(`${baseUrl}/debts/${debt!.id}/refresh`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; balance: string; updatedAt: string };
    expect(body.status).toBe("archived");
    expect(Number(body.balance)).toBe(0);

    const [reread] = await db
      .select()
      .from(debtsTable)
      .where(and(eq(debtsTable.id, debt!.id), eq(debtsTable.userId, TEST_USER)));
    expect(reread.status).toBe("archived");
  });

  it("Plaid refresh that still reports a positive balance leaves status active", async () => {
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        itemId: `item-${randomUUID()}`,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionName: "TestBank",
        institutionSlug: "testbank",
      })
      .returning();
    const [acct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        itemId: item!.id,
        accountId: `acct-${randomUUID()}`,
        name: "Visa Card",
        mask: "5678",
        type: "credit",
        subtype: "credit card",
        liabilityBalance: "750.00",
      })
      .returning();
    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        name: "Plaid Card 2",
        balance: "1500",
        apr: "0.2",
        minPayment: "25",
        plaidAccountId: acct!.id,
        balanceSource: "plaid",
        status: "active",
      })
      .returning();

    const res = await fetch(`${baseUrl}/debts/${debt!.id}/refresh`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; balance: string };
    expect(body.status).toBe("active");
    expect(Number(body.balance)).toBe(750);
  });
});
