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

  it("repairs a non-legacy stale manual snapshot pinned to 2026-04-30 to $3,565.09", async () => {
    // Simulates a snapshot that came from some intermediate seeded value
    // (not the legacy 5554.45) but is still anchored to the seed's
    // canonical 2026-04-30 date — almost certainly an earlier seed run.
    const otherUser = `${TEST_USER}-stale`;
    try {
      const [item] = await db
        .insert(plaidItemsTable)
        .values({
          userId: otherUser,
          itemId: `stale-${otherUser}`,
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
          accountId: `stale-acct-${otherUser}`,
          name: "Chase Checking",
          mask: "0000",
          type: "depository",
          subtype: "checking",
        })
        .returning();
      await db.insert(forecastSettingsTable).values({
        userId: otherUser,
        bankSnapshotBalance: "4321.00",
        bankSnapshotAt: new Date("2026-04-30T23:59:59Z"),
        bankSnapshotSource: "manual",
        bankSnapshotAccountId: acct!.id,
        bankSnapshotName: acct!.name,
        bankSnapshotMask: acct!.mask,
      });

      const result = await seedAprilChase(otherUser);
      expect(result.snapshotRepaired).toBe(true);

      const [settings] = await db
        .select()
        .from(forecastSettingsTable)
        .where(eq(forecastSettingsTable.userId, otherUser));
      expect(Number(settings!.bankSnapshotBalance)).toBeCloseTo(3565.09, 2);
      expect(settings!.bankSnapshotAt?.toISOString()).toBe(
        "2026-04-30T23:59:59.000Z",
      );
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

  it("repairs a stale plaid-sourced snapshot still pinned to 2026-04-30", async () => {
    // A plaid-sourced row that's still anchored to the seed's
    // 2026-04-30 date is stale (a real Plaid refresh writes today's
    // timestamp). Repair must fire regardless of source.
    const otherUser = `${TEST_USER}-plaid`;
    try {
      const [item] = await db
        .insert(plaidItemsTable)
        .values({
          userId: otherUser,
          itemId: `plaid-${otherUser}`,
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
          accountId: `plaid-acct-${otherUser}`,
          name: "Chase Checking",
          mask: "0000",
          type: "depository",
          subtype: "checking",
        })
        .returning();
      await db.insert(forecastSettingsTable).values({
        userId: otherUser,
        bankSnapshotBalance: "5554.45",
        bankSnapshotAt: new Date("2026-04-30T23:59:59Z"),
        bankSnapshotSource: "plaid",
        bankSnapshotAccountId: acct!.id,
        bankSnapshotName: acct!.name,
        bankSnapshotMask: acct!.mask,
      });

      const result = await seedAprilChase(otherUser);
      expect(result.snapshotRepaired).toBe(true);

      const [settings] = await db
        .select()
        .from(forecastSettingsTable)
        .where(eq(forecastSettingsTable.userId, otherUser));
      expect(Number(settings!.bankSnapshotBalance)).toBeCloseTo(3565.09, 2);
      expect(settings!.bankSnapshotAt?.toISOString()).toBe(
        "2026-04-30T23:59:59.000Z",
      );
      // Source flipped to manual since we're asserting a known
      // historical end-of-month value, not a live Plaid reading.
      expect(settings!.bankSnapshotSource).toBe("manual");
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

  it("leaves a fresh plaid-sourced snapshot (recent date) alone", async () => {
    // A real Plaid refresh would carry today's timestamp, NOT the
    // seed's 2026-04-30. Repair must NOT touch this row even if the
    // balance happens to be stale-looking — it's a live reading.
    const otherUser = `${TEST_USER}-plaid-fresh`;
    try {
      const [item] = await db
        .insert(plaidItemsTable)
        .values({
          userId: otherUser,
          itemId: `plaid-fresh-${otherUser}`,
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
          accountId: `plaid-fresh-acct-${otherUser}`,
          name: "Chase Checking",
          mask: "0000",
          type: "depository",
          subtype: "checking",
        })
        .returning();
      await db.insert(forecastSettingsTable).values({
        userId: otherUser,
        bankSnapshotBalance: "2222.22",
        bankSnapshotAt: new Date("2026-05-15T10:00:00Z"),
        bankSnapshotSource: "plaid",
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
      expect(Number(settings!.bankSnapshotBalance)).toBeCloseTo(2222.22, 2);
      expect(settings!.bankSnapshotSource).toBe("plaid");
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

  it("does not overwrite a manual snapshot the user has edited (different date than the seed)", async () => {
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
        // A user-edited snapshot carries the date the user edited it
        // (e.g. today), NOT the seed's pinned 2026-04-30. The repair
        // must leave this alone.
        bankSnapshotAt: new Date("2026-05-15T10:00:00Z"),
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
      // User's edited value is left alone — the repair only targets
      // snapshots that look auto-seeded (legacy value or pinned to the
      // seed's exact 2026-04-30 date with a wrong balance).
      expect(Number(settings!.bankSnapshotBalance)).toBeCloseTo(1234.56, 2);
      expect(settings!.bankSnapshotAt?.toISOString()).toBe(
        "2026-05-15T10:00:00.000Z",
      );
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

