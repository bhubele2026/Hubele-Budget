// ⭐ WHEN IS THE BANK BALANCE STALE? The server decides, once.
//
// Screens used to judge this from a timestamp of their own, and a failed refresh
// looked exactly like a fresh balance until the numbers were visibly wrong.
// `computeBankFreshness` reads the snapshot, the Plaid item behind its account
// and that item's refresh attempts, and says stale or not, and why. Every case
// pins `now`, so none depends on when CI runs.
//
// The fixtures follow the order `plaidSync` really writes in: a transactions
// row, then a balance row only when the owner's Sync re-read the balance.
// Webhook syncs write no balance row.

import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import {
  db,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  plaidSyncAttemptsTable,
} from "@workspace/db";
import { createTestHousehold } from "./_helpers/testHousehold";
import {
  computeBankFreshness,
  MANUAL_SNAPSHOT_STALE_MS,
  PLAID_FEED_QUIET_MS,
} from "../lib/bankFreshness";
import {
  BANK_FEED_DEAD_CODES,
  PLAID_REAUTH_ERROR_CODES,
} from "../lib/plaidReauthCodes";

const NOW = new Date("2026-09-11T17:00:00.000Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const users: string[] = [];

type Attempt = {
  kind: string;
  success: boolean;
  agoMs: number;
  errorCode?: string | null;
};

/** One household per case: a snapshot, and optionally the Plaid item behind it. */
async function seed(opts: {
  snapshot: { source: "plaid" | "manual"; ageMs: number } | null;
  plaid: {
    lastSyncedAgoMs?: number;
    lastSyncError?: string | null;
    lastSyncErrorCode?: string | null;
    attempts?: Attempt[];
  } | null;
}): Promise<{ householdId: string; userId: string; lastSyncedAt: Date | null }> {
  const userId = `bank-fresh-${process.pid}-${randomUUID().slice(0, 8)}`;
  users.push(userId);
  const { householdId } = await createTestHousehold(userId);

  let accountRowId: string | null = null;
  let lastSyncedAt: Date | null = null;
  if (opts.plaid) {
    lastSyncedAt =
      opts.plaid.lastSyncedAgoMs != null ? ago(opts.plaid.lastSyncedAgoMs) : null;
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId,
        householdId,
        itemId: `item-${randomUUID()}`,
        accessToken: "test-token",
        institutionSlug: "chase",
        lastSyncedAt,
        lastSyncError: opts.plaid.lastSyncError ?? null,
        lastSyncErrorCode: opts.plaid.lastSyncErrorCode ?? null,
      })
      .returning();
    const [acct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId,
        householdId,
        itemId: item!.id,
        accountId: `acct-${randomUUID()}`,
        name: "Chase Checking",
        mask: "1111",
        type: "depository",
        subtype: "checking",
      })
      .returning();
    accountRowId = acct!.id;
    for (const a of opts.plaid.attempts ?? []) {
      await db.insert(plaidSyncAttemptsTable).values({
        userId,
        householdId,
        plaidItemId: item!.id,
        kind: a.kind,
        success: a.success,
        errorCode: a.errorCode ?? null,
        attemptedAt: ago(a.agoMs),
      });
    }
  }

  if (opts.snapshot) {
    await db.insert(forecastSettingsTable).values({
      userId,
      householdId,
      bankSnapshotBalance: "1000.00",
      bankSnapshotAt: ago(opts.snapshot.ageMs),
      bankSnapshotSource: opts.snapshot.source,
      bankSnapshotAccountId: accountRowId,
      bankSnapshotMask: accountRowId ? "1111" : null,
    });
  }

  return { householdId, userId, lastSyncedAt };
}

const judge = (s: { householdId: string; userId: string }) =>
  computeBankFreshness(s.householdId, s.userId, NOW);

afterAll(async () => {
  if (users.length === 0) return;
  await db
    .delete(plaidSyncAttemptsTable)
    .where(inArray(plaidSyncAttemptsTable.userId, users));
  await db.delete(plaidAccountsTable).where(inArray(plaidAccountsTable.userId, users));
  await db.delete(plaidItemsTable).where(inArray(plaidItemsTable.userId, users));
  await db
    .delete(forecastSettingsTable)
    .where(inArray(forecastSettingsTable.userId, users));
});

describe("computeBankFreshness — nothing to judge", () => {
  it("no snapshot: not stale", async () => {
    const s = await seed({ snapshot: null, plaid: null });
    expect(await judge(s)).toEqual({
      source: null,
      lastContactAt: null,
      lastFailureAt: null,
      stale: false,
      staleReason: null,
    });
  });
});

describe("computeBankFreshness — age", () => {
  it("a Plaid balance re-read 3 days ago stays fresh while webhook syncs keep landing rows on it", async () => {
    const s = await seed({
      snapshot: { source: "plaid", ageMs: 3 * DAY },
      plaid: {
        lastSyncedAgoMs: 1 * HOUR,
        attempts: [{ kind: "transactions", success: true, agoMs: 1 * HOUR }],
      },
    });
    const r = await judge(s);
    expect(r).toMatchObject({ source: "plaid", stale: false, staleReason: null });
    expect(r.lastContactAt).toBe(s.lastSyncedAt!.toISOString());
  });

  it("a Plaid balance goes old when neither a re-read nor a sync has happened for 48 hours", async () => {
    const quiet = await seed({
      snapshot: { source: "plaid", ageMs: 3 * DAY },
      plaid: { lastSyncedAgoMs: 49 * HOUR },
    });
    expect(await judge(quiet)).toMatchObject({ stale: true, staleReason: "old" });

    // A fresh re-read counts as hearing from the bank, even with an older sync.
    const reRead = await seed({
      snapshot: { source: "plaid", ageMs: 1 * HOUR },
      plaid: { lastSyncedAgoMs: 60 * HOUR },
    });
    expect(await judge(reRead)).toMatchObject({ stale: false, staleReason: null });
  });

  it("a Plaid balance that has never synced goes by its own age: fresh at 47 hours, old at 49", async () => {
    const young = await seed({
      snapshot: { source: "plaid", ageMs: 47 * HOUR },
      plaid: {},
    });
    expect(await judge(young)).toMatchObject({
      lastContactAt: null,
      stale: false,
      staleReason: null,
    });

    const aged = await seed({ snapshot: { source: "plaid", ageMs: 49 * HOUR }, plaid: {} });
    expect(await judge(aged)).toMatchObject({ stale: true, staleReason: "old" });
  });

  it("a typed-in balance is fresh at 6 days and manual_old past 7", async () => {
    // No Plaid account at all: nothing resolves, so only the age rule applies.
    const young = await seed({ snapshot: { source: "manual", ageMs: 6 * DAY }, plaid: null });
    expect(await judge(young)).toMatchObject({
      source: "manual",
      lastContactAt: null,
      stale: false,
      staleReason: null,
    });

    const aged = await seed({ snapshot: { source: "manual", ageMs: 8 * DAY }, plaid: null });
    expect(await judge(aged)).toMatchObject({ stale: true, staleReason: "manual_old" });
  });

  it("a live feed does not refresh a typed-in balance: 8 days old is manual_old even with a sync an hour ago", async () => {
    const s = await seed({
      snapshot: { source: "manual", ageMs: 8 * DAY },
      plaid: {
        lastSyncedAgoMs: 1 * HOUR,
        attempts: [{ kind: "transactions", success: true, agoMs: 1 * HOUR }],
      },
    });
    expect(await judge(s)).toMatchObject({ stale: true, staleReason: "manual_old" });
  });
});

describe("computeBankFreshness — failure", () => {
  it("a failed balance re-read marks it stale at once, even on a one-hour-old snapshot", async () => {
    // The owner's Sync: the transactions sync succeeds, then the balance re-read
    // fails a moment later.
    const s = await seed({
      snapshot: { source: "plaid", ageMs: 1 * HOUR },
      plaid: {
        lastSyncedAgoMs: 30 * MINUTE,
        attempts: [
          { kind: "balance", success: true, agoMs: 2 * HOUR },
          { kind: "transactions", success: true, agoMs: 30 * MINUTE },
          { kind: "balance", success: false, agoMs: 30 * MINUTE - 1000 },
        ],
      },
    });
    const r = await judge(s);
    expect(r).toMatchObject({ stale: true, staleReason: "refresh_failed" });
    expect(r.lastFailureAt).toBe(ago(30 * MINUTE - 1000).toISOString());
  });

  it("failure outranks age: an old, quiet balance with a failed refresh says refresh_failed", async () => {
    const s = await seed({
      snapshot: { source: "plaid", ageMs: 3 * DAY },
      plaid: {
        lastSyncedAgoMs: 60 * HOUR,
        attempts: [
          { kind: "transactions", success: true, agoMs: 60 * HOUR },
          { kind: "balance", success: false, agoMs: 60 * HOUR - 1000 },
        ],
      },
    });
    expect(await judge(s)).toMatchObject({ stale: true, staleReason: "refresh_failed" });
  });

  it("a webhook sync after a failed balance re-read does not hide the failure", async () => {
    // Webhook syncs never call /accounts/balance/get, so they write a
    // transactions row and no balance row.
    const s = await seed({
      snapshot: { source: "plaid", ageMs: 3 * HOUR },
      plaid: {
        lastSyncedAgoMs: 1 * HOUR,
        attempts: [
          { kind: "transactions", success: true, agoMs: 2 * HOUR },
          { kind: "balance", success: false, agoMs: 2 * HOUR - 1000 },
          { kind: "transactions", success: true, agoMs: 1 * HOUR },
        ],
      },
    });
    const r = await judge(s);
    expect(r).toMatchObject({ stale: true, staleReason: "refresh_failed" });
    expect(r.lastFailureAt).toBe(ago(2 * HOUR - 1000).toISOString());
  });

  it("a failure followed by a newer success of the same kind has recovered", async () => {
    const s = await seed({
      snapshot: { source: "plaid", ageMs: 1 * HOUR },
      plaid: {
        lastSyncedAgoMs: 1 * HOUR,
        attempts: [
          { kind: "transactions", success: false, agoMs: 4 * HOUR },
          { kind: "balance", success: false, agoMs: 3 * HOUR },
          { kind: "transactions", success: true, agoMs: 1 * HOUR },
          { kind: "balance", success: true, agoMs: 1 * HOUR - 1000 },
        ],
      },
    });
    expect(await judge(s)).toMatchObject({
      stale: false,
      staleReason: null,
      lastFailureAt: null,
    });
  });

  it("a later balance success does not recover a failed transactions sync", async () => {
    // A tap on Refresh re-reads the balance on its own, but rows still are not
    // arriving.
    const s = await seed({
      snapshot: { source: "plaid", ageMs: 30 * MINUTE },
      plaid: {
        lastSyncedAgoMs: 1 * DAY,
        attempts: [
          { kind: "transactions", success: false, agoMs: 2 * HOUR },
          { kind: "balance", success: true, agoMs: 30 * MINUTE },
        ],
      },
    });
    const r = await judge(s);
    expect(r).toMatchObject({ stale: true, staleReason: "refresh_failed" });
    expect(r.lastFailureAt).toBe(ago(2 * HOUR).toISOString());
  });

  it("a failed transactions sync marks it stale", async () => {
    const s = await seed({
      snapshot: { source: "plaid", ageMs: 5 * HOUR },
      plaid: {
        lastSyncedAgoMs: 5 * HOUR,
        attempts: [
          { kind: "transactions", success: true, agoMs: 5 * HOUR },
          { kind: "transactions", success: false, agoMs: 1 * HOUR },
        ],
      },
    });
    const r = await judge(s);
    expect(r).toMatchObject({ stale: true, staleReason: "refresh_failed" });
    expect(r.lastFailureAt).toBe(ago(1 * HOUR).toISOString());
  });

  it("PRODUCT_NOT_READY is a feed warming up, not a failure", async () => {
    // A brand-new link: the only attempt so far is still preparing.
    const newLink = await seed({
      snapshot: { source: "manual", ageMs: 1 * HOUR },
      plaid: {
        attempts: [
          { kind: "transactions", success: false, agoMs: 30 * MINUTE, errorCode: "PRODUCT_NOT_READY" },
        ],
      },
    });
    expect(await judge(newLink)).toMatchObject({
      stale: false,
      staleReason: null,
      lastFailureAt: null,
    });

    // A healthy feed that briefly answered PRODUCT_NOT_READY again.
    const warm = await seed({
      snapshot: { source: "plaid", ageMs: 5 * HOUR },
      plaid: {
        lastSyncedAgoMs: 5 * HOUR,
        attempts: [
          { kind: "transactions", success: true, agoMs: 5 * HOUR },
          { kind: "transactions", success: false, agoMs: 1 * HOUR, errorCode: "PRODUCT_NOT_READY" },
        ],
      },
    });
    expect(await judge(warm)).toMatchObject({ stale: false, lastFailureAt: null });
  });

  it("a liabilities failure does not: that feed is the credit cards, not the bank", async () => {
    // It also writes `last_sync_error`, which is why failure is never read from it.
    const s = await seed({
      snapshot: { source: "plaid", ageMs: 2 * HOUR },
      plaid: {
        lastSyncedAgoMs: 2 * HOUR,
        lastSyncError: "Liability refresh failed: timeout",
        lastSyncErrorCode: null,
        attempts: [
          { kind: "transactions", success: true, agoMs: 2 * HOUR },
          { kind: "liabilities", success: false, agoMs: 1 * HOUR },
        ],
      },
    });
    expect(await judge(s)).toMatchObject({
      stale: false,
      staleReason: null,
      lastFailureAt: null,
    });
  });

  it("an item that needs a login is stale at once; a pending-expiration warning is not", async () => {
    const dead = await seed({
      snapshot: { source: "plaid", ageMs: 1 * HOUR },
      plaid: { lastSyncedAgoMs: 1 * HOUR, lastSyncErrorCode: "ITEM_LOGIN_REQUIRED" },
    });
    expect(await judge(dead)).toMatchObject({
      stale: true,
      staleReason: "refresh_failed",
      lastFailureAt: null,
    });

    const warned = await seed({
      snapshot: { source: "plaid", ageMs: 1 * HOUR },
      plaid: { lastSyncedAgoMs: 1 * HOUR, lastSyncErrorCode: "PENDING_EXPIRATION" },
    });
    expect(await judge(warned)).toMatchObject({ stale: false, staleReason: null });
  });

  it("a typed-in balance on a dead feed is stale too: the rows it rolls forward over stop arriving", async () => {
    const s = await seed({
      snapshot: { source: "manual", ageMs: 1 * DAY },
      plaid: { lastSyncedAgoMs: 3 * DAY, lastSyncErrorCode: "USER_PERMISSION_REVOKED" },
    });
    expect(await judge(s)).toMatchObject({
      source: "manual",
      stale: true,
      staleReason: "refresh_failed",
    });
  });
});

describe("computeBankFreshness — constants", () => {
  it("the dead-feed codes leave out the two pending warnings, and the limits are 48 hours and 7 days", () => {
    for (const code of ["PENDING_EXPIRATION", "PENDING_DISCONNECT"]) {
      expect(PLAID_REAUTH_ERROR_CODES.has(code)).toBe(true);
      expect(BANK_FEED_DEAD_CODES.has(code)).toBe(false);
    }
    expect(PLAID_FEED_QUIET_MS).toBe(48 * HOUR);
    expect(MANUAL_SNAPSHOT_STALE_MS).toBe(7 * DAY);
  });
});
