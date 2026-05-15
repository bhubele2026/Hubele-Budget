import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `unp-guard-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

import { db, transactionsTable } from "@workspace/db";
import transactionsRouter from "../routes/transactions";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(transactionsRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await cleanup();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(cleanup);

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
    /* ignore */
  }
  return { status: res.status, json };
}

async function insertTxn(
  overrides: Partial<typeof transactionsTable.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-04-15",
      description: "Test charge",
      amount: "12.34",
      source: "manual",
      ...overrides,
    })
    .returning({ id: transactionsTable.id });
  return row!.id;
}

// (#666) The Unplanned-transfer write guard relied on the now-disabled
// description/PFC heuristic. With auto-detection off, the user has full
// manual control over every row's bucket assignment — the guard never
// fires anymore, even on descriptions / PFCs that previously rejected.
describe("(#666) Unplanned-transfer guard no longer rejects", () => {
  it("allows setting unplannedAllowance=true on a previously-rejected description", async () => {
    const id = await insertTxn({
      description: "Online Transfer to SAV ...9128",
      unplannedAllowance: false,
    });

    const r = await api("PATCH", `/transactions/${id}`, {
      unplannedAllowance: true,
    });

    expect(r.status).toBe(200);

    const [row] = await db
      .select({ unplannedAllowance: transactionsTable.unplannedAllowance })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, id));
    expect(row?.unplannedAllowance).toBe(true);
  });

  it("allows setting unplannedAllowance=true on a row whose pfc_primary is TRANSFER_OUT", async () => {
    const id = await insertTxn({
      description: "GENERIC BANK MOVE 12345",
      pfcPrimary: "TRANSFER_OUT",
      unplannedAllowance: false,
    });

    const r = await api("PATCH", `/transactions/${id}`, {
      unplannedAllowance: true,
    });

    expect(r.status).toBe(200);
  });

  it("allows setting unplannedAllowance=true on a normal merchant row", async () => {
    const id = await insertTxn({
      description: "STARBUCKS COFFEE #221",
      unplannedAllowance: false,
    });

    const r = await api("PATCH", `/transactions/${id}`, {
      unplannedAllowance: true,
    });

    expect(r.status).toBe(200);
    const [row] = await db
      .select({ unplannedAllowance: transactionsTable.unplannedAllowance })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, id));
    expect(row?.unplannedAllowance).toBe(true);
  });
});
