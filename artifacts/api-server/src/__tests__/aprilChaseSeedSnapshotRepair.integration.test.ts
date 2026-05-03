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
  APRIL_2026_ENDING_BALANCE,
} from "../lib/aprilChaseSeed";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

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

beforeAll(cleanup);
afterAll(cleanup);

describe("seedAprilChase snapshot repair (task #128)", () => {
  it("upgrades a previously-seeded $5,554.45 manual snapshot to $3,565.09 on re-run", async () => {
    // Simulate a user who was seeded under the old constant: a synthetic
    // Chase account already exists, forecast_settings holds the legacy
    // ending balance, and the April rows were already inserted.
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        itemId: `legacy-${TEST_USER}`,
        accessToken: "synthetic-no-access",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    const [acct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        itemId: item!.id,
        accountId: `legacy-acct-${TEST_USER}`,
        name: "Chase Checking",
        mask: "0000",
        type: "depository",
        subtype: "checking",
      })
      .returning();
    await db.insert(forecastSettingsTable).values({
      userId: TEST_USER,
      bankSnapshotBalance: "5554.45",
      bankSnapshotAt: new Date("2026-04-30T23:59:59Z"),
      bankSnapshotSource: "manual",
      bankSnapshotAccountId: acct!.id,
      bankSnapshotName: acct!.name,
      bankSnapshotMask: acct!.mask,
    });

    const result = await seedAprilChase(TEST_USER);
    expect(result.endingBalance).toBe(APRIL_2026_ENDING_BALANCE.toFixed(2));
    expect(result.endingBalance).toBe("3565.09");
    expect(result.snapshotRepaired).toBe(true);

    const [settings] = await db
      .select()
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, TEST_USER));
    expect(settings).toBeTruthy();
    expect(Number(settings!.bankSnapshotBalance)).toBeCloseTo(3565.09, 2);
    // Account binding is preserved.
    expect(settings!.bankSnapshotAccountId).toBe(acct!.id);
    expect(settings!.bankSnapshotSource).toBe("manual");
    expect(settings!.bankSnapshotAt?.toISOString()).toBe(
      "2026-04-30T23:59:59.000Z",
    );
  });

  it("does not overwrite a non-legacy manual snapshot balance the user has edited", async () => {
    const otherUser = `${TEST_USER}-edited`;
    try {
      const [item] = await db
        .insert(plaidItemsTable)
        .values({
          userId: otherUser,
          itemId: `edited-${otherUser}`,
          accessToken: "synthetic-no-access",
          institutionName: "Chase",
          institutionSlug: "chase",
        })
        .returning();
      const [acct] = await db
        .insert(plaidAccountsTable)
        .values({
          userId: otherUser,
          itemId: item!.id,
          accountId: `edited-acct-${otherUser}`,
          name: "Chase Checking",
          mask: "0000",
          type: "depository",
          subtype: "checking",
        })
        .returning();
      await db.insert(forecastSettingsTable).values({
        userId: otherUser,
        bankSnapshotBalance: "1234.56",
        bankSnapshotAt: new Date("2026-04-30T23:59:59Z"),
        bankSnapshotSource: "manual",
        bankSnapshotAccountId: acct!.id,
        bankSnapshotName: acct!.name,
        bankSnapshotMask: acct!.mask,
      });

      const result = await seedAprilChase(otherUser);
      expect(result.snapshotRepaired).toBe(false);

      const [settings] = await db
        .select()
        .from(forecastSettingsTable)
        .where(eq(forecastSettingsTable.userId, otherUser));
      // User's edited value is left alone — the repair is targeted only at
      // the legacy 5554.45 we previously seeded.
      expect(Number(settings!.bankSnapshotBalance)).toBeCloseTo(1234.56, 2);
    } finally {
      await db
        .delete(transactionsTable)
        .where(eq(transactionsTable.userId, otherUser));
      await db
        .delete(mappingRulesTable)
        .where(eq(mappingRulesTable.userId, otherUser));
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
});

