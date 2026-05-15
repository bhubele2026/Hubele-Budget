// (#655) Catch-path translation for the forecast balance-refresh
// endpoints. The preflight token guards (#654) cover the common
// stuck-token case before any Plaid call is attempted, but Plaid can
// still surface a reauth-class error (e.g. INVALID_ACCESS_TOKEN after
// a server credential rotation) at runtime — those must translate to
// the same 409 + `action: "relink"` shape the preflight produces, not
// a generic 502, so the Reconnect button's recovery path is consistent
// everywhere.

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

// Pin PLAID_ENV so the seeded `access-production-…` tokens pass the
// env-match preflight and the request actually reaches the Plaid mock
// (and our catch block) regardless of what the test runner's ambient
// PLAID_ENV happens to be.
const PRIOR_PLAID_ENV = process.env.PLAID_ENV;
process.env.PLAID_ENV = "production";

const TEST_USER = `forecast-relink-catch-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
} from "@workspace/db";
import forecastRouter from "../routes/forecast";
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

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
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

async function seed(): Promise<{
  itemRowId: string;
  plaidAccountRowId: string;
  externalAccountId: string;
}> {
  const externalAccountId = `acct-${randomUUID()}`;
  // Use a production-prefixed token so the env-mismatch preflight does
  // NOT short-circuit before the catch block can be exercised.
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
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalAccountId,
      name: "Chase Checking",
      mask: "9876",
      type: "depository",
      subtype: "checking",
    })
    .returning();
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    bankSnapshotAccountId: acct!.id,
    bankSnapshotName: "Chase Checking",
    bankSnapshotMask: "9876",
    bankSnapshotBalance: "1000.00",
    bankSnapshotAt: new Date("2026-01-01T00:00:00Z"),
    bankSnapshotSource: "manual",
  });
  return {
    itemRowId: item!.id,
    plaidAccountRowId: acct!.id,
    externalAccountId,
  };
}

function plaidAxiosError(code: string, message: string): Error {
  const err = new Error("plaid threw") as Error & {
    response?: {
      status: number;
      data: { error_code: string; error_message: string };
    };
  };
  err.response = {
    status: 400,
    data: { error_code: code, error_message: message },
  };
  return err;
}

describe("(#655) forecast balance-refresh catch translates Plaid reauth codes to 409 + relink", () => {
  it("/forecast/refresh-bank: INVALID_ACCESS_TOKEN at runtime → 409 + action:relink + account + persisted malformed-token chip", async () => {
    const { itemRowId } = await seed();
    accountsBalanceGetMock = async () => {
      throw plaidAxiosError(
        "INVALID_ACCESS_TOKEN",
        "the provided access token is invalid",
      );
    };

    const r = await fetch(`${baseUrl}/forecast/refresh-bank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(409);
    const body = (await r.json()) as {
      error: string;
      code: string;
      action: string;
      account: { name: string | null; mask: string | null };
    };
    expect(body.code).toBe("INVALID_ACCESS_TOKEN");
    expect(body.action).toBe("relink");
    expect(body.error).toMatch(/access token/i);
    expect(body.account).toEqual({ name: "Chase Checking", mask: "9876" });

    const [item] = await db
      .select({
        lastSyncError: plaidItemsTable.lastSyncError,
        lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
      })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(item!.lastSyncErrorCode).toBe("INVALID_ACCESS_TOKEN");
    expect(item!.lastSyncError).toMatch(/access token/i);
  });

  it("/forecast/refresh-bank: ITEM_LOGIN_REQUIRED at runtime → 409 + action:relink", async () => {
    await seed();
    accountsBalanceGetMock = async () => {
      throw plaidAxiosError(
        "ITEM_LOGIN_REQUIRED",
        "the login details have changed",
      );
    };

    const r = await fetch(`${baseUrl}/forecast/refresh-bank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { code: string; action: string };
    expect(body.code).toBe("ITEM_LOGIN_REQUIRED");
    expect(body.action).toBe("relink");
  });

  it("/forecast/refresh-bank: non-reauth Plaid errors still surface as 502 (no false relink prompt)", async () => {
    await seed();
    accountsBalanceGetMock = async () => {
      throw plaidAxiosError(
        "INTERNAL_SERVER_ERROR",
        "Plaid had a transient outage",
      );
    };

    const r = await fetch(`${baseUrl}/forecast/refresh-bank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(502);
    const body = (await r.json()) as { error: string; action?: string };
    expect(body.action).toBeUndefined();
    expect(body.error).toBeTruthy();
  });

  it("/forecast/bank-snapshot: INVALID_ACCESS_TOKEN at runtime → 409 + action:relink", async () => {
    const { plaidAccountRowId, itemRowId } = await seed();
    accountsBalanceGetMock = async () => {
      throw plaidAxiosError(
        "INVALID_ACCESS_TOKEN",
        "the provided access token is invalid",
      );
    };

    const r = await fetch(`${baseUrl}/forecast/bank-snapshot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plaidAccountId: plaidAccountRowId }),
    });
    expect(r.status).toBe(409);
    const body = (await r.json()) as {
      code: string;
      action: string;
      account: { name: string | null; mask: string | null };
    };
    expect(body.code).toBe("INVALID_ACCESS_TOKEN");
    expect(body.action).toBe("relink");
    expect(body.account).toEqual({ name: "Chase Checking", mask: "9876" });

    const [item] = await db
      .select({ lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(item!.lastSyncErrorCode).toBe("INVALID_ACCESS_TOKEN");
  });
});
