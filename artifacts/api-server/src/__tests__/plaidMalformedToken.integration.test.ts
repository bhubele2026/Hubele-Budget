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

const TEST_USER = `malformed-token-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

// (#366) The whole point of this file is to prove zero Plaid calls
// happen for a malformed-token sync. We mock every product call this
// codepath could possibly reach with a vi.fn() spy that THROWS — that
// way if the guard ever regresses and a real call slips through, the
// test fails with a loud "guard regressed" message instead of silently
// hitting Plaid (or worse, a different mock returning success).
const transactionsSyncSpy = vi.fn(async () => {
  throw new Error(
    "guard regressed: transactionsSync was called for a malformed-token item",
  );
});
const accountsBalanceGetSpy = vi.fn(async () => {
  throw new Error(
    "guard regressed: accountsBalanceGet was called for a malformed-token item",
  );
});
const itemGetSpy = vi.fn(async () => {
  throw new Error(
    "guard regressed: itemGet was called for a malformed-token item",
  );
});
const accountsGetSpy = vi.fn(async () => {
  throw new Error(
    "guard regressed: accountsGet was called for a malformed-token item",
  );
});
const liabilitiesGetSpy = vi.fn(async () => {
  throw new Error(
    "guard regressed: liabilitiesGet was called for a malformed-token item",
  );
});
const linkTokenCreateSpy = vi.fn(async () => {
  throw new Error(
    "guard regressed: linkTokenCreate was called for a malformed-token item",
  );
});
const itemRemoveSpy = vi.fn(async () => {
  throw new Error(
    "guard regressed: itemRemove was called for a malformed-token item",
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
      linkTokenCreate: linkTokenCreateSpy,
      itemRemove: itemRemoveSpy,
    }),
  };
});

import {
  db,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import {
  flagMalformedAccessTokens,
  refreshConsentExpirationForItem,
  syncPlaidItem,
} from "../lib/plaidSync";
import { fetchLiabilitiesForItem } from "../lib/plaidLiabilities";

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
  await cleanup();
});
afterAll(cleanup);

beforeEach(async () => {
  await cleanup();
  transactionsSyncSpy.mockClear();
  accountsBalanceGetSpy.mockClear();
  itemGetSpy.mockClear();
  accountsGetSpy.mockClear();
  liabilitiesGetSpy.mockClear();
  linkTokenCreateSpy.mockClear();
  itemRemoveSpy.mockClear();
});

async function seedMalformedItem(
  accessToken: string,
): Promise<{ itemRowId: string; itemId: string }> {
  const externalItemId = `item-${randomUUID()}`;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: externalItemId,
      accessToken,
      institutionName: "Chase",
      institutionSlug: "chase",
    })
    .returning();
  return { itemRowId: item!.id, itemId: externalItemId };
}

describe("(#366) malformed Plaid access_token short-circuits to needs-reconnect", () => {
  it.each([
    ["empty string", ""],
    ["bad prefix", "bad-token"],
    ["JSON-stringified token", '"access-production-abc"'],
    ["unknown env segment", "access-staging-abc123"],
    ["truncated to prefix only", "access-production-"],
  ])(
    "syncPlaidItem with %s never calls /transactions/sync and writes the synthetic ITEM_LOGIN_REQUIRED state",
    async (_label, badToken) => {
      const { itemRowId, itemId } = await seedMalformedItem(badToken);

      const result = await syncPlaidItem(TEST_USER, itemRowId);

      // Zero Plaid calls — the whole guarantee of #366.
      expect(transactionsSyncSpy).not.toHaveBeenCalled();
      expect(accountsBalanceGetSpy).not.toHaveBeenCalled();
      expect(itemGetSpy).not.toHaveBeenCalled();

      // Synthetic SyncResult shaped like a real reauth error so the web
      // toast / Settings chip / mobile reconnect banner all light up
      // exactly as they would for a Plaid-issued ITEM_LOGIN_REQUIRED.
      expect(result.itemId).toBe(itemId);
      expect(result.plaidErrorCode).toBe("ITEM_LOGIN_REQUIRED");
      expect(result.kind).toBe("reauth");
      expect(result.error).toMatch(/reconnect/i);
      expect(result.added).toBe(0);
      expect(result.modified).toBe(0);
      expect(result.removed).toBe(0);

      // Persisted columns drive the next page-load chip render.
      const [row] = await db
        .select({
          lastSyncError: plaidItemsTable.lastSyncError,
          lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
        })
        .from(plaidItemsTable)
        .where(eq(plaidItemsTable.id, itemRowId));
      expect(row?.lastSyncErrorCode).toBe("ITEM_LOGIN_REQUIRED");
      expect(row?.lastSyncError).toMatch(/reconnect/i);
      // CRITICAL chip-leak regression: never the bare Plaid 400 string.
      expect(row?.lastSyncError).not.toMatch(/status code 400/i);
    },
  );

  it("refreshConsentExpirationForItem short-circuits before calling /item/get", async () => {
    const { itemRowId } = await seedMalformedItem("not-a-token");

    const out = await refreshConsentExpirationForItem(itemRowId);

    expect(itemGetSpy).not.toHaveBeenCalled();
    expect(out.changed).toBe(false);
    expect(out.error).toMatch(/reconnect/i);

    const [row] = await db
      .select({ lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.lastSyncErrorCode).toBe("ITEM_LOGIN_REQUIRED");
  });

  it("fetchLiabilitiesForItem short-circuits before calling /accounts/get or /liabilities/get", async () => {
    const { itemRowId } = await seedMalformedItem("garbage");

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
    expect(row?.lastSyncErrorCode).toBe("ITEM_LOGIN_REQUIRED");
    expect(row?.lastSyncError).toMatch(/reconnect/i);
  });

  it("flagMalformedAccessTokens backfills pre-existing bad rows on boot", async () => {
    const { itemRowId: badId } = await seedMalformedItem("legacy-bad-row");
    // (#654) Use a token whose env prefix matches the server's
    // PLAID_ENV so the env-mismatch guard added in #654 doesn't also
    // flag this "good" row. Without this, a sandbox-prefixed token on
    // a non-sandbox test runner gets correctly flagged as INVALID_ACCESS_TOKEN
    // by the new sweep, which would break the negative assertion below.
    // Lowercased because Plaid's token prefix is always lowercase
    // (`access-sandbox-…` / `access-production-…`) even when PLAID_ENV
    // is configured with mixed case (e.g. "Production").
    const env = (process.env.PLAID_ENV ?? "sandbox").toLowerCase();
    const { itemRowId: goodId } = await seedMalformedItem(
      `access-${env}-${randomUUID()}`,
    );

    const summary = await flagMalformedAccessTokens();

    expect(summary.scanned).toBeGreaterThanOrEqual(2);
    expect(summary.flagged).toBeGreaterThanOrEqual(1);

    const [bad] = await db
      .select({ lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, badId));
    expect(bad?.lastSyncErrorCode).toBe("ITEM_LOGIN_REQUIRED");

    // The well-formed row must NOT be flagged.
    const [good] = await db
      .select({ lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, goodId));
    expect(good?.lastSyncErrorCode).toBeNull();
  });
});
