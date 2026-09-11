// ⭐ A TAP ON REFRESH COUNTS. The two balance routes re-read the bank balance
// from Plaid outside a Sync. `bankFreshness` reads `balance` attempt rows to
// decide whether the balance is stale, so these routes record one for the bank
// snapshot account, success or failure. Without them, a successful Refresh after
// a failed Sync left the balance marked "refresh failed" until the next Sync, and
// a failed Refresh was never recorded at all.
//
// The rows are written for the signed-in user (the Settings → Recent activity
// list filters on it) and carry Plaid's error kind, which the Reconnect button
// keys on. The bank here is linked by a different user on purpose.

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
import { and, asc, eq, inArray } from "drizzle-orm";

// Production tokens pass the env-match preflight, so the request reaches the
// Plaid mock whatever the runner's ambient PLAID_ENV is.
const PRIOR_PLAID_ENV = process.env.PLAID_ENV;
process.env.PLAID_ENV = "production";

const SUFFIX = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const TEST_USER = `balance-route-attempts-${SUFFIX}`;
/** The household member who linked the bank: not the one pressing Refresh. */
const LINKER = `balance-route-linker-${SUFFIX}`;
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
    .where(inArray(plaidSyncAttemptsTable.userId, [TEST_USER, LINKER]));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(inArray(plaidAccountsTable.userId, [TEST_USER, LINKER]));
  await db
    .delete(plaidItemsTable)
    .where(inArray(plaidItemsTable.userId, [TEST_USER, LINKER]));
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

/** One item, linked by LINKER, with the snapshot checking account and a second, non-snapshot account. */
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
      userId: LINKER,
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
      userId: LINKER,
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
      userId: LINKER,
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

async function balanceRowDetail(itemRowId: string) {
  const [row] = await db
    .select({
      userId: plaidSyncAttemptsTable.userId,
      errorKind: plaidSyncAttemptsTable.errorKind,
    })
    .from(plaidSyncAttemptsTable)
    .where(
      and(
        eq(plaidSyncAttemptsTable.plaidItemId, itemRowId),
        eq(plaidSyncAttemptsTable.kind, "balance"),
      ),
    );
  return row;
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
  it("a successful re-read records a balance success, for the signed-in user", async () => {
    const s = await seed();
    accountsBalanceGetMock = balanceFor(s.snapshotExternalId, 1234.56);
    expect(await post("/forecast/refresh-bank", {})).toBe(200);
    expect(await balanceRows(s.itemRowId)).toEqual([{ success: true, errorCode: null }]);
    expect((await balanceRowDetail(s.itemRowId))!.userId).toBe(TEST_USER);
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

  it("a reconnect error records a failure that carries its error kind, for the Reconnect button", async () => {
    const s = await seed();
    accountsBalanceGetMock = async () => {
      throw plaidAxiosError("ITEM_LOGIN_REQUIRED", "the login details have changed");
    };
    expect(await post("/forecast/refresh-bank", {})).toBe(409);
    expect(await balanceRows(s.itemRowId)).toEqual([
      { success: false, errorCode: "ITEM_LOGIN_REQUIRED" },
    ]);
    expect(await balanceRowDetail(s.itemRowId)).toEqual({
      userId: TEST_USER,
      errorKind: "reauth",
    });
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
  it("setting the snapshot from Plaid records a balance success, for the signed-in user", async () => {
    const s = await seed();
    accountsBalanceGetMock = balanceFor(s.snapshotExternalId, 2000);
    expect(await post("/forecast/bank-snapshot", { plaidAccountId: s.snapshotRowId })).toBe(200);
    expect(await balanceRows(s.itemRowId)).toEqual([{ success: true, errorCode: null }]);
    expect((await balanceRowDetail(s.itemRowId))!.userId).toBe(TEST_USER);
  });

  it("a failed Plaid read of the bank balance's account records a balance failure", async () => {
    const s = await seed();
    accountsBalanceGetMock = async () => {
      throw plaidAxiosError("INTERNAL_SERVER_ERROR", "Plaid had a transient outage");
    };
    expect(await post("/forecast/bank-snapshot", { plaidAccountId: s.snapshotRowId })).toBe(502);
    expect(await balanceRows(s.itemRowId)).toEqual([
      { success: false, errorCode: "INTERNAL_SERVER_ERROR" },
    ]);
  });

  it("no balance for the bank balance's account records a failure", async () => {
    const s = await seed();
    expect(await post("/forecast/bank-snapshot", { plaidAccountId: s.snapshotRowId })).toBe(502);
    expect(await balanceRows(s.itemRowId)).toEqual([
      { success: false, errorCode: "no_balance" },
    ]);
  });

  it("a failed switch to another account on the same item records nothing against the unchanged bank balance", async () => {
    const s = await seed();
    accountsBalanceGetMock = async () => {
      throw plaidAxiosError("INTERNAL_SERVER_ERROR", "Plaid had a transient outage");
    };
    expect(await post("/forecast/bank-snapshot", { plaidAccountId: s.otherRowId })).toBe(502);
    // And with no balance returned for that account either.
    accountsBalanceGetMock = async () => ({ data: { accounts: [] } });
    expect(await post("/forecast/bank-snapshot", { plaidAccountId: s.otherRowId })).toBe(502);
    expect(await balanceRows(s.itemRowId)).toEqual([]);
  });

  it("a successful switch records a success: that account is now the bank balance", async () => {
    const s = await seed();
    accountsBalanceGetMock = balanceFor(s.otherExternalId, 75);
    expect(await post("/forecast/bank-snapshot", { plaidAccountId: s.otherRowId })).toBe(200);
    expect(await balanceRows(s.itemRowId)).toEqual([{ success: true, errorCode: null }]);
  });
});
