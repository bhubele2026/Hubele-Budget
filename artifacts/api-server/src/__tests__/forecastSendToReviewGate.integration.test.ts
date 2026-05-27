// (#762 — Phase B) Forecast pipeline gating: the Review pipeline must
// be empty until a Chase transaction is explicitly promoted via
// POST /transactions/send-to-review. These tests cover the two
// scenarios called out in the spec:
//   1. Freshly-synced Chase rows produce zero Review rows until the
//      user sends them.
//   2. Sending 3 then unsending 2 leaves exactly 1 in the Review
//      pipeline.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `forecast-send-gate-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

import {
  db,
  forecastSettingsTable,
  transactionsTable,
} from "@workspace/db";
import forecastRouter from "../routes/forecast";
import transactionsRouter from "../routes/transactions";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  next();
});
app.use(forecastRouter);
app.use(transactionsRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.householdId, TEST_HOUSEHOLD_ID));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
}

beforeAll(async () => {
  const h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = h.householdId;
  await cleanup();
  // Minimal forecast_settings row. No bankSnapshotAccountId — that
  // forces `isBankRow` to fall back to source-based detection, so
  // our seeded `source: "chase"` rows (no plaidAccountId) pass the
  // bank-checking filter.
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
  });
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await cleanup();
});

beforeEach(async () => {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.householdId, TEST_HOUSEHOLD_ID));
});

async function seedChaseTxn(description: string): Promise<string> {
  const today = new Date();
  const occurredOn = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const [row] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn,
      description,
      amount: "-12.34",
      source: "chase",
      forecastFlag: true,
      // sentToReviewAt intentionally left NULL — Phase B gate.
    })
    .returning();
  return row!.id;
}

async function reviewTxnIds(): Promise<string[]> {
  const r = await fetch(`${baseUrl}/forecast`);
  expect(r.status).toBe(200);
  const body = (await r.json()) as { transactions: { id: string }[] };
  return body.transactions.map((t) => t.id);
}

describe("/forecast Review pipeline — Send-to-Review gate (#762 Phase B)", () => {
  it("freshly-synced Chase rows produce zero Review rows until sent", async () => {
    await seedChaseTxn("Coffee A");
    await seedChaseTxn("Coffee B");
    await seedChaseTxn("Coffee C");

    expect(await reviewTxnIds()).toEqual([]);
  });

  it("sending 3 then unsending 2 leaves exactly 1 in the Review pipeline", async () => {
    const id1 = await seedChaseTxn("Coffee 1");
    const id2 = await seedChaseTxn("Coffee 2");
    const id3 = await seedChaseTxn("Coffee 3");

    expect(await reviewTxnIds()).toEqual([]);

    const sendRes = await fetch(`${baseUrl}/transactions/send-to-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transactionIds: [id1, id2, id3] }),
    });
    expect(sendRes.status).toBe(200);

    const afterSend = await reviewTxnIds();
    expect(afterSend.sort()).toEqual([id1, id2, id3].sort());

    const unsendRes = await fetch(`${baseUrl}/transactions/unsend-from-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transactionIds: [id1, id2] }),
    });
    expect(unsendRes.status).toBe(200);

    const afterUnsend = await reviewTxnIds();
    expect(afterUnsend).toEqual([id3]);
  });
});
