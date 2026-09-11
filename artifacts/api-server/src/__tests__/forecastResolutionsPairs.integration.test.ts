// ⭐ PR5 — pair-level resolutions: "Not this" (`not_match`) and `partial`.
//
// The resolutions route keeps one resolution per plan occurrence and one per
// bank row by deleting "neighbours" before each insert. A "Not this" answer is
// about a single suggested plan/row PAIR, so that delete used to wipe it the
// moment the user decided anything else about either side — and a rejected
// suggestion would come back. These tests pin the narrowed delete and the
// review count's treatment of `not_match`.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `res-pairs-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
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

import { db, forecastResolutionsTable, transactionsTable } from "@workspace/db";
import forecastRouter from "../routes/forecast";
import { computeReviewCount } from "../lib/reviewCount";
import { householdTodayISO } from "../lib/householdClock";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(forecastRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.householdId, TEST_HOUSEHOLD_ID));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(async () => {
  await cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(cleanup);

type Body = { recurringItemId?: string; occurrenceDate?: string; status: string; matchedTxnId?: string };
const post = (body: Body) =>
  fetch(`${baseUrl}/forecast/resolutions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const stored = async () =>
  (await db.select().from(forecastResolutionsTable).where(eq(forecastResolutionsTable.householdId, TEST_HOUSEHOLD_ID)))
    .map((r) => `${r.status}:${r.recurringItemId ?? "-"}|${r.occurrenceDate ?? "-"}#${r.matchedTxnId ?? "-"}`)
    .sort();

const WATER = { recurringItemId: "water-item", occurrenceDate: "2026-05-10" };
const RENT = { recurringItemId: "rent-item", occurrenceDate: "2026-05-01" };
const A = randomUUID();
const B = randomUUID();
const key = (plan: typeof WATER, txn: string, status: string) =>
  `${status}:${plan.recurringItemId}|${plan.occurrenceDate}#${txn}`;

describe("(PR5) pair-level resolutions", () => {
  it("not_match and partial need a plan occurrence and a bank row", async () => {
    expect((await post({ status: "not_match", matchedTxnId: A })).status).toBe(400);
    expect((await post({ ...WATER, status: "partial" })).status).toBe(400);
    expect(await stored()).toEqual([]);
  });

  it("a rejected pair survives matching the same plan to another row", async () => {
    expect((await post({ ...WATER, status: "not_match", matchedTxnId: A })).status).toBe(200);
    expect((await post({ ...WATER, status: "matched", matchedTxnId: B })).status).toBe(200);
    expect(await stored()).toEqual([key(WATER, B, "matched"), key(WATER, A, "not_match")].sort());
  });

  it("a rejected pair survives another decision about the same row", async () => {
    await post({ ...WATER, status: "not_match", matchedTxnId: A });
    await post({ status: "ignored_unforecasted", matchedTxnId: A });
    await post({ ...RENT, status: "matched", matchedTxnId: A });
    expect(await stored()).toEqual([key(RENT, A, "matched"), key(WATER, A, "not_match")].sort());
  });

  it("repeating a rejection replaces only that pair; rejecting another row adds a second", async () => {
    await post({ ...WATER, status: "not_match", matchedTxnId: A });
    await post({ ...WATER, status: "not_match", matchedTxnId: A });
    await post({ ...WATER, status: "not_match", matchedTxnId: B });
    expect(await stored()).toEqual([key(WATER, A, "not_match"), key(WATER, B, "not_match")].sort());
  });

  it("confirming a pair the user had rejected clears that rejection", async () => {
    await post({ ...WATER, status: "not_match", matchedTxnId: A });
    await post({ ...WATER, status: "matched", matchedTxnId: A });
    expect(await stored()).toEqual([key(WATER, A, "matched")]);
  });

  it("a partial confirm replaces an earlier match of the plan, like matched does", async () => {
    await post({ ...WATER, status: "matched", matchedTxnId: A });
    await post({ ...WATER, status: "partial", matchedTxnId: B });
    expect(await stored()).toEqual([key(WATER, B, "partial")]);
  });

  it("unchanged: one resolution per plan occurrence and one per row for every other status", async () => {
    await post({ ...WATER, status: "matched", matchedTxnId: A });
    await post({ ...WATER, status: "matched", matchedTxnId: B });
    expect(await stored()).toEqual([key(WATER, B, "matched")]);
    await post({ ...RENT, status: "matched", matchedTxnId: B });
    expect(await stored()).toEqual([key(RENT, B, "matched")]);
    await post({ ...RENT, status: "missed" });
    expect(await stored()).toEqual(["missed:rent-item|2026-05-01#-"]);
  });
});

describe("(PR5) review count and not_match", () => {
  async function bankRowToday(): Promise<string> {
    const [row] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: householdTodayISO(),
        description: "CITY WATER",
        amount: "-150.00",
        source: "manual",
      })
      .returning({ id: transactionsTable.id });
    return row!.id;
  }

  it("a row whose only resolution is 'Not this' still needs review; matching it resolves it", async () => {
    const txn = await bankRowToday();
    expect(await computeReviewCount(TEST_HOUSEHOLD_ID, TEST_USER)).toBe(1);
    await post({ ...WATER, status: "not_match", matchedTxnId: txn });
    expect(await computeReviewCount(TEST_HOUSEHOLD_ID, TEST_USER)).toBe(1);
    await post({ ...RENT, status: "matched", matchedTxnId: txn });
    expect(await computeReviewCount(TEST_HOUSEHOLD_ID, TEST_USER)).toBe(0);
  });
});
