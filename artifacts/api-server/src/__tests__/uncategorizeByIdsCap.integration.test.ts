import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
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
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";

// Server boot + `request()` client come from the shared helper (it owns the
// beforeAll/afterAll for the listener); this file only owns household + cleanup.
const { request: api } = createTestApp(transactionsRouter);

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

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
