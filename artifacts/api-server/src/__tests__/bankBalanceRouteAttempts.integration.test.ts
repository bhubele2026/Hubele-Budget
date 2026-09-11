// ⭐ A TAP ON REFRESH COUNTS. The two balance routes re-read the bank balance
// from Plaid outside a Sync. `bankFreshness` reads `balance` attempt rows to
// decide whether the balance is stale, so these routes record one for the bank
// snapshot account, success or failure. Without them, a successful Refresh after
// a failed Sync left the balance marked "refresh failed" until the next Sync, and
// a failed Refresh was never recorded at all.

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
import { and, asc, eq } from "drizzle-orm";

// Production tokens pass the env-match preflight, so the request reaches the
// Plaid mock whatever the runner's ambient PLAID_ENV is.
const PRIOR_PLAID_ENV = process.env.PLAID_ENV;
process.env.PLAID_ENV = "production";

const TEST_USER = `balance-route-attempts-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

let accountsBalanceGetMock: () => Promise<unknown> = async () => ({
  data: { accounts: [] },
});

vi.mock("../lib/plaid", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      accountsBalanceGet: () => accountsBalanceGetMock(),
    }),
  };
});

import {
  db,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  plaidSyncAttemptsTable,
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
    .delete(plaidSyncAttemptsTable)
    .where(eq(plaidSyncAttemptsTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
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
  if (PRIOR_PLAID_ENV === undefined) delete process.env.PLAID_ENV;
  else process.env.PLAID_ENV = PRIOR_PLAID_ENV;
});

beforeEach(async () => {
  await cleanup();
  accountsBalanceGetMock = async () => ({ data: { accounts: [] } });
});

/** One item with the snapshot checking account and a second, non-snapshot account. */
async function seed(): Promise<{
  itemRowId: string;
  snapshotRowId: string;
  snapshotExternalId: string;
  otherRowId: string;
  otherExternalId: string;
}> {
  const snapshotExternalId = `acct-${randomUUID()}`;
  const otherExternalId = `acct-${randomUUID()}`;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: `access-production-${randomUUID()}`,
      institutionName: "Chase",
      institutionSlug: "chase",
    })
    .returning();
  const [snapshot] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: snapshotExternalId,
      name: "Chase Checking",
      mask: "9876",
      type: "depository",
      subtype: "checking",
    })
    .returning();
  const [other] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: otherExternalId,
      name: "Chase Savings",
      mask: "1234",
      type: "depository",
      subtype: "savings",
    })
    .returning();
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    bankSnapshotAccountId: snapshot!.id,
    bankSnapshotName: "Chase Checking",
    bankSnapshotMask: "9876",
    bankSnapshotBalance: "1000.00",
    bankSnapshotAt: new Date("2026-09-01T17:00:00Z"),
    bankSnapshotSource: "plaid",
  });
  return {
    itemRowId: item!.id,
    snapshotRowId: snapshot!.id,
    snapshotExternalId,
    otherRowId: other!.id,
    otherExternalId,
  };
}

function balanceFor(externalId: string, available: number) {
  return async () => ({
    data: {
      accounts: [
        { account_id: externalId, balances: { available, current: available + 50 } },
      ],
    },
  });
}

function plaidAxiosError(code: string, message: string): Error {
  const err = new Error("plaid threw") as Error & {
    response?: { status: number; data: { error_code: string; error_message: string } };
  };
  err.response = { status: 400, data: { error_code: code, error_message: message } };
  return err;
}

async function balanceRows(itemRowId: string) {
  return db
    .select({
      success: plaidSyncAttemptsTable.success,
      errorCode: plaidSyncAttemptsTable.errorCode,
    })
    .from(plaidSyncAttemptsTable)
    .where(
      and(
        eq(plaidSyncAttemptsTable.plaidItemId, itemRowId),
        eq(plaidSyncAttemptsTable.kind, "balance"),
      ),
    )
    .orderBy(asc(plaidSyncAttemptsTable.attemptedAt));
}

async function post(path: string, body: unknown): Promise<number> {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await r.text();
  return r.status;
}

describe("POST /forecast/refresh-bank records the snapshot account's balance re-read", () => {
  it("a successful re-read records a balance success", async () => {
    const s = await seed();
    accountsBalanceGetMock = balanceFor(s.snapshotExternalId, 1234.56);
    expect(await post("/forecast/refresh-bank", {})).toBe(200);
    expect(await balanceRows(s.itemRowId)).toEqual([{ success: true, errorCode: null }]);
  });

  it("a Plaid outage records a balance failure with Plaid's code", async () => {
    const s = await seed();
    accountsBalanceGetMock = async () => {
      throw plaidAxiosError("INTERNAL_SERVER_ERROR", "Plaid had a transient outage");
    };
    expect(await post("/forecast/refresh-bank", {})).toBe(502);
    expect(await balanceRows(s.itemRowId)).toEqual([
      { success: false, errorCode: "INTERNAL_SERVER_ERROR" },
    ]);
  });

  it("a reconnect error records a failure too", async () => {
    const s = await seed();
    accountsBalanceGetMock = async () => {
      throw plaidAxiosError("ITEM_LOGIN_REQUIRED", "the login details have changed");
    };
    expect(await post("/forecast/refresh-bank", {})).toBe(409);
    expect(await balanceRows(s.itemRowId)).toEqual([
      { success: false, errorCode: "ITEM_LOGIN_REQUIRED" },
    ]);
  });

  it("no balance from Plaid records a failure", async () => {
    const s = await seed();
    expect(await post("/forecast/refresh-bank", {})).toBe(502);
    expect(await balanceRows(s.itemRowId)).toEqual([
      { success: false, errorCode: "no_balance" },
    ]);
  });

  it("re-reading a different account on the same item records nothing: it is not the bank balance", async () => {
    const s = await seed();
    accountsBalanceGetMock = balanceFor(s.otherExternalId, 50);
    expect(await post("/forecast/refresh-bank", { plaidAccountId: s.otherRowId })).toBe(200);
    expect(await balanceRows(s.itemRowId)).toEqual([]);
  });
});

describe("POST /forecast/bank-snapshot records the Plaid read that sets the snapshot", () => {
  it("setting the snapshot from Plaid records a balance success", async () => {
    const s = await seed();
    accountsBalanceGetMock = balanceFor(s.snapshotExternalId, 2000);
    expect(await post("/forecast/bank-snapshot", { plaidAccountId: s.snapshotRowId })).toBe(200);
    expect(await balanceRows(s.itemRowId)).toEqual([{ success: true, errorCode: null }]);
  });

  it("a failed Plaid read records a balance failure", async () => {
    const s = await seed();
    accountsBalanceGetMock = async () => {
      throw plaidAxiosError("INTERNAL_SERVER_ERROR", "Plaid had a transient outage");
    };
    expect(await post("/forecast/bank-snapshot", { plaidAccountId: s.snapshotRowId })).toBe(502);
    expect(await balanceRows(s.itemRowId)).toEqual([
      { success: false, errorCode: "INTERNAL_SERVER_ERROR" },
    ]);
  });

  it("no balance from Plaid records a failure", async () => {
    const s = await seed();
    expect(await post("/forecast/bank-snapshot", { plaidAccountId: s.snapshotRowId })).toBe(502);
    expect(await balanceRows(s.itemRowId)).toEqual([
      { success: false, errorCode: "no_balance" },
    ]);
  });
});
