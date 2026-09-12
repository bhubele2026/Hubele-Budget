import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq } from "drizzle-orm";

/**
 * (PR-E review) Failure rows must not crowd out freshness data, and a
 * household's owner must see a failure a member's sync recorded.
 */

const OWNER = `attempt-burst-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const MEMBER = `${OWNER}-member`;
let HOUSEHOLD_ID: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: {
      userId?: string;
      actualUserId?: string;
      householdId?: string;
      householdOwnerId?: string;
    },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = OWNER;
    req.actualUserId = OWNER;
    req.householdId = HOUSEHOLD_ID;
    req.householdOwnerId = OWNER;
    next();
  },
}));

import {
  db,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  plaidSyncAttemptsTable,
} from "@workspace/db";
import plaidRouter from "../routes/plaid";
import {
  PLAID_SYNC_ATTEMPT_KEEP_PER_ITEM,
  prunePlaidSyncAttempts,
  recordPlaidSyncAttempt,
} from "../lib/plaidSyncAttempts";
import { computeBankFreshness } from "../lib/bankFreshness";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(plaidRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, OWNER));
  // Attempts go with their item (ON DELETE CASCADE), whoever wrote them.
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, OWNER));
}

beforeAll(async () => {
  HOUSEHOLD_ID = (await createTestHousehold(OWNER)).householdId;
  await cleanup();
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await cleanup();
  await new Promise<void>((res) => server.close(() => res()));
});
beforeEach(cleanup);

/** A checking snapshot on a Plaid item, as bankFreshness reads it. */
async function seedBank(): Promise<string> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: OWNER,
      householdId: HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: "test-token",
      institutionName: "Chase",
      institutionSlug: "chase",
      lastSyncedAt: new Date(Date.now() - 60 * 60 * 1000),
    })
    .returning();
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: OWNER,
      householdId: HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: `acct-${randomUUID()}`,
      name: "Chase Checking",
      mask: "1111",
      type: "depository",
      subtype: "checking",
    })
    .returning();
  await db.insert(forecastSettingsTable).values({
    userId: OWNER,
    householdId: HOUSEHOLD_ID,
    bankSnapshotBalance: "1000.00",
    bankSnapshotAt: new Date(Date.now() - 60 * 60 * 1000),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: acct!.id,
    bankSnapshotMask: "1111",
  });
  return item!.id;
}

async function rows(itemRowId: string, kind?: string) {
  return db
    .select()
    .from(plaidSyncAttemptsTable)
    .where(
      kind
        ? and(eq(plaidSyncAttemptsTable.plaidItemId, itemRowId), eq(plaidSyncAttemptsTable.kind, kind))
        : eq(plaidSyncAttemptsTable.plaidItemId, itemRowId),
    );
}

const bankDown = { errorCode: "INTERNAL_SERVER_ERROR", errorMessage: "bank down (test)" };

describe("(PR-E review) failure rows", () => {
  it("a burst of the same liabilities failure is one row, so freshness still sees the newest balance attempt after pruning", async () => {
    const itemRowId = await seedBank();
    await recordPlaidSyncAttempt({
      userId: OWNER,
      plaidItemId: itemRowId,
      kind: "balance",
      success: false,
      ...bankDown,
    });
    for (let i = 0; i < PLAID_SYNC_ATTEMPT_KEEP_PER_ITEM + 10; i++) {
      await recordPlaidSyncAttempt({
        userId: OWNER,
        plaidItemId: itemRowId,
        kind: "liabilities",
        success: false,
        ...bankDown,
      });
    }

    await prunePlaidSyncAttempts();

    expect(await rows(itemRowId, "liabilities")).toHaveLength(1);
    expect(await rows(itemRowId, "balance")).toHaveLength(1);
    const freshness = await computeBankFreshness(HOUSEHOLD_ID, OWNER);
    expect(freshness.staleReason).toBe("refresh_failed");
    expect(freshness.lastFailureAt).not.toBeNull();
  });

  it("a repeat moves the row's timestamp; a new error, a success in between, or an hour's gap writes a new row", async () => {
    const itemRowId = await seedBank();
    const fail = (errorMessage: string) =>
      recordPlaidSyncAttempt({
        userId: OWNER,
        plaidItemId: itemRowId,
        kind: "liabilities",
        success: false,
        errorCode: "INTERNAL_SERVER_ERROR",
        errorMessage,
      });

    await fail("A");
    const [first] = await rows(itemRowId);
    await new Promise((r) => setTimeout(r, 5));
    await fail("A");
    const afterRepeat = await rows(itemRowId);
    expect(afterRepeat).toHaveLength(1);
    expect(afterRepeat[0]!.attemptedAt.getTime()).toBeGreaterThan(first!.attemptedAt.getTime());

    await fail("B");
    expect(await rows(itemRowId)).toHaveLength(2);

    await recordPlaidSyncAttempt({
      userId: OWNER,
      plaidItemId: itemRowId,
      kind: "liabilities",
      success: true,
    });
    await fail("B");
    expect(await rows(itemRowId)).toHaveLength(4);

    // The newest failure is now two hours old: the same error writes a new row.
    const newest = (await rows(itemRowId))
      .filter((r) => !r.success && r.errorMessage === "B")
      .sort((a, b) => b.attemptedAt.getTime() - a.attemptedAt.getTime())[0]!;
    await db
      .update(plaidSyncAttemptsTable)
      .set({ attemptedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(plaidSyncAttemptsTable.id, newest.id));
    await fail("B");
    expect(await rows(itemRowId)).toHaveLength(5);
  });

  it("the owner sees a failure a household member's sync recorded", async () => {
    const itemRowId = await seedBank();
    await recordPlaidSyncAttempt({
      userId: MEMBER,
      plaidItemId: itemRowId,
      kind: "amex_anchor",
      success: false,
      errorMessage: "estimate refresh failed (test)",
    });

    const res = await fetch(`${baseUrl}/plaid/items/${itemRowId}/sync-attempts`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempts: Array<{ kind: string; success: boolean }> };
    expect(body.attempts.map((a) => [a.kind, a.success])).toEqual([["amex_anchor", false]]);
  });
});
