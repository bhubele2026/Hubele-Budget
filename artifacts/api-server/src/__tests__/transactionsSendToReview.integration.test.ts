// (#762 — Phase B) Integration tests for POST /transactions/send-to-review
// and POST /transactions/unsend-from-review. Mirrors the
// transactionsBulkUpdate.integration.test.ts harness so the test seam
// (mock requireAuth, ephemeral express server, fresh table state per
// test) stays consistent across the suite.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq, inArray, isNull, isNotNull, and } from "drizzle-orm";

const TEST_USER = `s2r-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const OTHER_USER = `s2r-other-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

import { db, transactionsTable } from "@workspace/db";
import transactionsRouter from "../routes/transactions";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(transactionsRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  for (const u of [TEST_USER, OTHER_USER]) {
    await db.delete(transactionsTable).where(eq(transactionsTable.userId, u));
  }
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  OTHER_HOUSEHOLD_ID = (await createTestHousehold(OTHER_USER)).householdId;
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
    json = null;
  }
  return { status: res.status, json };
}

async function insertTxn(
  userId: string,
  overrides: Partial<typeof transactionsTable.$inferInsert> = {},
): Promise<string> {
  const householdId =
    userId === TEST_USER ? TEST_HOUSEHOLD_ID : OTHER_HOUSEHOLD_ID;
  const [row] = await db
    .insert(transactionsTable)
    .values({
      userId,
      householdId,
      occurredOn: "2026-05-15",
      description: "Test charge",
      amount: "12.34",
      source: "chase",
      ...overrides,
    })
    .returning({ id: transactionsTable.id });
  return row!.id;
}

async function sentAt(id: string): Promise<string | null> {
  const [row] = await db
    .select({ sentToReviewAt: transactionsTable.sentToReviewAt })
    .from(transactionsTable)
    .where(eq(transactionsTable.id, id));
  return row?.sentToReviewAt ?? null;
}

describe("POST /transactions/send-to-review", () => {
  it("stamps sent_to_review_at on rows currently null and reports the count", async () => {
    const a = await insertTxn(TEST_USER);
    const b = await insertTxn(TEST_USER);

    const r = await api("POST", "/transactions/send-to-review", {
      transactionIds: [a, b],
    });

    expect(r.status).toBe(200);
    expect(r.json).toEqual({ updated: 2 });
    expect(await sentAt(a)).not.toBeNull();
    expect(await sentAt(b)).not.toBeNull();
  });

  it("is idempotent — re-sending already-sent rows doesn't bump the timestamp", async () => {
    const a = await insertTxn(TEST_USER);
    await api("POST", "/transactions/send-to-review", { transactionIds: [a] });
    const firstStamp = await sentAt(a);
    expect(firstStamp).not.toBeNull();

    // Wait a hair so a re-stamp would be observable.
    await new Promise((r) => setTimeout(r, 30));
    const r = await api("POST", "/transactions/send-to-review", {
      transactionIds: [a],
    });
    expect(r.status).toBe(200);
    // Already-sent rows are filtered out by the `is null` guard so the
    // UPDATE touches zero rows.
    expect(r.json).toEqual({ updated: 0 });
    expect(await sentAt(a)).toBe(firstStamp);
  });

  it("ignores ids from other households (household scoping)", async () => {
    const mine = await insertTxn(TEST_USER);
    const theirs = await insertTxn(OTHER_USER);

    const r = await api("POST", "/transactions/send-to-review", {
      transactionIds: [mine, theirs],
    });

    expect(r.status).toBe(200);
    expect(r.json).toEqual({ updated: 1 });
    expect(await sentAt(mine)).not.toBeNull();
    expect(await sentAt(theirs)).toBeNull();
  });

  it("rejects payloads over the 200-id cap with a 400", async () => {
    const ids = Array.from({ length: 201 }, () => randomUUID());
    const r = await api("POST", "/transactions/send-to-review", {
      transactionIds: ids,
    });
    expect(r.status).toBe(400);
  });

  it("no-ops cleanly on an empty id list", async () => {
    const r = await api("POST", "/transactions/send-to-review", {
      transactionIds: [],
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ updated: 0 });
  });
});

describe("POST /transactions/unsend-from-review", () => {
  it("clears sent_to_review_at on already-sent rows and skips not-yet-sent rows", async () => {
    const sent1 = await insertTxn(TEST_USER, {
      sentToReviewAt: new Date().toISOString(),
    });
    const sent2 = await insertTxn(TEST_USER, {
      sentToReviewAt: new Date().toISOString(),
    });
    const notSent = await insertTxn(TEST_USER);

    const r = await api("POST", "/transactions/unsend-from-review", {
      transactionIds: [sent1, sent2, notSent],
    });

    expect(r.status).toBe(200);
    // Only the two already-sent rows should be touched.
    expect(r.json).toEqual({ updated: 2 });

    const cleared = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(
        and(
          inArray(transactionsTable.id, [sent1, sent2]),
          isNull(transactionsTable.sentToReviewAt),
        ),
      );
    expect(cleared.map((r) => r.id).sort()).toEqual([sent1, sent2].sort());

    const stillNull = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.id, notSent),
          isNull(transactionsTable.sentToReviewAt),
        ),
      );
    expect(stillNull).toHaveLength(1);
  });

  it("does not unsend rows belonging to another household", async () => {
    const stamp = new Date().toISOString();
    const theirs = await insertTxn(OTHER_USER, { sentToReviewAt: stamp });

    const r = await api("POST", "/transactions/unsend-from-review", {
      transactionIds: [theirs],
    });

    expect(r.status).toBe(200);
    expect(r.json).toEqual({ updated: 0 });
    const [stillSent] = await db
      .select({ sentToReviewAt: transactionsTable.sentToReviewAt })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.id, theirs),
          isNotNull(transactionsTable.sentToReviewAt),
        ),
      );
    expect(stillSent).toBeDefined();
  });

  it("rejects payloads over the 200-id cap with a 400", async () => {
    const ids = Array.from({ length: 201 }, () => randomUUID());
    const r = await api("POST", "/transactions/unsend-from-review", {
      transactionIds: ids,
    });
    expect(r.status).toBe(400);
  });
});
