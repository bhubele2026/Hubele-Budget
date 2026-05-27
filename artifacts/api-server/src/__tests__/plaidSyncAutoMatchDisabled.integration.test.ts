import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createTestHousehold } from "./_helpers/testHousehold";

// (#760, Phase A) The post-sync auto-match block in plaidSync that paired
// new checking txns with planned recurring items and silently inserted
// `forecast_resolutions` rows is now gated behind a hardcoded
// `AUTO_MATCH_ENABLED = false`. This test seeds a recurring item that
// would previously have auto-matched (same sign, within $1, within ±3
// days) and asserts that after a sync importing the matching txn, ZERO
// new forecast_resolutions rows exist — proving the gate fires. It also
// asserts the info-level skip log is emitted with householdId / userId /
// itemRowId payload so production operators can see the gate running.

const OWNER_ID = `auto-match-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let HOUSEHOLD_ID: string;

type AddedTxn = {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
  pending?: boolean;
};

let nextSyncResponse: {
  added: AddedTxn[];
  modified: AddedTxn[];
  removed: { transaction_id: string }[];
} = { added: [], modified: [], removed: [] };

// Replace the real pino logger with a vitest-spyable stub so we can
// assert that the AUTO_MATCH_ENABLED=false skip log fires with the
// expected payload. pino's bound methods aren't reliably interceptable
// via `vi.spyOn(logger, "info")`, so we substitute the whole module.
// `vi.mock` is hoisted, so the stub is constructed inside the factory
// and re-fetched via `vi.mocked` in the test bodies.
vi.mock("../lib/logger", () => {
  const stub: Record<string, unknown> = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };
  stub.child = () => stub;
  return { logger: stub };
});

vi.mock("../lib/plaid", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      transactionsSync: async () => ({
        data: {
          added: nextSyncResponse.added,
          modified: nextSyncResponse.modified,
          removed: nextSyncResponse.removed,
          next_cursor: "cursor-1",
          has_more: false,
        },
      }),
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
      itemGet: async () => ({
        data: {
          item: { item_id: "item-default", consent_expiration_time: null },
        },
      }),
    }),
  };
});

import {
  db,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import { syncPlaidItem } from "../lib/plaidSync";
import { logger } from "../lib/logger";

// Retrieve the mocked logger.info as a typed vitest mock so call sites
// below can assert against `.mock.calls`. The factory above replaces
// the real pino logger with vi.fn() stubs.
const mockedLoggerInfo = vi.mocked(logger.info);

async function cleanup(): Promise<void> {
  await db
    .delete(forecastResolutionsTable)
    .where(eq(forecastResolutionsTable.householdId, HOUSEHOLD_ID));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, OWNER_ID));
  await db
    .delete(recurringItemsTable)
    .where(eq(recurringItemsTable.householdId, HOUSEHOLD_ID));
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.householdId, HOUSEHOLD_ID));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, OWNER_ID));
  await db
    .delete(plaidItemsTable)
    .where(eq(plaidItemsTable.userId, OWNER_ID));
}

beforeAll(async () => {
  const h = await createTestHousehold(OWNER_ID);
  HOUSEHOLD_ID = h.householdId;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
  nextSyncResponse = { added: [], modified: [], removed: [] };
});

async function seedItem(): Promise<{
  itemRowId: string;
  externalAcctId: string;
}> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: OWNER_ID,
      householdId: HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "Chase",
      institutionSlug: "chase",
    })
    .returning();
  const externalAcctId = `acct-${randomUUID()}`;
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: OWNER_ID,
      householdId: HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalAcctId,
      mask: "5526",
      name: "TOTAL CHECKING",
      type: "depository",
      subtype: "checking",
      firstSyncCompletedAt: new Date(),
    })
    .returning();
  // Point forecast settings at this account so `checkingPlaidAccountId`
  // resolves inside syncPlaidItem — without it, `isChecking` is always
  // false and the gated auto-match branch is never reached.
  await db
    .insert(forecastSettingsTable)
    .values({
      userId: OWNER_ID,
      householdId: HOUSEHOLD_ID,
      bankSnapshotAccountId: acct!.id,
    })
    .onConflictDoUpdate({
      target: forecastSettingsTable.userId,
      set: { bankSnapshotAccountId: acct!.id, householdId: HOUSEHOLD_ID },
    });
  return { itemRowId: item!.id, externalAcctId };
}

async function seedRecurringItem(opts: {
  name: string;
  amount: string;
  dayOfMonth: number;
}): Promise<void> {
  await db.insert(recurringItemsTable).values({
    userId: OWNER_ID,
    householdId: HOUSEHOLD_ID,
    name: opts.name,
    kind: "bill",
    amount: opts.amount,
    frequency: "monthly",
    dayOfMonth: opts.dayOfMonth,
  });
}

describe("syncPlaidItem auto-match kill-switch (#760, Phase A)", () => {
  it("does NOT insert forecast_resolutions when a new checking txn matches a planned recurring item", async () => {
    const { itemRowId, externalAcctId } = await seedItem();
    // A planned bill on the 13th for $450 — pre-gate this would have
    // been auto-matched (same sign, $0 delta, 0 days away) to the
    // incoming AMERICAN EXPRESS ACH PMT on 2026-05-13.
    await seedRecurringItem({
      name: "Amex Card Payment",
      amount: "-450",
      dayOfMonth: 13,
    });

    nextSyncResponse = {
      added: [
        {
          transaction_id: `txn-${randomUUID()}`,
          account_id: externalAcctId,
          date: "2026-05-13",
          amount: 450, // Plaid debits positive → stored as -450
          name: "AMERICAN EXPRESS ACH PMT",
        },
      ],
      modified: [],
      removed: [],
    };

    await syncPlaidItem(OWNER_ID, itemRowId);

    // The txn was imported …
    const txns = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.householdId, HOUSEHOLD_ID));
    expect(txns.length).toBe(1);
    expect(Number(txns[0].amount)).toBe(-450);

    // … but NO resolution row was created on the household's behalf.
    const resolutions = await db
      .select()
      .from(forecastResolutionsTable)
      .where(eq(forecastResolutionsTable.householdId, HOUSEHOLD_ID));
    expect(resolutions.length).toBe(0);
  });

  it("emits the AUTO_MATCH_ENABLED=false skip log with household/user/item context when checking txns were inserted", async () => {
    const { itemRowId, externalAcctId } = await seedItem();
    await seedRecurringItem({
      name: "Electric Bill",
      amount: "-120.45",
      dayOfMonth: 9,
    });
    nextSyncResponse = {
      added: [
        {
          transaction_id: `txn-${randomUUID()}`,
          account_id: externalAcctId,
          date: "2026-05-10",
          amount: 120.45,
          name: "PG&E ELECTRIC",
        },
      ],
      modified: [],
      removed: [],
    };

    mockedLoggerInfo.mockClear();
    await syncPlaidItem(OWNER_ID, itemRowId);

    const skipCalls = mockedLoggerInfo.mock.calls.filter(
      (call) =>
        typeof call[1] === "string" &&
        (call[1] as string).includes(
          "forecast auto-match skipped (AUTO_MATCH_ENABLED=false)",
        ),
    );
    expect(skipCalls.length).toBe(1);
    const payload = skipCalls[0][0] as {
      householdId: string;
      userId: string;
      itemRowId: string;
      skippedCheckingTxnCount: number;
    };
    expect(payload.householdId).toBe(HOUSEHOLD_ID);
    expect(payload.userId).toBe(OWNER_ID);
    expect(payload.itemRowId).toBe(itemRowId);
    expect(payload.skippedCheckingTxnCount).toBe(1);

    // Belt-and-suspenders: also confirm no resolution row was written.
    const resolutions = await db
      .select()
      .from(forecastResolutionsTable)
      .where(eq(forecastResolutionsTable.householdId, HOUSEHOLD_ID));
    expect(resolutions.length).toBe(0);
  });

  it("does NOT emit the skip log when a sync produces zero new checking txns", async () => {
    const { itemRowId } = await seedItem();
    nextSyncResponse = { added: [], modified: [], removed: [] };

    mockedLoggerInfo.mockClear();
    await syncPlaidItem(OWNER_ID, itemRowId);

    const skipCalls = mockedLoggerInfo.mock.calls.filter(
      (call) =>
        typeof call[1] === "string" &&
        (call[1] as string).includes(
          "forecast auto-match skipped (AUTO_MATCH_ENABLED=false)",
        ),
    );
    expect(skipCalls.length).toBe(0);
  });
});
