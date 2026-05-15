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
import { eq } from "drizzle-orm";

import { createTestHousehold } from "./_helpers/testHousehold";

// (#654) Reproduce the exact production state of the user's two real
// Chase items today: a well-formed `access-sandbox-…` token stored on
// a server whose `PLAID_ENV=production`. Plaid would reject every
// product call against this token with `INVALID_ACCESS_TOKEN`
// ("provided access token is for the wrong Plaid environment"), so
// the env-mismatch guard must short-circuit BEFORE any Plaid call is
// attempted. Force the env up front so the guard sees the same world
// the production server sees, and capture the prior value to restore
// in afterAll (vitest's singleFork pool shares process.env across
// suites).
const PRIOR_PLAID_ENV = process.env.PLAID_ENV;
process.env.PLAID_ENV = "production";

const TEST_USER = `env-mismatch-token-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

// Every Plaid product call this codepath could possibly reach is
// mocked with a vi.fn() spy that THROWS. If the guard ever regresses
// and a real call slips through, the test fails loudly with a "guard
// regressed" error instead of silently hitting Plaid (or worse, a
// different mock returning success).
const transactionsSyncSpy = vi.fn(async () => {
  throw new Error(
    "guard regressed: transactionsSync was called for an env-mismatched item",
  );
});
const accountsBalanceGetSpy = vi.fn(async () => {
  throw new Error(
    "guard regressed: accountsBalanceGet was called for an env-mismatched item",
  );
});
const itemGetSpy = vi.fn(async () => {
  throw new Error(
    "guard regressed: itemGet was called for an env-mismatched item",
  );
});
const accountsGetSpy = vi.fn(async () => {
  throw new Error(
    "guard regressed: accountsGet was called for an env-mismatched item",
  );
});
const liabilitiesGetSpy = vi.fn(async () => {
  throw new Error(
    "guard regressed: liabilitiesGet was called for an env-mismatched item",
  );
});

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>(
    "../lib/plaid",
  );
  return {
    ...actual,
    plaid: () => ({
      transactionsSync: transactionsSyncSpy,
      accountsBalanceGet: accountsBalanceGetSpy,
      itemGet: itemGetSpy,
      accountsGet: accountsGetSpy,
      liabilitiesGet: liabilitiesGetSpy,
    }),
  };
});

import {
  db,
  plaidAccountsTable,
  plaidItemsTable,
  plaidSyncAttemptsTable,
  transactionsTable,
} from "@workspace/db";
import {
  flagMalformedAccessTokens,
  refreshConsentExpirationForItem,
  syncPlaidItem,
} from "../lib/plaidSync";
import { fetchLiabilitiesForItem } from "../lib/plaidLiabilities";
import { PLAID_REAUTH_ERROR_CODES } from "../lib/plaidReauthCodes";

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
  await db
    .delete(plaidSyncAttemptsTable)
    .where(eq(plaidSyncAttemptsTable.userId, TEST_USER));
}

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  if (PRIOR_PLAID_ENV === undefined) delete process.env.PLAID_ENV;
  else process.env.PLAID_ENV = PRIOR_PLAID_ENV;
});

beforeEach(async () => {
  await cleanup();
  transactionsSyncSpy.mockClear();
  accountsBalanceGetSpy.mockClear();
  itemGetSpy.mockClear();
  accountsGetSpy.mockClear();
  liabilitiesGetSpy.mockClear();
});

async function seedEnvMismatchedItem(): Promise<{
  itemRowId: string;
  itemId: string;
}> {
  const externalItemId = `item-${randomUUID()}`;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: externalItemId,
      // Well-formed sandbox-prefixed token — passes
      // isValidPlaidAccessToken's format check, fails
      // isAccessTokenForCurrentEnv on a production server.
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "Chase",
      institutionSlug: "chase",
    })
    .returning();
  return { itemRowId: item!.id, itemId: externalItemId };
}

describe("(#654) Plaid access_token env mismatch short-circuits to needs-reconnect", () => {
  it("INVALID_ACCESS_TOKEN is treated as a reauth code so existing stuck rows light up Reconnect immediately", () => {
    expect(PLAID_REAUTH_ERROR_CODES.has("INVALID_ACCESS_TOKEN")).toBe(true);
  });

  it("syncPlaidItem on a sandbox-token / production-server item never calls /transactions/sync and writes the env-mismatch state", async () => {
    const { itemRowId, itemId } = await seedEnvMismatchedItem();

    const result = await syncPlaidItem(TEST_USER, itemRowId);

    // Zero Plaid calls — the whole guarantee of the env-mismatch guard.
    expect(transactionsSyncSpy).not.toHaveBeenCalled();
    expect(accountsBalanceGetSpy).not.toHaveBeenCalled();
    expect(itemGetSpy).not.toHaveBeenCalled();

    // Synthetic SyncResult shaped like a real Plaid reauth error so the
    // web toast / Settings chip / Avalanche page Reconnect button all
    // light up the same way they would for a Plaid-issued response.
    expect(result.itemId).toBe(itemId);
    expect(result.plaidErrorCode).toBe("INVALID_ACCESS_TOKEN");
    expect(result.kind).toBe("reauth");
    expect(result.error).toMatch(/different Plaid environment/i);
    expect(result.error).toMatch(/reconnect/i);
    expect(result.added).toBe(0);
    expect(result.modified).toBe(0);
    expect(result.removed).toBe(0);

    // Persisted columns drive the next page-load chip render and must
    // match the synthesized SyncResult.
    const [row] = await db
      .select({
        lastSyncError: plaidItemsTable.lastSyncError,
        lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
      })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.lastSyncErrorCode).toBe("INVALID_ACCESS_TOKEN");
    expect(row?.lastSyncError).toMatch(/different Plaid environment/i);
    // CRITICAL chip-leak regression: never the bare Plaid 400 string.
    expect(row?.lastSyncError).not.toMatch(/status code 400/i);

    // Audit row recorded with errorKind=reauth so the daily failure
    // counter and the Reconnect-button gating both see it.
    const attempts = await db
      .select({
        kind: plaidSyncAttemptsTable.kind,
        success: plaidSyncAttemptsTable.success,
        errorCode: plaidSyncAttemptsTable.errorCode,
        errorKind: plaidSyncAttemptsTable.errorKind,
      })
      .from(plaidSyncAttemptsTable)
      .where(eq(plaidSyncAttemptsTable.plaidItemId, itemRowId));
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    const last = attempts[attempts.length - 1]!;
    expect(last.kind).toBe("transactions");
    expect(last.success).toBe(false);
    expect(last.errorCode).toBe("INVALID_ACCESS_TOKEN");
    expect(last.errorKind).toBe("reauth");
  });

  it("refreshConsentExpirationForItem short-circuits before calling /item/get", async () => {
    const { itemRowId } = await seedEnvMismatchedItem();

    const out = await refreshConsentExpirationForItem(itemRowId);

    expect(itemGetSpy).not.toHaveBeenCalled();
    expect(out.changed).toBe(false);
    expect(out.error).toMatch(/different Plaid environment/i);

    const [row] = await db
      .select({ lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.lastSyncErrorCode).toBe("INVALID_ACCESS_TOKEN");
  });

  it("fetchLiabilitiesForItem short-circuits before calling /accounts/get or /liabilities/get", async () => {
    const { itemRowId } = await seedEnvMismatchedItem();

    const rows = await fetchLiabilitiesForItem(TEST_USER, itemRowId);

    expect(rows).toEqual([]);
    expect(accountsGetSpy).not.toHaveBeenCalled();
    expect(liabilitiesGetSpy).not.toHaveBeenCalled();

    const [row] = await db
      .select({
        lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
        lastSyncError: plaidItemsTable.lastSyncError,
      })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.lastSyncErrorCode).toBe("INVALID_ACCESS_TOKEN");
    expect(row?.lastSyncError).toMatch(/different Plaid environment/i);
  });

  it("flagMalformedAccessTokens backfills env-mismatched rows the same way it backfills truly malformed ones", async () => {
    const { itemRowId: badId } = await seedEnvMismatchedItem();

    const summary = await flagMalformedAccessTokens();

    expect(summary.scanned).toBeGreaterThanOrEqual(1);
    expect(summary.flagged).toBeGreaterThanOrEqual(1);

    const [bad] = await db
      .select({
        lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
        lastSyncError: plaidItemsTable.lastSyncError,
      })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, badId));
    expect(bad?.lastSyncErrorCode).toBe("INVALID_ACCESS_TOKEN");
    expect(bad?.lastSyncError).toMatch(/different Plaid environment/i);
  });
});
