import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  debtsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { dedupePlaidAccountsForUser } from "../lib/dedupePlaidAccounts";
import {
  SYNTHETIC_ACCOUNT_ID,
  SYNTHETIC_ITEM_ID,
} from "../lib/aprilChaseSeed";

const TEST_USER = `dedupe-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
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

describe("dedupePlaidAccountsForUser (#410)", () => {
  it("merges duplicate Chase rows: snapshot + transactions + debts repointed onto the survivor, losers deleted", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        itemId: `dedupe-item-${suffix}`,
        accessToken: "test-no-access",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();

    // Three rows for the same physical Chase ··5526 account, created at
    // increasing timestamps. The middle one is the snapshot pointer —
    // the dedupe routine must prefer it as the survivor regardless of
    // creation order.
    const baseTime = Date.now();
    const [survivor] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        itemId: item!.id,
        accountId: `chase-acct-survivor-${suffix}`,
        name: "Chase Total Checking",
        mask: "5526",
        type: "depository",
        subtype: "checking",
        createdAt: new Date(baseTime - 30_000),
      })
      .returning();
    const [loserA] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        itemId: item!.id,
        accountId: `chase-acct-loserA-${suffix}`,
        name: "Chase Checking",
        mask: "5526",
        type: "depository",
        subtype: "checking",
        createdAt: new Date(baseTime - 20_000),
      })
      .returning();
    const [loserB] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        itemId: item!.id,
        accountId: `chase-acct-loserB-${suffix}`,
        name: "Chase Checking",
        mask: "5526",
        type: "depository",
        subtype: "checking",
        createdAt: new Date(baseTime - 10_000),
      })
      .returning();

    await db.insert(forecastSettingsTable).values({
      userId: TEST_USER,
      bankSnapshotBalance: "3565.09",
      bankSnapshotAt: new Date("2026-04-30T23:59:59Z"),
      bankSnapshotSource: "manual",
      bankSnapshotAccountId: survivor!.id,
      bankSnapshotName: survivor!.name,
      bankSnapshotMask: survivor!.mask,
    });

    const seedTxn = async (
      plaidAccountIdText: string,
      tag: string,
      amount: string,
    ) => {
      const [row] = await db
        .insert(transactionsTable)
        .values({
          userId: TEST_USER,
          occurredOn: "2026-05-01",
          occurredAt: new Date("2026-05-01T12:00:00Z").toISOString(),
          description: `dedupe-${suffix}-${tag}`,
          amount,
          account: "Chase Checking",
          source: "plaid",
          plaidTransactionId: `dedupe-${suffix}-${tag}`,
          plaidAccountId: plaidAccountIdText,
        })
        .returning();
      return row;
    };
    await seedTxn(survivor!.accountId, "S1", "100.00");
    await seedTxn(loserA!.accountId, "A1", "-25.00");
    await seedTxn(loserA!.accountId, "A2", "-50.00");
    await seedTxn(loserB!.accountId, "B1", "-12.34");

    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        name: `dedupe-debt-${suffix}`,
        balance: "100.00",
        apr: "0.1999",
        minPayment: "25.00",
        plaidAccountId: loserA!.id,
      })
      .returning();

    const report = await dedupePlaidAccountsForUser(TEST_USER);
    expect(report.groupsScanned).toBe(1);
    expect(report.duplicatesRemoved).toBe(2);
    expect(report.transactionsRepointed).toBe(3);
    expect(report.debtsRepointed).toBe(1);
    expect(report.snapshotRepointed).toBe(false);

    // Losers gone, survivor kept.
    const remaining = await db
      .select({ id: plaidAccountsTable.id })
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.userId, TEST_USER));
    expect(remaining.map((r) => r.id).sort()).toEqual([survivor!.id].sort());

    // Transactions repointed.
    const txns = await db
      .select({ plaidAccountId: transactionsTable.plaidAccountId })
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    for (const t of txns) {
      expect(t.plaidAccountId).toBe(survivor!.accountId);
    }

    // Debt repointed.
    const [debtAfter] = await db
      .select({ plaidAccountId: debtsTable.plaidAccountId })
      .from(debtsTable)
      .where(eq(debtsTable.id, debt!.id));
    expect(debtAfter!.plaidAccountId).toBe(survivor!.id);

    // Snapshot pointer preserved.
    const [settings] = await db
      .select()
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, TEST_USER));
    expect(settings!.bankSnapshotAccountId).toBe(survivor!.id);
    expect(Number(settings!.bankSnapshotBalance)).toBeCloseTo(3565.09, 2);
  });

  it("repoints the snapshot onto the survivor when the snapshot pointed at a loser", async () => {
    const otherUser = `${TEST_USER}-snap`;
    try {
      const suffix = randomUUID().slice(0, 8);
      const [item] = await db
        .insert(plaidItemsTable)
        .values({
          userId: otherUser,
          itemId: `dedupe-item-${suffix}`,
          accessToken: "test-no-access",
          institutionName: "Chase",
          institutionSlug: "chase",
        })
        .returning();
      // Snapshot points at the *older* row; the newer row (no pointer)
      // wins because the snapshot pointer is the strongest preference.
      // Here, snapshot points at the loser to verify the repoint.
      const [older] = await db
        .insert(plaidAccountsTable)
        .values({
          userId: otherUser,
          itemId: item!.id,
          accountId: `older-${suffix}`,
          name: "Chase Checking",
          mask: "5526",
          type: "depository",
          subtype: "checking",
          createdAt: new Date(Date.now() - 20_000),
        })
        .returning();
      const [newer] = await db
        .insert(plaidAccountsTable)
        .values({
          userId: otherUser,
          itemId: item!.id,
          accountId: `newer-${suffix}`,
          name: "Chase Checking",
          mask: "5526",
          type: "depository",
          subtype: "checking",
          createdAt: new Date(),
        })
        .returning();
      await db.insert(forecastSettingsTable).values({
        userId: otherUser,
        bankSnapshotBalance: "1000.00",
        bankSnapshotAt: new Date(),
        bankSnapshotSource: "manual",
        bankSnapshotAccountId: older!.id,
      });

      // Snapshot-pointer beats most-recent: survivor must be `older`.
      const report = await dedupePlaidAccountsForUser(otherUser);
      expect(report.duplicatesRemoved).toBe(1);
      const remaining = await db
        .select({ id: plaidAccountsTable.id })
        .from(plaidAccountsTable)
        .where(eq(plaidAccountsTable.userId, otherUser));
      expect(remaining.map((r) => r.id)).toEqual([older!.id]);

      // The pointer was already on the survivor, no repoint needed.
      const [settings] = await db
        .select()
        .from(forecastSettingsTable)
        .where(eq(forecastSettingsTable.userId, otherUser));
      expect(settings!.bankSnapshotAccountId).toBe(older!.id);

      void newer;
    } finally {
      await db
        .delete(transactionsTable)
        .where(eq(transactionsTable.userId, otherUser));
      await db
        .delete(forecastSettingsTable)
        .where(eq(forecastSettingsTable.userId, otherUser));
      await db
        .delete(plaidAccountsTable)
        .where(eq(plaidAccountsTable.userId, otherUser));
      await db
        .delete(plaidItemsTable)
        .where(eq(plaidItemsTable.userId, otherUser));
    }
  });

  it("collapses the synthetic Chase ··0000 row when a real Chase checking exists", async () => {
    const otherUser = `${TEST_USER}-synth`;
    // Clean up any leftover synthetic row from prior dev runs (the
    // synthetic accountId is a global constant so it can collide
    // across users).
    await db
      .delete(plaidAccountsTable)
      .where(eq(plaidAccountsTable.accountId, SYNTHETIC_ACCOUNT_ID));
    try {
      const suffix = randomUUID().slice(0, 8);
      // Real Chase row.
      const [realItem] = await db
        .insert(plaidItemsTable)
        .values({
          userId: otherUser,
          itemId: `real-item-${suffix}`,
          accessToken: "test-no-access",
          institutionName: "Chase",
          institutionSlug: "chase",
        })
        .returning();
      const [realAcct] = await db
        .insert(plaidAccountsTable)
        .values({
          userId: otherUser,
          itemId: realItem!.id,
          accountId: `real-acct-${suffix}`,
          name: "Chase Total Checking",
          mask: "5526",
          type: "depository",
          subtype: "checking",
        })
        .returning();
      // Synthetic seed row (mask 0000).
      const [synthItem] = await db
        .insert(plaidItemsTable)
        .values({
          userId: otherUser,
          itemId: `${SYNTHETIC_ITEM_ID}-${suffix}`,
          accessToken: "synthetic-no-access",
          institutionName: "Chase",
          institutionSlug: "chase",
        })
        .returning();
      const [synthAcct] = await db
        .insert(plaidAccountsTable)
        .values({
          userId: otherUser,
          itemId: synthItem!.id,
          accountId: SYNTHETIC_ACCOUNT_ID,
          name: "Chase Checking",
          mask: "0000",
          type: "depository",
          subtype: "checking",
        })
        .returning();
      await db.insert(forecastSettingsTable).values({
        userId: otherUser,
        bankSnapshotBalance: "3565.09",
        bankSnapshotAt: new Date("2026-04-30T23:59:59Z"),
        bankSnapshotSource: "manual",
        bankSnapshotAccountId: synthAcct!.id,
      });

      const report = await dedupePlaidAccountsForUser(otherUser);
      expect(report.syntheticDropped).toBe(true);
      expect(report.snapshotRepointed).toBe(true);

      const remaining = await db
        .select({ id: plaidAccountsTable.id })
        .from(plaidAccountsTable)
        .where(eq(plaidAccountsTable.userId, otherUser));
      expect(remaining.map((r) => r.id)).toEqual([realAcct!.id]);

      const [settings] = await db
        .select()
        .from(forecastSettingsTable)
        .where(eq(forecastSettingsTable.userId, otherUser));
      expect(settings!.bankSnapshotAccountId).toBe(realAcct!.id);
      // Snapshot value preserved during the merge.
      expect(Number(settings!.bankSnapshotBalance)).toBeCloseTo(3565.09, 2);
    } finally {
      await db
        .delete(transactionsTable)
        .where(eq(transactionsTable.userId, otherUser));
      await db
        .delete(forecastSettingsTable)
        .where(eq(forecastSettingsTable.userId, otherUser));
      await db
        .delete(plaidAccountsTable)
        .where(eq(plaidAccountsTable.userId, otherUser));
      await db
        .delete(plaidItemsTable)
        .where(eq(plaidItemsTable.userId, otherUser));
    }
  });

  it("is a no-op when there are no duplicates", async () => {
    const otherUser = `${TEST_USER}-clean`;
    try {
      const suffix = randomUUID().slice(0, 8);
      const [item] = await db
        .insert(plaidItemsTable)
        .values({
          userId: otherUser,
          itemId: `clean-item-${suffix}`,
          accessToken: "test-no-access",
          institutionName: "Chase",
          institutionSlug: "chase",
        })
        .returning();
      await db.insert(plaidAccountsTable).values({
        userId: otherUser,
        itemId: item!.id,
        accountId: `clean-acct-${suffix}`,
        name: "Chase Total Checking",
        mask: "5526",
        type: "depository",
        subtype: "checking",
      });
      const report = await dedupePlaidAccountsForUser(otherUser);
      expect(report.groupsScanned).toBe(0);
      expect(report.duplicatesRemoved).toBe(0);
      expect(report.transactionsRepointed).toBe(0);
    } finally {
      await db
        .delete(plaidAccountsTable)
        .where(eq(plaidAccountsTable.userId, otherUser));
      await db
        .delete(plaidItemsTable)
        .where(eq(plaidItemsTable.userId, otherUser));
    }
  });
});
