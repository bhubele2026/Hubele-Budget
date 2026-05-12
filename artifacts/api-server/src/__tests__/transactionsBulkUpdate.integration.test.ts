import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";

const TEST_USER = `bulk-upd-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const OTHER_USER = `other-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
  transactionsTable,
  forecastResolutionsTable,
} from "@workspace/db";
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
    await db
      .delete(forecastResolutionsTable)
      .where(eq(forecastResolutionsTable.userId, u));
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
      occurredOn: "2026-04-15",
      description: "Test charge",
      amount: "12.34",
      source: "amex",
      ...overrides,
    })
    .returning({ id: transactionsTable.id });
  return row!.id;
}

type BulkResult = {
  updated: number;
  results: { id: string; ok: boolean; error: string | null }[];
  affectedMonths: string[];
};

describe("POST /transactions/bulk-update", () => {
  it("reports per-id ok/error and only touches the resolvable rows", async () => {
    const a = await insertTxn(TEST_USER, { occurredOn: "2026-04-10" });
    const b = await insertTxn(TEST_USER, { occurredOn: "2026-05-02" });
    const missing = randomUUID();

    const r = await api("POST", "/transactions/bulk-update", {
      ids: [a, missing, b],
      patch: { reviewed: true },
    });

    expect(r.status).toBe(200);
    const body = r.json as BulkResult;
    expect(body.updated).toBe(2);
    const byId = Object.fromEntries(body.results.map((x) => [x.id, x]));
    expect(byId[a]).toEqual({ id: a, ok: true, error: null });
    expect(byId[b]).toEqual({ id: b, ok: true, error: null });
    expect(byId[missing]).toEqual({ id: missing, ok: false, error: "not found" });
    expect(body.affectedMonths.sort()).toEqual(["2026-04-01", "2026-05-01"]);

    const rows = await db
      .select({ id: transactionsTable.id, reviewed: transactionsTable.reviewed })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, TEST_USER),
          inArray(transactionsTable.id, [a, b]),
        ),
      );
    for (const row of rows) expect(row.reviewed).toBe(true);
  });

  it("does not patch transactions owned by another user (ownership filter)", async () => {
    const mine = await insertTxn(TEST_USER, { reviewed: false });
    const theirs = await insertTxn(OTHER_USER, { reviewed: false });

    const r = await api("POST", "/transactions/bulk-update", {
      ids: [mine, theirs],
      patch: { reviewed: true },
    });

    expect(r.status).toBe(200);
    const body = r.json as BulkResult;
    expect(body.updated).toBe(1);
    const byId = Object.fromEntries(body.results.map((x) => [x.id, x]));
    expect(byId[mine]).toEqual({ id: mine, ok: true, error: null });
    expect(byId[theirs]).toEqual({ id: theirs, ok: false, error: "not found" });

    const [otherRow] = await db
      .select({ reviewed: transactionsTable.reviewed })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, theirs));
    expect(otherRow?.reviewed).toBe(false);
  });

  it("drops forecast_resolutions for affected rows when forecastFlag is set to false", async () => {
    const flagged1 = await insertTxn(TEST_USER, { forecastFlag: true });
    const flagged2 = await insertTxn(TEST_USER, { forecastFlag: true });
    const untouched = await insertTxn(TEST_USER, { forecastFlag: true });

    await db.insert(forecastResolutionsTable).values([
      { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, status: "matched", matchedTxnId: flagged1 },
      { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, status: "matched", matchedTxnId: flagged2 },
      { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, status: "matched", matchedTxnId: untouched },
    ]);

    const r = await api("POST", "/transactions/bulk-update", {
      ids: [flagged1, flagged2],
      patch: { forecastFlag: false },
    });
    expect(r.status).toBe(200);
    expect((r.json as BulkResult).updated).toBe(2);

    const remaining = await db
      .select({ matchedTxnId: forecastResolutionsTable.matchedTxnId })
      .from(forecastResolutionsTable)
      .where(eq(forecastResolutionsTable.userId, TEST_USER));
    const remainingIds = remaining.map((r) => r.matchedTxnId);
    expect(remainingIds).toContain(untouched);
    expect(remainingIds).not.toContain(flagged1);
    expect(remainingIds).not.toContain(flagged2);
  });

  it("does NOT delete forecast_resolutions when forecastFlag is true (or omitted)", async () => {
    const id = await insertTxn(TEST_USER, { forecastFlag: false });
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      status: "matched",
      matchedTxnId: id,
    });

    const r = await api("POST", "/transactions/bulk-update", {
      ids: [id],
      patch: { forecastFlag: true },
    });
    expect(r.status).toBe(200);

    const rows = await db
      .select()
      .from(forecastResolutionsTable)
      .where(eq(forecastResolutionsTable.userId, TEST_USER));
    expect(rows.length).toBe(1);
  });

  it("ignores rememberPattern (no mapping rule learning, no column write)", async () => {
    const id = await insertTxn(TEST_USER, {
      description: "STARBUCKS COFFEE #221",
    });
    const categoryId = randomUUID();

    const r = await api("POST", "/transactions/bulk-update", {
      ids: [id],
      patch: {
        categoryId,
        rememberPattern: "STARBUCKS",
      },
    });
    expect(r.status).toBe(200);
    expect((r.json as BulkResult).updated).toBe(1);

    // The category was applied...
    const [row] = await db
      .select({ categoryId: transactionsTable.categoryId })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, id));
    expect(row?.categoryId).toBe(categoryId);

    // ...but no mapping rule was created from rememberPattern.
    const { mappingRulesTable } = await import("@workspace/db");
    const rules = await db
      .select()
      .from(mappingRulesTable)
      .where(eq(mappingRulesTable.userId, TEST_USER));
    expect(rules.length).toBe(0);
  });

  it("returns ownership-aware ok/error per id and affectedMonths even when patch is empty", async () => {
    const a = await insertTxn(TEST_USER, { occurredOn: "2026-03-09" });
    const b = await insertTxn(TEST_USER, { occurredOn: "2026-03-20" });
    const missing = randomUUID();

    const r = await api("POST", "/transactions/bulk-update", {
      ids: [a, missing, b],
      patch: {},
    });

    expect(r.status).toBe(200);
    const body = r.json as BulkResult;
    expect(body.updated).toBe(0);
    expect(body.affectedMonths).toEqual(["2026-03-01"]);
    const byId = Object.fromEntries(body.results.map((x) => [x.id, x]));
    expect(byId[a].ok).toBe(true);
    expect(byId[b].ok).toBe(true);
    expect(byId[missing]).toEqual({ id: missing, ok: false, error: "not found" });
  });

  it("returns an empty result when ids is empty", async () => {
    const r = await api("POST", "/transactions/bulk-update", {
      ids: [],
      patch: { reviewed: true },
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ updated: 0, results: [], affectedMonths: [] });
  });

  // (#642) Transfer-looking rows must never be tagged Unplanned via
  // bulk-update. Mixed batches succeed for the safe rows and report the
  // rejected ones per-id with `code: "unplanned_transfer_rejected"`;
  // an all-transfer batch fails the whole request with 422.
  describe("(#642) Unplanned-transfer guard", () => {
    it("rejects per-id transfer rows in a mixed bulk-update and tags only the safe rows", async () => {
      const safe = await insertTxn(TEST_USER, {
        description: "STARBUCKS COFFEE #221",
        unplannedAllowance: false,
      });
      const transfer = await insertTxn(TEST_USER, {
        description: "Online Transfer to SAV ...9128",
        unplannedAllowance: false,
      });

      const r = await api("POST", "/transactions/bulk-update", {
        ids: [safe, transfer],
        patch: { unplannedAllowance: true },
      });

      expect(r.status).toBe(200);
      const body = r.json as {
        updated: number;
        affectedMonths: string[];
        results: { id: string; ok: boolean; error: string | null; code?: string }[];
      };
      expect(body.updated).toBe(1);
      const byId = Object.fromEntries(body.results.map((x) => [x.id, x]));
      expect(byId[safe]?.ok).toBe(true);
      expect(byId[transfer]?.ok).toBe(false);
      expect(byId[transfer]?.code).toBe("unplanned_transfer_rejected");

      const rows = await db
        .select({
          id: transactionsTable.id,
          unplannedAllowance: transactionsTable.unplannedAllowance,
        })
        .from(transactionsTable)
        .where(inArray(transactionsTable.id, [safe, transfer]));
      const flagsById = Object.fromEntries(
        rows.map((r) => [r.id, r.unplannedAllowance]),
      );
      expect(flagsById[safe]).toBe(true);
      expect(flagsById[transfer]).toBe(false);
    });

    it("returns 422 when EVERY id in the batch is a transfer-looking row", async () => {
      const t1 = await insertTxn(TEST_USER, {
        description: "ONLINE PAYMENT - THANK YOU",
      });
      const t2 = await insertTxn(TEST_USER, {
        description: "ODP TRANSFER FROM CHECKING",
      });

      const r = await api("POST", "/transactions/bulk-update", {
        ids: [t1, t2],
        patch: { unplannedAllowance: true },
      });

      expect(r.status).toBe(422);
      expect((r.json as { code?: string }).code).toBe(
        "unplanned_transfer_rejected",
      );
    });
  });
});
