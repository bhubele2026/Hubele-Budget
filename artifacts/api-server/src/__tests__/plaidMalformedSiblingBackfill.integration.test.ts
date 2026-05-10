import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createTestHousehold } from "./_helpers/testHousehold";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import {
  db,
  debtsTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import { backfillMalformedTokenSiblings } from "../lib/plaidMalformedSiblingCleanup";

const TEST_USER = `mfsib-bf-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const OTHER_USER = `mfsib-bf-other-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;
let OTHER_HOUSEHOLD_ID: string;

async function cleanup(): Promise<void> {
  for (const u of [TEST_USER, OTHER_USER]) {
    await db.delete(debtsTable).where(eq(debtsTable.userId, u));
    await db
      .delete(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, u));
    await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, u));
  }
}

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
  const _o = await createTestHousehold(OTHER_USER);
  OTHER_HOUSEHOLD_ID = _o.householdId;
});
beforeEach(async () => {
  await cleanup();
});
afterAll(async () => {
  await cleanup();
});

describe("(#406) backfillMalformedTokenSiblings", () => {
  it("removes a stale malformed-token row when a healthy sibling exists for the same institution", async () => {
    const [healthy] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `healthy-${randomUUID().slice(0, 8)}`,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionId: "ins_56",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    const [stale] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `stale-${randomUUID().slice(0, 8)}`,
        accessToken: "broken-token-no-prefix",
        institutionId: "ins_56",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: stale.id,
      accountId: `acct-${randomUUID().slice(0, 8)}`,
      name: "Chase Total Checking",
      mask: "5526",
      type: "depository",
      subtype: "checking",
    });

    const summary = await backfillMalformedTokenSiblings();
    expect(summary.scannedMalformed).toBeGreaterThanOrEqual(1);
    expect(summary.cleanedSiblings).toBeGreaterThanOrEqual(1);

    const remaining = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.userId, TEST_USER));
    expect(remaining.map((r) => r.id)).toEqual([healthy.id]);

    const remainingAccts = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, TEST_USER));
    expect(remainingAccts).toHaveLength(0);
  });

  it("leaves a malformed row alone when there is no healthy sibling for the same institution", async () => {
    const [orphan] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `orphan-${randomUUID().slice(0, 8)}`,
        accessToken: "broken-token-no-prefix",
        institutionId: "ins_56",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();

    const summary = await backfillMalformedTokenSiblings();
    expect(summary.skippedNoHealthySibling).toBeGreaterThanOrEqual(1);

    const [stillThere] = await db
      .select()
      .from(plaidItemsTable)
      .where(
        and(
          eq(plaidItemsTable.userId, TEST_USER),
          eq(plaidItemsTable.id, orphan.id),
        ),
      );
    expect(stillThere).toBeDefined();
  });

  it("does not touch a healthy duplicate sibling for the same institution (two real logins case)", async () => {
    const [a] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `chase-a-${randomUUID().slice(0, 8)}`,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionId: "ins_56",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    const [b] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `chase-b-${randomUUID().slice(0, 8)}`,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionId: "ins_56",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();

    const summary = await backfillMalformedTokenSiblings();
    expect(summary.cleanedSiblings).toBe(0);

    const remaining = await db
      .select({ id: plaidItemsTable.id })
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.userId, TEST_USER));
    expect(remaining.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("does not cross users when matching healthy sibling against a malformed row", async () => {
    const [foreignHealthy] = await db
      .insert(plaidItemsTable)
      .values({
        userId: OTHER_USER,
        householdId: OTHER_HOUSEHOLD_ID,
        itemId: `other-${randomUUID().slice(0, 8)}`,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionId: "ins_56",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    const [stale] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `stale-${randomUUID().slice(0, 8)}`,
        accessToken: "broken-token-no-prefix",
        institutionId: "ins_56",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();

    const summary = await backfillMalformedTokenSiblings();
    expect(summary.cleanedSiblings).toBe(0);

    const [stillThere] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, stale.id));
    expect(stillThere).toBeDefined();
    const [foreignStill] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, foreignHealthy.id));
    expect(foreignStill).toBeDefined();
  });

  it("resets debt source flags on accounts owned by the cleaned malformed row", async () => {
    await db.insert(plaidItemsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `healthy-${randomUUID().slice(0, 8)}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionId: "ins_56",
      institutionName: "Chase",
      institutionSlug: "chase",
    });
    const [stale] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `stale-${randomUUID().slice(0, 8)}`,
        accessToken: "broken-token-no-prefix",
        institutionId: "ins_56",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    const [staleAcct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: stale.id,
        accountId: `acct-${randomUUID().slice(0, 8)}`,
        name: "Chase Sapphire",
        mask: "9999",
        type: "credit",
        subtype: "credit card",
      })
      .returning();
    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: `Chase ••9999 ${randomUUID().slice(0, 6)}`,
        type: "credit_card",
        status: "active",
        plaidAccountId: staleAcct.id,
        balanceSource: "plaid",
        aprSource: "plaid",
        minPaymentSource: "plaid",
        plaidLastSyncedAt: new Date(),
      })
      .returning();

    await backfillMalformedTokenSiblings();

    const [updatedDebt] = await db
      .select()
      .from(debtsTable)
      .where(eq(debtsTable.id, debt.id));
    expect(updatedDebt).toBeDefined();
    expect(updatedDebt!.balanceSource).toBe("manual");
    expect(updatedDebt!.aprSource).toBe("manual");
    expect(updatedDebt!.minPaymentSource).toBe("manual");
    expect(updatedDebt!.plaidLastSyncedAt).toBeNull();
    expect(updatedDebt!.plaidAccountId).toBeNull();
  });

  it("cleans a slug-only stale row when the healthy sibling has both id + slug", async () => {
    await db.insert(plaidItemsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `healthy-${randomUUID().slice(0, 8)}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionId: "ins_56",
      institutionName: "Chase",
      institutionSlug: "chase",
    });
    const [stale] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `stale-${randomUUID().slice(0, 8)}`,
        accessToken: "broken-token-no-prefix",
        // institutionId intentionally null — older link metadata
        institutionId: null,
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();

    const summary = await backfillMalformedTokenSiblings();
    expect(summary.cleanedSiblings).toBeGreaterThanOrEqual(1);

    const [stillThere] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, stale.id));
    expect(stillThere).toBeUndefined();
  });

  it("is idempotent — a second run after cleanup is a no-op", async () => {
    await db.insert(plaidItemsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `healthy-${randomUUID().slice(0, 8)}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionId: "ins_56",
      institutionName: "Chase",
      institutionSlug: "chase",
    });
    await db.insert(plaidItemsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `stale-${randomUUID().slice(0, 8)}`,
      accessToken: "broken-token-no-prefix",
      institutionId: "ins_56",
      institutionName: "Chase",
      institutionSlug: "chase",
    });

    const first = await backfillMalformedTokenSiblings();
    expect(first.cleanedSiblings).toBeGreaterThanOrEqual(1);
    const second = await backfillMalformedTokenSiblings();
    expect(second.cleanedSiblings).toBe(0);
  });
});
