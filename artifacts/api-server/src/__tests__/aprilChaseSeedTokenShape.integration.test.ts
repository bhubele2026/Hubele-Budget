import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  forecastSettingsTable,
  mappingRulesTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import {
  seedAprilChase,
  SYNTHETIC_CHASE_SEED_ACCESS_TOKEN,
  SYNTHETIC_ITEM_ID,
} from "../lib/aprilChaseSeed";
import { isValidPlaidAccessToken, isSyntheticPlaidItem } from "../lib/plaid";
import { flagMalformedAccessTokens } from "../lib/plaidSync";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `seed-token-shape-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(mappingRulesTable)
    .where(eq(mappingRulesTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  await cleanup();
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
});
afterAll(cleanup);

describe("(#398) aprilChaseSeed writes a well-formed placeholder access_token", () => {
  it("the placeholder constant itself passes isValidPlaidAccessToken", () => {
    // Belt-and-suspenders: if anyone edits the constant to something
    // that no longer matches the validator, this fails immediately
    // instead of waiting for the full seed/scan cycle below.
    expect(isValidPlaidAccessToken(SYNTHETIC_CHASE_SEED_ACCESS_TOKEN)).toBe(
      true,
    );
  });

  it("seeding into an empty user materializes the synthetic plaid_item with an access_token that passes the validator and is still classified synthetic", async () => {
    await seedAprilChase(TEST_USER, TEST_HOUSEHOLD_ID);

    // The synthetic seed row is keyed by a globally-unique itemId
    // (`seed-april-2026-chase`), not per-user — earlier seed runs from
    // sibling test suites can leave the row behind, and the seed code
    // takes the existing row instead of inserting a duplicate. Look it
    // up by itemId so this test exercises the freshly-written shape
    // regardless of which user materialized the row first.
    const [item] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.itemId, SYNTHETIC_ITEM_ID));

    expect(item).toBeTruthy();
    expect(item!.itemId).toBe(SYNTHETIC_ITEM_ID);
    // Passes the malformed-token guard so the boot scan won't "rescue" it.
    expect(isValidPlaidAccessToken(item!.accessToken)).toBe(true);
    // Still classified synthetic via the `seed-` itemId prefix so
    // sync/consent/items routes skip it.
    expect(isSyntheticPlaidItem(item!)).toBe(true);
    // No leftover needs-reconnect chip from a prior code path.
    expect(item!.lastSyncErrorCode).toBeNull();
    expect(item!.lastSyncError).toBeNull();
  });

  it("the boot-time malformed-token sweep does NOT flag a freshly-seeded synthetic Chase row", async () => {
    // Run sweep AFTER the seed above. Even if the sweep ever stops
    // honoring isSyntheticPlaidItem, the well-formed token alone
    // would keep this row out of the flagged set.
    const summary = await flagMalformedAccessTokens();

    const [item] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.itemId, SYNTHETIC_ITEM_ID));
    expect(item).toBeTruthy();

    expect(
      summary.flaggedItems.find((f) => f.itemRowId === item!.id),
    ).toBeUndefined();

    const [after] = await db
      .select({
        lastSyncErrorCode: plaidItemsTable.lastSyncErrorCode,
        lastSyncError: plaidItemsTable.lastSyncError,
      })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, item!.id));
    expect(after?.lastSyncErrorCode).toBeNull();
    expect(after?.lastSyncError).toBeNull();
  });
});
