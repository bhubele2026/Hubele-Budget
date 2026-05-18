/**
 * (#720) Regression test: when /transactions/sync returns an empty
 * delta for a healthy item whose last_occurred_on is >24h stale and
 * the caller passed forceRefresh=true (the manual Sync button), the
 * sync must fall back to /transactions/get for every account and
 * land the gap rows without duplicating any existing row.
 *
 * Reproduces the Chase scenario where Plaid's background poll lagged
 * for 48h, leaving cursor sync stuck at "Added 0" while the bank had
 * fresh activity to give up.
 */
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
import { and, eq } from "drizzle-orm";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `stalecur-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

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
    req.userId = TEST_USER;
    req.actualUserId = TEST_USER;
    req.householdId = TEST_HOUSEHOLD_ID;
    req.householdOwnerId = TEST_USER;
    next();
  },
}));

type GetTxn = {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
  pending?: boolean;
  merchant_name?: string;
};

let nextGetResponse: GetTxn[] = [];

vi.mock("../lib/plaid", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      transactionsSync: async () => ({
        data: {
          added: [],
          modified: [],
          removed: [],
          next_cursor: "cursor-empty",
          has_more: false,
        },
      }),
      transactionsGet: async () => ({
        data: {
          transactions: nextGetResponse,
          total_transactions: nextGetResponse.length,
        },
      }),
      transactionsRefresh: async () => {
        // Simulate the institution lacking the transactions_refresh add-on,
        // exactly like the real production Chase / Amex items observed in
        // the prod DB. The catch path stamps refresh_product_disabled_at
        // and the gap-backfill below is what actually delivers rows.
        const err: { response: { status: number; data: { error_code: string; error_message: string } } } = {
          response: {
            status: 400,
            data: {
              error_code: "INVALID_PRODUCT",
              error_message: "transactions_refresh is not an enabled product",
            },
          },
        };
        throw err;
      },
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
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { syncPlaidItem } from "../lib/plaidSync";

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
  nextGetResponse = [];
});

async function seedStaleChase(): Promise<{
  itemRowId: string;
  externalAcctId: string;
  preExistingRowId: string;
}> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "Chase",
      institutionSlug: "chase",
      cursor: "stale-cursor-from-2-days-ago",
      // Already past the first-sync gate so the cutoff doesn't filter
      // any of the gap-backfill rows.
    })
    .returning();
  const externalAcctId = `acct-${randomUUID()}`;
  await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalAcctId,
      name: "Chase Checking",
      type: "depository",
      subtype: "checking",
      firstSyncCompletedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    })
    .returning();
  // Pre-existing row 3 days old — establishes the stale max(occurred_on)
  // that drives the >24h staleness detection.
  const threeDaysAgoIso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const [pre] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: threeDaysAgoIso,
      description: "Old Plaid Row",
      amount: "-12.50",
      source: "plaid:chase",
      plaidTransactionId: `pre-existing-ptid-${randomUUID()}`,
      plaidAccountId: externalAcctId,
    })
    .returning();
  return { itemRowId: item!.id, externalAcctId, preExistingRowId: pre!.id };
}

describe("(#720) Stale-cursor gap-backfill fallback", () => {
  it("falls back to /transactions/get when cursor returns empty AND item is >24h stale, lands gap rows without duplicates", async () => {
    const { itemRowId, externalAcctId, preExistingRowId } =
      await seedStaleChase();

    // Today and yesterday (gap window)
    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);
    const yesterdayIso = new Date(today.getTime() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    // /transactions/get returns the gap rows the cursor never delivered,
    // plus one row whose (account, date, amount) collides with the
    // pre-existing row but carries a *different* transaction_id — the
    // re-mint case the ±2-day dedup safety net must catch.
    const remintDateMatchesPre = await db
      .select({ occurredOn: transactionsTable.occurredOn })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, preExistingRowId));
    const preDate = remintDateMatchesPre[0].occurredOn;
    nextGetResponse = [
      {
        transaction_id: "new-ptid-kfi",
        account_id: externalAcctId,
        date: yesterdayIso,
        amount: -7376.67, // Plaid sign: positive=debit, our sign flips => +7376.67
        name: "KFI Staffing payroll",
      },
      {
        transaction_id: "new-ptid-lakeview",
        account_id: externalAcctId,
        date: yesterdayIso,
        amount: 2085.79,
        name: "Lakeview LN SRV MTG",
      },
      {
        transaction_id: "new-ptid-amex",
        account_id: externalAcctId,
        date: todayIso,
        amount: 3200.0,
        name: "AMEX pmt",
      },
      {
        // Re-mint of the pre-existing row: same (account, date, -12.50)
        // but a brand-new transaction_id. Must adopt in place, not insert.
        transaction_id: "remint-ptid",
        account_id: externalAcctId,
        date: preDate,
        amount: 12.5, // Plaid sign -> our -12.50
        name: "Re-mint sibling",
      },
    ];

    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      forceRefresh: true,
      syncOrigin: "manual",
    });

    // Three brand-new rows landed via gap-backfill; re-mint did NOT count.
    expect(result.added).toBe(3);
    expect(result.deliveryMode).toBe("gap-backfill");

    // Pre-existing row still exists, now with the new plaid_transaction_id.
    const allRows = await db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, TEST_HOUSEHOLD_ID),
          eq(transactionsTable.plaidAccountId, externalAcctId),
        ),
      );
    // 1 (pre-existing re-minted) + 3 (new gap rows) = 4
    expect(allRows).toHaveLength(4);
    const reminted = allRows.find((r) => r.id === preExistingRowId);
    expect(reminted).toBeDefined();
    expect(reminted!.plaidTransactionId).toBe("remint-ptid");

    // No duplicate (account, date, amount, description) quadruple
    const seen = new Set<string>();
    for (const r of allRows) {
      const key = `${r.plaidAccountId}|${r.occurredOn}|${r.amount}|${r.description}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }

    // The INVALID_PRODUCT path stamped refresh_product_disabled_at so
    // subsequent syncs skip the doomed /transactions/refresh call.
    const [postItem] = await db
      .select()
      .from(plaidItemsTable)
      .where(eq(plaidItemsTable.id, itemRowId));
    expect(postItem.refreshProductDisabledAt).not.toBeNull();
  });

  it("does NOT run gap-backfill on webhook-triggered sync even with forceRefresh, so LOGIN_REPAIRED doesn't double-fetch", async () => {
    const { itemRowId, externalAcctId } = await seedStaleChase();
    nextGetResponse = [
      {
        transaction_id: "webhook-should-be-ignored",
        account_id: externalAcctId,
        date: new Date().toISOString().slice(0, 10),
        amount: -100,
        name: "Webhook poisoned response",
      },
    ];

    // Webhook path: forceRefresh:true (LOGIN_REPAIRED re-walks fresh
    // data) but syncOrigin omitted → defaults to "webhook" → stale
    // fallback MUST NOT fire.
    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      forceRefresh: true,
    });

    expect(result.added).toBe(0);
    expect(result.deliveryMode).not.toBe("gap-backfill");

    const allRows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.plaidAccountId, externalAcctId));
    // Only the pre-existing seed row — the webhook-poisoned /get
    // response was never consulted.
    expect(allRows).toHaveLength(1);
  });
});
