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

import { db, transactionsTable } from "@workspace/db";
import { uncategorizeTransactionsByIdsBodyIdsMax } from "@workspace/api-zod";
import transactionsRouter from "../routes/transactions";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(transactionsRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
}

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
  await cleanup();
  server = createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
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

describe("POST /transactions/uncategorize-by-ids id-list cap", () => {
  it("rejects payloads with more than the documented cap of ids with a 400 and a clear error message (no silent truncation)", async () => {
    const oversize = Array.from(
      { length: uncategorizeTransactionsByIdsBodyIdsMax + 1 },
      () => randomUUID(),
    );
    const r = await api("POST", "/transactions/uncategorize-by-ids", {
      ids: oversize,
      fromCategoryId: null,
    });
    expect(r.status).toBe(400);
    const err = (r.json as { error?: string } | null)?.error ?? "";
    expect(err).toMatch(/Too many ids/);
    expect(err).toContain(
      String(uncategorizeTransactionsByIdsBodyIdsMax),
    );
    expect(err).toContain(String(oversize.length));
  });

  it("accepts a payload at exactly the cap (no off-by-one rejection)", async () => {
    const atCap = Array.from(
      { length: uncategorizeTransactionsByIdsBodyIdsMax },
      () => randomUUID(),
    );
    const r = await api("POST", "/transactions/uncategorize-by-ids", {
      ids: atCap,
      fromCategoryId: null,
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      updated: 0,
      affectedMonths: [],
      affectedIds: [],
    });
  });
});
