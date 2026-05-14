import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { db, plaidAccountsTable, plaidItemsTable } from "@workspace/db";
import { backfillOrphanPlaidItems } from "../lib/plaidOrphanItemCleanup";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `orphan-bf-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const OTHER_USER = `orphan-bf-other-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;
let OTHER_HOUSEHOLD_ID: string;

async function cleanup(): Promise<void> {
  for (const u of [TEST_USER, OTHER_USER]) {
    await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, u));
    await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, u));
  }
}

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
  const _o = await createTestHousehold(OTHER_USER);
  OTHER_HOUSEHOLD_ID = _o.householdId;
});
beforeEach(cleanup);
afterAll(cleanup);

async function insertItem(opts: {
  user: string;
  household: string;
  institutionId?: string | null;
  institutionSlug?: string | null;
  institutionName?: string | null;
  tokenPrefix?: "access-sandbox-" | "broken-";
}) {
  const prefix = opts.tokenPrefix ?? "access-sandbox-";
  const [row] = await db
    .insert(plaidItemsTable)
    .values({
      userId: opts.user,
      householdId: opts.household,
      itemId: `item-${randomUUID().slice(0, 8)}`,
      accessToken:
        prefix === "access-sandbox-"
          ? `access-sandbox-${randomUUID()}`
          : "broken-token-no-prefix",
      institutionId: opts.institutionId ?? "ins_56",
      institutionSlug: opts.institutionSlug ?? "chase",
      institutionName: opts.institutionName ?? "Chase",
    })
    .returning();
  return row;
}

async function attachAccount(itemRowId: string, userId: string, householdId: string) {
  await db.insert(plaidAccountsTable).values({
    userId,
    householdId,
    itemId: itemRowId,
    accountId: `acct-${randomUUID().slice(0, 8)}`,
    name: "Total Checking",
    mask: "5526",
    type: "depository",
    subtype: "checking",
  });
}

async function userItemIds(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: plaidItemsTable.id })
    .from(plaidItemsTable)
    .where(eq(plaidItemsTable.userId, userId));
  return new Set(rows.map((r) => r.id));
}

const SILENT_LOG = { info: () => {}, warn: () => {} };

function runScoped() {
  return backfillOrphanPlaidItems({
    userIds: [TEST_USER, OTHER_USER],
    log: SILENT_LOG,
  });
}

describe("(#650) backfillOrphanPlaidItems", () => {
  it("removes an orphan item when a healthy sibling at same institution exists", async () => {
    const survivor = await insertItem({ user: TEST_USER, household: TEST_HOUSEHOLD_ID });
    await attachAccount(survivor.id, TEST_USER, TEST_HOUSEHOLD_ID);
    const orphan = await insertItem({ user: TEST_USER, household: TEST_HOUSEHOLD_ID });

    const summary = await runScoped();

    expect(summary.scannedOrphans).toBe(1);
    expect(summary.removedOrphans).toBe(1);
    expect(summary.removedDetails).toEqual([
      expect.objectContaining({ userId: TEST_USER, itemRowId: orphan.id }),
    ]);
    expect(await userItemIds(TEST_USER)).toEqual(new Set([survivor.id]));
  });

  it("keeps an orphan when there is no sibling (the only item)", async () => {
    const lonely = await insertItem({ user: TEST_USER, household: TEST_HOUSEHOLD_ID });
    const summary = await runScoped();
    expect(summary.scannedOrphans).toBe(1);
    expect(summary.removedOrphans).toBe(0);
    expect(summary.skippedNoHealthySibling).toBe(1);
    expect(await userItemIds(TEST_USER)).toEqual(new Set([lonely.id]));
  });

  it("keeps an orphan whose only sibling is malformed (no healthy survivor)", async () => {
    const orphan = await insertItem({ user: TEST_USER, household: TEST_HOUSEHOLD_ID });
    const malformed = await insertItem({
      user: TEST_USER,
      household: TEST_HOUSEHOLD_ID,
      tokenPrefix: "broken-",
    });
    await attachAccount(malformed.id, TEST_USER, TEST_HOUSEHOLD_ID);

    const summary = await runScoped();

    expect(summary.removedOrphans).toBe(0);
    expect(summary.skippedNoHealthySibling).toBe(1);
    expect(await userItemIds(TEST_USER)).toEqual(new Set([orphan.id, malformed.id]));
  });

  it("does NOT cross institutions: orphan at A, healthy at B → kept", async () => {
    const healthyB = await insertItem({
      user: TEST_USER,
      household: TEST_HOUSEHOLD_ID,
      institutionId: "ins_3",
      institutionSlug: "amex",
      institutionName: "American Express",
    });
    await attachAccount(healthyB.id, TEST_USER, TEST_HOUSEHOLD_ID);
    const orphanA = await insertItem({ user: TEST_USER, household: TEST_HOUSEHOLD_ID });

    const summary = await runScoped();

    expect(summary.removedOrphans).toBe(0);
    expect(summary.skippedNoHealthySibling).toBe(1);
    expect(await userItemIds(TEST_USER)).toEqual(new Set([healthyB.id, orphanA.id]));
  });

  it("never touches the survivor and reaps multiple orphans in one pass", async () => {
    const survivor = await insertItem({ user: TEST_USER, household: TEST_HOUSEHOLD_ID });
    await attachAccount(survivor.id, TEST_USER, TEST_HOUSEHOLD_ID);
    await insertItem({ user: TEST_USER, household: TEST_HOUSEHOLD_ID });
    await insertItem({ user: TEST_USER, household: TEST_HOUSEHOLD_ID });

    const summary = await runScoped();

    expect(summary.removedOrphans).toBe(2);
    expect(await userItemIds(TEST_USER)).toEqual(new Set([survivor.id]));
  });

  it("does NOT match by slug when institutionIds differ (e.g. shared generic slug)", async () => {
    const healthy = await insertItem({
      user: TEST_USER,
      household: TEST_HOUSEHOLD_ID,
      institutionId: "ins_123",
      institutionSlug: "credit-union",
      institutionName: "Credit Union A",
    });
    await attachAccount(healthy.id, TEST_USER, TEST_HOUSEHOLD_ID);
    const orphan = await insertItem({
      user: TEST_USER,
      household: TEST_HOUSEHOLD_ID,
      institutionId: "ins_456",
      institutionSlug: "credit-union",
      institutionName: "Credit Union B",
    });

    const summary = await runScoped();

    expect(summary.removedOrphans).toBe(0);
    expect(summary.skippedNoHealthySibling).toBe(1);
    expect(await userItemIds(TEST_USER)).toEqual(new Set([healthy.id, orphan.id]));
  });

  it("is idempotent: a second pass after a successful sweep is a no-op", async () => {
    const survivor = await insertItem({ user: TEST_USER, household: TEST_HOUSEHOLD_ID });
    await attachAccount(survivor.id, TEST_USER, TEST_HOUSEHOLD_ID);
    await insertItem({ user: TEST_USER, household: TEST_HOUSEHOLD_ID });

    const first = await runScoped();
    expect(first.removedOrphans).toBe(1);

    const second = await runScoped();
    expect(second.scannedOrphans).toBe(0);
    expect(second.removedOrphans).toBe(0);
    expect(second.skippedNoHealthySibling).toBe(0);
    expect(await userItemIds(TEST_USER)).toEqual(new Set([survivor.id]));
  });

  it("does not cross users: user X orphan never reaped by user Y's healthy item", async () => {
    const otherHealthy = await insertItem({ user: OTHER_USER, household: OTHER_HOUSEHOLD_ID });
    await attachAccount(otherHealthy.id, OTHER_USER, OTHER_HOUSEHOLD_ID);
    const xOrphan = await insertItem({ user: TEST_USER, household: TEST_HOUSEHOLD_ID });

    const summary = await runScoped();

    expect(summary.removedOrphans).toBe(0);
    expect(summary.skippedNoHealthySibling).toBe(1);
    expect(await userItemIds(TEST_USER)).toEqual(new Set([xOrphan.id]));
  });
});
