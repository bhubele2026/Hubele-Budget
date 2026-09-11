// Badge-count endpoint (perf pass): the nav layout used to derive its
// badge integer by pulling the full /forecast bundle on every route.
// These tests pin the cheap replacement:
//   GET /forecast/review-count   — unmatched current-month bank txns

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

const TEST_USER = `badge-counts-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
  forecastResolutionsTable,
  transactionsTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import forecastRouter from "../routes/forecast";
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
  await db
    .delete(forecastResolutionsTable)
    .where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  const h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = h.householdId;
  await cleanup();
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
  await cleanup();
});

function isoInCurrentMonth(day: number): string {
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const d = Math.min(day, last);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

async function seedChecking(): Promise<{ rowId: string; externalId: string }> {
  const externalId = `acct-${randomUUID()}`;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: "test-token",
      institutionSlug: "chase",
    })
    .returning();
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalId,
      name: "Chase Checking",
    })
    .returning();
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    bankSnapshotAccountId: acct!.id,
  });
  return { rowId: acct!.id, externalId };
}

async function addTxn(opts: {
  occurredOn: string;
  amount: string;
  forecastFlag?: boolean;
  plaidAccountId?: string | null;
  source?: string;
}): Promise<string> {
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: opts.occurredOn,
      description: "row",
      amount: opts.amount,
      forecastFlag: opts.forecastFlag ?? true,
      plaidAccountId: opts.plaidAccountId ?? null,
      source: opts.source ?? "manual",
    })
    .returning({ id: transactionsTable.id });
  return t!.id;
}

describe("GET /forecast/review-count", () => {
  // Pinned mid-month so "already happened" and "still to come" both exist
  // inside the current month. Only Date is mocked — the HTTP server's timers
  // stay real.
  beforeEach(() => {
    vi.setSystemTime(new Date(2026, 4, 14, 12, 0, 0));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("counts unresolved current-month bank txns that are in the forecast, mirroring the inbox filter", async () => {
    const chase = await seedChecking();

    // Counted: checking txn + manual txn, both this month, unresolved.
    await addTxn({
      occurredOn: isoInCurrentMonth(3),
      amount: "-50",
      plaidAccountId: chase.externalId,
      source: "plaid:chase",
    });
    await addTxn({ occurredOn: isoInCurrentMonth(4), amount: "-20" });
    // Counted: already happened with its flag off. It moved real money, so it
    // belongs in Review until it is resolved (`inForecast`, 2026-09-10) —
    // before, it was invisible there while still moving the balance.
    await addTxn({
      occurredOn: isoInCurrentMonth(8),
      amount: "-10",
      forecastFlag: false,
    });
    // Counted: a future row flagged for the forecast.
    await addTxn({ occurredOn: isoInCurrentMonth(21), amount: "-15" });
    // Not counted: resolved (matched) txn.
    const resolvedId = await addTxn({
      occurredOn: isoInCurrentMonth(5),
      amount: "-30",
      plaidAccountId: chase.externalId,
      source: "plaid:chase",
    });
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      status: "matched",
      matchedTxnId: resolvedId,
    });
    // Not counted: amex-side, other plaid account, a FUTURE row with its flag
    // off (the flag still gates what hasn't happened), last month.
    await addTxn({
      occurredOn: isoInCurrentMonth(6),
      amount: "-10",
      source: "amex",
    });
    await addTxn({
      occurredOn: isoInCurrentMonth(7),
      amount: "-10",
      plaidAccountId: "someone-else",
      source: "plaid:chase",
    });
    await addTxn({
      occurredOn: isoInCurrentMonth(20),
      amount: "-10",
      forecastFlag: false,
    });
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    await addTxn({
      occurredOn: `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, "0")}-15`,
      amount: "-10",
    });

    const r = await fetch(`${baseUrl}/forecast/review-count`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ count: 4 });
  });

  it("finds the checking account from the snapshot mask when the stored pointer is missing", async () => {
    // Same resolution the balance roll-forward uses. Before, a missing pointer
    // zeroed the badge while the curve kept moving on the recovered account.
    const externalId = `acct-${randomUUID()}`;
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `item-${randomUUID()}`,
        accessToken: "test-token",
        institutionSlug: "chase",
      })
      .returning();
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalId,
      name: "Chase Checking",
      mask: "5526",
    });
    await db.insert(forecastSettingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      bankSnapshotAccountId: null,
      bankSnapshotMask: "5526",
    });
    await addTxn({
      occurredOn: isoInCurrentMonth(6),
      amount: "-40",
      plaidAccountId: externalId,
      source: "plaid:chase",
    });

    const r = await fetch(`${baseUrl}/forecast/review-count`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ count: 1 });
  });
});
