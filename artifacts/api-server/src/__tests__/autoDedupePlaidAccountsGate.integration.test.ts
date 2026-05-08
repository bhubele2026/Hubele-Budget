import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import {
  markAutoDedupeRan,
  runAutoDedupeIfNeeded,
} from "../lib/dedupePlaidAccounts";
import { listCheckingAccounts } from "../routes/forecast";

const TEST_USER = `auto-dedupe-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

async function cleanup(): Promise<void> {
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(cleanup);
afterAll(cleanup);

describe("runAutoDedupeIfNeeded — gated auto-heal (#411)", () => {
  it("collapses duplicates on the first listCheckingAccounts hit and is a no-op on subsequent hits", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        itemId: `auto-item-${suffix}`,
        accessToken: "test-no-access",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    const [survivor] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        itemId: item!.id,
        accountId: `auto-survivor-${suffix}`,
        name: "Chase Total Checking",
        mask: "5526",
        type: "depository",
        subtype: "checking",
        createdAt: new Date(Date.now() - 30_000),
      })
      .returning();
    const [loser] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        itemId: item!.id,
        accountId: `auto-loser-${suffix}`,
        name: "Chase Total Checking",
        mask: "5526",
        type: "depository",
        subtype: "checking",
        createdAt: new Date(),
      })
      .returning();
    await db.insert(forecastSettingsTable).values({
      userId: TEST_USER,
      bankSnapshotAccountId: survivor!.id,
    });

    // Pre-flight: gate is unset, both rows live in the DB.
    const [pre] = await db
      .select({ ts: forecastSettingsTable.autoDedupeRanAt })
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, TEST_USER));
    expect(pre!.ts).toBeNull();
    const preRows = await db
      .select({ id: plaidAccountsTable.id })
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, TEST_USER));
    expect(preRows.length).toBe(2);

    // First listCheckingAccounts call triggers the auto-heal.
    const accounts = await listCheckingAccounts(TEST_USER);
    expect(accounts.length).toBe(1);
    expect(accounts[0].id).toBe(survivor!.id);

    // The loser row was actually deleted (DB-level dedupe ran).
    const postRows = await db
      .select({ id: plaidAccountsTable.id })
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, TEST_USER));
    expect(postRows.map((r) => r.id)).toEqual([survivor!.id]);

    // Gate is now stamped.
    const [post] = await db
      .select({ ts: forecastSettingsTable.autoDedupeRanAt })
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, TEST_USER));
    expect(post!.ts).not.toBeNull();
    const stampedAt = post!.ts!;

    // A direct second invocation is a no-op — returns null and leaves
    // the gate timestamp untouched.
    const secondReport = await runAutoDedupeIfNeeded(
      TEST_USER,
      "second-listCheckingAccounts",
    );
    expect(secondReport).toBeNull();
    const [post2] = await db
      .select({ ts: forecastSettingsTable.autoDedupeRanAt })
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, TEST_USER));
    expect(post2!.ts!.getTime()).toBe(stampedAt.getTime());

    // Confirm `loser` is referenced for sanity (silences unused-var).
    expect(loser!.id).not.toBe(survivor!.id);
  });

  it("clears the gate when the dedupe pass throws so the next request retries", async () => {
    const failUser = `auto-dedupe-fail-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    try {
      await db
        .insert(forecastSettingsTable)
        .values({ userId: failUser });
      const boom = new Error("simulated dedupe failure");
      const report = await runAutoDedupeIfNeeded(
        failUser,
        "test-failure-path",
        async () => {
          throw boom;
        },
      );
      expect(report).toBeNull();
      // Gate must be cleared so a subsequent request can retry —
      // otherwise a single transient failure would permanently skip
      // healing for this user.
      const [row] = await db
        .select({ ts: forecastSettingsTable.autoDedupeRanAt })
        .from(forecastSettingsTable)
        .where(eq(forecastSettingsTable.userId, failUser));
      expect(row!.ts).toBeNull();
      // And a follow-up call with a working runner should now succeed
      // and stamp the gate.
      const retry = await runAutoDedupeIfNeeded(
        failUser,
        "test-failure-retry",
        async () => ({
          groupsScanned: 0,
          duplicatesRemoved: 0,
          transactionsRepointed: 0,
          debtsRepointed: 0,
          snapshotRepointed: false,
          syntheticDropped: false,
          accountSnapshotsRepointed: 0,
          accountSnapshotsPruned: 0,
          transactionsDeduped: 0,
          transactionResolutionsRepointed: 0,
        }),
      );
      expect(retry).not.toBeNull();
      const [stamped] = await db
        .select({ ts: forecastSettingsTable.autoDedupeRanAt })
        .from(forecastSettingsTable)
        .where(eq(forecastSettingsTable.userId, failUser));
      expect(stamped!.ts).not.toBeNull();
    } finally {
      await db
        .delete(forecastSettingsTable)
        .where(eq(forecastSettingsTable.userId, failUser));
    }
  });

  it("markAutoDedupeRan flips the gate without running dedupe (used by the post-link hook)", async () => {
    const otherUser = `auto-dedupe-mark-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    try {
      const suffix = randomUUID().slice(0, 8);
      const [item] = await db
        .insert(plaidItemsTable)
        .values({
          userId: otherUser,
          itemId: `auto-mark-item-${suffix}`,
          accessToken: "test-no-access",
          institutionName: "Chase",
          institutionSlug: "chase",
        })
        .returning();
      const [a] = await db
        .insert(plaidAccountsTable)
        .values({
          userId: otherUser,
          itemId: item!.id,
          accountId: `auto-mark-a-${suffix}`,
          name: "Chase Total Checking",
          mask: "9999",
          type: "depository",
          subtype: "checking",
          createdAt: new Date(Date.now() - 10_000),
        })
        .returning();
      await db.insert(plaidAccountsTable).values({
        userId: otherUser,
        itemId: item!.id,
        accountId: `auto-mark-b-${suffix}`,
        name: "Chase Total Checking",
        mask: "9999",
        type: "depository",
        subtype: "checking",
        createdAt: new Date(),
      });
      await db.insert(forecastSettingsTable).values({ userId: otherUser });

      // Mark the gate without running dedupe.
      await markAutoDedupeRan(otherUser);
      const [stamped] = await db
        .select({ ts: forecastSettingsTable.autoDedupeRanAt })
        .from(forecastSettingsTable)
        .where(eq(forecastSettingsTable.userId, otherUser));
      expect(stamped!.ts).not.toBeNull();

      // Both DB rows should still be present — markAutoDedupeRan does
      // not run the dedupe routine itself.
      const rows = await db
        .select({ id: plaidAccountsTable.id })
        .from(plaidAccountsTable)
        .where(eq(plaidAccountsTable.userId, otherUser));
      expect(rows.length).toBe(2);

      // And a subsequent runAutoDedupeIfNeeded is a no-op because the
      // gate is already stamped.
      const report = await runAutoDedupeIfNeeded(otherUser, "post-mark");
      expect(report).toBeNull();
      // Sanity: the survivor row is still present.
      expect(rows.map((r) => r.id)).toContain(a!.id);
    } finally {
      await db
        .delete(forecastSettingsTable)
        .where(eq(forecastSettingsTable.userId, otherUser));
      await db
        .delete(plaidAccountsTable)
        .where(eq(plaidAccountsTable.userId, otherUser));
      await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, otherUser));
    }
  });
});
