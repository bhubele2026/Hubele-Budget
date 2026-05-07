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

const TEST_USER = `synthetic-seed-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

// (#398) Synthetic seed rows (the April-2026 Chase placeholder created
// by aprilChaseSeed.ts before the user has completed real Plaid OAuth)
// must never reach Plaid and must never be flagged as malformed by the
// daily backfill / sweep — they are not a real connection. Mock every
// Plaid product call this codepath could touch with a spy that THROWS;
// any regression that lets a synthetic row hit Plaid surfaces as a
// loud test failure instead of a silent breach.
const transactionsSyncSpy = vi.fn(async () => {
  throw new Error("regression: transactionsSync called for synthetic seed item");
});
const itemGetSpy = vi.fn(async () => {
  throw new Error("regression: itemGet called for synthetic seed item");
});
const accountsBalanceGetSpy = vi.fn(async () => {
  throw new Error("regression: accountsBalanceGet called for synthetic seed item");
});

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>(
    "../lib/plaid",
  );
  return {
    ...actual,
    plaid: () => ({
      transactionsSync: transactionsSyncSpy,
      itemGet: itemGetSpy,
      accountsBalanceGet: accountsBalanceGetSpy,
    }),
  };
});

import { db, plaidItemsTable } from "@workspace/db";
import {
  flagMalformedAccessTokens,
  refreshConsentExpirationForItem,
  syncPlaidItem,
} from "../lib/plaidSync";
import { SYNTHETIC_PLAID_ACCESS_TOKEN_SENTINEL } from "../lib/plaid";

async function cleanup(): Promise<void> {
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(cleanup);
afterAll(cleanup);
beforeEach(async () => {
  await cleanup();
  transactionsSyncSpy.mockClear();
  itemGetSpy.mockClear();
  accountsBalanceGetSpy.mockClear();
});

async function seedSyntheticItem(opts?: {
  itemId?: string;
  accessToken?: string;
}): Promise<{ itemRowId: string; itemId: string }> {
  const externalItemId = opts?.itemId ?? `seed-${randomUUID()}`;
  const accessToken = opts?.accessToken ?? SYNTHETIC_PLAID_ACCESS_TOKEN_SENTINEL;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      itemId: externalItemId,
      accessToken,
      institutionName: "Chase",
      institutionSlug: "chase",
    })
    .returning();
  return { itemRowId: item!.id, itemId: externalItemId };
}

describe("(#398) synthetic seed plaid_items rows are inert", () => {
  it("syncPlaidItem is a no-op for a sentinel-token seed row — no Plaid call, no error chip written", async () => {
    const { itemRowId, itemId } = await seedSyntheticItem();

    const result = await syncPlaidItem(TEST_USER, itemRowId);

    expect(transactionsSyncSpy).not.toHaveBeenCalled();
    expect(itemGetSpy).not.toHaveBeenCalled();
    expect(accountsBalanceGetSpy).not.toHaveBeenCalled();

    expect(result.itemId).toBe(itemId);
    expect(result.added).toBe(0);
    expect(result.modified).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.error).toBeNull();
    expect(result.plaidErrorCode ?? null).toBeNull();

    const [row] = await db
      .select({
        lastSyncError: plaidItemsTable.lastSyncError,
        lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
      })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.lastSyncError).toBeNull();
    expect(row?.lastSyncErrorCode).toBeNull();
  });

  it("syncPlaidItem also no-ops for an item whose itemId starts with 'seed-' even if the token has been mutated", async () => {
    const { itemRowId } = await seedSyntheticItem({
      itemId: "seed-april-2026-chase",
      accessToken: "garbage-after-manual-edit",
    });

    const result = await syncPlaidItem(TEST_USER, itemRowId);

    expect(transactionsSyncSpy).not.toHaveBeenCalled();
    expect(result.error).toBeNull();
    const [row] = await db
      .select({ lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.lastSyncErrorCode).toBeNull();
  });

  it("refreshConsentExpirationForItem skips synthetic seeds — no /item/get, no malformed-token mark", async () => {
    const { itemRowId } = await seedSyntheticItem();

    const out = await refreshConsentExpirationForItem(itemRowId);

    expect(itemGetSpy).not.toHaveBeenCalled();
    expect(out.changed).toBe(false);
    expect(out.error).toBeNull();

    const [row] = await db
      .select({ lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(row?.lastSyncErrorCode).toBeNull();
  });

  it("flagMalformedAccessTokens does NOT count synthetic seed rows in its flagged set", async () => {
    const { itemRowId: seedId } = await seedSyntheticItem();

    const summary = await flagMalformedAccessTokens();

    expect(summary.flaggedItems.find((f) => f.itemRowId === seedId)).toBeUndefined();
    const [row] = await db
      .select({ lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, seedId));
    expect(row?.lastSyncErrorCode).toBeNull();
  });
});
