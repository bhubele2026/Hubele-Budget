import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import { runStartupAccountSnapshotsRepair } from "../lib/startupAccountSnapshotsRepair";
import { createTestHousehold } from "./_helpers/testHousehold";

const SUITE_TAG = `startup-snap-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

async function cleanupForUser(userId: string): Promise<void> {
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, userId));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, userId));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, userId));
}

const allUsers: string[] = [];
const householdByUser = new Map<string, string>();
async function makeUser(label: string): Promise<string> {
  const id = `${SUITE_TAG}-${label}-${randomUUID().slice(0, 8)}`;
  allUsers.push(id);
  const { householdId } = await createTestHousehold(id);
  householdByUser.set(id, householdId);
  return id;
}
function householdFor(userId: string): string {
  const h = householdByUser.get(userId);
  if (!h) throw new Error(`no household for ${userId}`);
  return h;
}

beforeAll(async () => {
  // Nothing global to set up; cleanup in afterAll handles teardown.
});

afterAll(async () => {
  for (const u of allUsers) {
    await cleanupForUser(u);
  }
});

describe("runStartupAccountSnapshotsRepair (#434)", () => {
  it("salvages an orphan accountSnapshots key onto the surviving plaid_accounts row", async () => {
    const userId = await makeUser("orphan");
    const suffix = randomUUID().slice(0, 8);
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId,
        householdId: householdFor(userId),
        itemId: `startup-item-${suffix}`,
        accessToken: "test-no-access",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    const [survivor] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        householdId: householdFor(userId),
        itemId: item!.id,
        accountId: `startup-survivor-${suffix}`,
        name: "Chase Total Checking",
        mask: "4242",
        type: "depository",
        subtype: "checking",
      })
      .returning();
    const orphanId = randomUUID();
    await db.insert(forecastSettingsTable).values({
      userId,
      householdId: householdFor(userId),
      // Gate already stamped — this is the cohort the startup sweep targets.
      autoDedupeRanAt: new Date(),
      accountSnapshots: {
        [orphanId]: {
          balance: "1234.56",
          at: new Date().toISOString(),
          source: "plaid",
          name: "Chase Total Checking",
          mask: "4242",
        },
      },
    });

    const summary = await runStartupAccountSnapshotsRepair();
    expect(summary.scanned).toBeGreaterThanOrEqual(1);
    expect(summary.failed).toBe(0);

    const [post] = await db
      .select({ accountSnapshots: forecastSettingsTable.accountSnapshots })
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, userId));
    const snaps = post!.accountSnapshots as Record<
      string,
      { balance: string; mask: string | null }
    >;
    // Orphan key was pruned; survivor row now owns the salvaged entry.
    expect(snaps[orphanId]).toBeUndefined();
    expect(snaps[survivor!.id]).toBeDefined();
    expect(snaps[survivor!.id]!.balance).toBe("1234.56");
  });

  it("is a no-op for a clean user with a healthy accountSnapshots map", async () => {
    const userId = await makeUser("clean");
    const suffix = randomUUID().slice(0, 8);
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId,
        householdId: householdFor(userId),
        itemId: `startup-clean-item-${suffix}`,
        accessToken: "test-no-access",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    const [acct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        householdId: householdFor(userId),
        itemId: item!.id,
        accountId: `startup-clean-acct-${suffix}`,
        name: "Chase Total Checking",
        mask: "7777",
        type: "depository",
        subtype: "checking",
      })
      .returning();
    const before = {
      [acct!.id]: {
        balance: "100.00",
        at: new Date().toISOString(),
        source: "plaid" as const,
        name: "Chase Total Checking",
        mask: "7777",
      },
    };
    await db.insert(forecastSettingsTable).values({
      userId,
      householdId: householdFor(userId),
      autoDedupeRanAt: new Date(),
      accountSnapshots: before,
    });

    const summary = await runStartupAccountSnapshotsRepair();
    expect(summary.failed).toBe(0);

    const [post] = await db
      .select({ accountSnapshots: forecastSettingsTable.accountSnapshots })
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, userId));
    const snaps = post!.accountSnapshots as Record<string, unknown>;
    expect(Object.keys(snaps)).toEqual([acct!.id]);
  });

  it("skips users whose accountSnapshots map is empty or null", async () => {
    const emptyUser = await makeUser("empty");
    const nullUser = await makeUser("null");
    await db
      .insert(forecastSettingsTable)
      .values({ userId: emptyUser, accountSnapshots: {} });
    await db.insert(forecastSettingsTable).values({ userId: nullUser });

    const before = await runStartupAccountSnapshotsRepair();
    // Neither user should appear in the scan set; we can't compare exact
    // counts because other suites may have inserted rows, so just assert
    // both users still have their original snapshot state (i.e. the
    // sweep did not touch them).
    expect(before.failed).toBe(0);
    const [emptyRow] = await db
      .select({ accountSnapshots: forecastSettingsTable.accountSnapshots })
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, emptyUser));
    const [nullRow] = await db
      .select({ accountSnapshots: forecastSettingsTable.accountSnapshots })
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, nullUser));
    expect(emptyRow!.accountSnapshots).toEqual({});
    expect(nullRow!.accountSnapshots).toBeNull();
  });
});
