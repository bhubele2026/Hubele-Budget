import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import { listCheckingAccounts } from "../routes/forecast";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `flca-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

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
});
afterAll(cleanup);

describe("listCheckingAccounts dedupe (#410)", () => {
  it("collapses duplicate (institutionName, mask) rows and prefers the snapshot row", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `flca-item-${suffix}`,
        accessToken: "test-no-access",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    // Three rows for the same physical account ··5526.
    const [snap] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: item!.id,
        accountId: `flca-snap-${suffix}`,
        name: "Chase Total Checking",
        mask: "5526",
        type: "depository",
        subtype: "checking",
        createdAt: new Date(Date.now() - 30_000),
      })
      .returning();
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: `flca-dup1-${suffix}`,
      name: "Chase Checking",
      mask: "5526",
      type: "depository",
      subtype: "checking",
      createdAt: new Date(Date.now() - 10_000),
    });
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: `flca-dup2-${suffix}`,
      name: "Chase Checking",
      mask: "5526",
      type: "depository",
      subtype: "checking",
      createdAt: new Date(),
    });
    // A separate ··2222 account that must survive untouched.
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: `flca-other-${suffix}`,
      name: "Chase Joint Checking",
      mask: "2222",
      type: "depository",
      subtype: "checking",
    });
    await db.insert(forecastSettingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      bankSnapshotAccountId: snap!.id,
    });

    const accounts = await listCheckingAccounts(TEST_USER, TEST_HOUSEHOLD_ID, TEST_USER);
    // ··5526 collapses to one row, ··2222 stays — total 2.
    expect(accounts.length).toBe(2);
    const masks = accounts.map((a) => a.mask).sort();
    expect(masks).toEqual(["2222", "5526"]);
    const fiveTwoSix = accounts.find((a) => a.mask === "5526");
    // Snapshot row wins as the survivor.
    expect(fiveTwoSix!.id).toBe(snap!.id);
  });
});
