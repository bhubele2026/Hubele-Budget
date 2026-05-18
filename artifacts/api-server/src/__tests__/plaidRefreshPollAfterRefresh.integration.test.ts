// (#671) Poll-after-refresh contract for syncPlaidItem.
//
// /transactions/refresh asks Plaid to re-fetch from the bank but the
// API returns immediately — Plaid then ingests the new rows into its
// own cache *asynchronously*. If we walk /transactions/sync the moment
// refresh resolves, the cursor frequently returns empty even though
// the bank had fresh pending charges. syncPlaidItem now re-walks the
// cursor a couple of times with short backoffs in that case so a
// single manual Sync click lands the data instead of leaving the user
// with "Added 0" and a stale forecast.
//
// Verifies:
//   1. When forceRefresh=true and the first cursor walk is empty,
//      syncPlaidItem retries the walk and picks up the rows that
//      arrived in Plaid's cache on the second attempt.
//   2. When forceRefresh=true and the first cursor walk has data, the
//      sync returns immediately without spending the retry budget.
//   3. When forceRefresh=false, no retries are spent — the cursor-only
//      hourly/webhook path stays cheap.

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
import { eq } from "drizzle-orm";

const TEST_USER = `poll-refresh-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
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

type SyncResp = {
  added: Array<Record<string, unknown>>;
  modified: Array<Record<string, unknown>>;
  removed: Array<{ transaction_id: string }>;
  next_cursor: string;
  has_more: boolean;
};

let transactionsRefreshCalls = 0;
let transactionsSyncCalls = 0;
let transactionsSyncResponses: SyncResp[] = [];

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>(
    "../lib/plaid",
  );
  return {
    ...actual,
    plaid: () => ({
      transactionsRefresh: async () => {
        transactionsRefreshCalls++;
        return { data: {} };
      },
      transactionsSync: async () => {
        // Drain the queue; if the test queued one response, repeat it
        // (forceRefresh path always finishes the inner cursor walk
        // when has_more=false, so each "outer attempt" corresponds to
        // exactly one /transactions/sync call when no pagination is in
        // play).
        transactionsSyncCalls++;
        const next = transactionsSyncResponses.shift();
        if (next) return { data: next };
        return {
          data: {
            added: [],
            modified: [],
            removed: [],
            next_cursor: "",
            has_more: false,
          } satisfies SyncResp,
        };
      },
      accountsBalanceGet: async () => ({ data: { accounts: [] } }),
      itemGet: async () => ({
        data: { item: { item_id: "x", consent_expiration_time: null } },
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
import { createTestHousehold } from "./_helpers/testHousehold";

// Tight backoffs so the retry budget completes in under ~100ms.
process.env.PLAID_REFRESH_POLL_DELAYS_MS = "10,10";

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
  const h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = h.householdId;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
  transactionsRefreshCalls = 0;
  transactionsSyncCalls = 0;
  transactionsSyncResponses = [];
});

async function seedItem(): Promise<{ itemRowId: string; externalAccountId: string }> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "Chase",
      institutionSlug: "chase",
    })
    .returning();
  const externalAccountId = `acct-${randomUUID()}`;
  await db.insert(plaidAccountsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    itemId: item!.id,
    accountId: externalAccountId,
    name: "Chase Checking",
    mask: "1234",
    type: "depository",
    subtype: "checking",
  });
  return { itemRowId: item!.id, externalAccountId };
}

function emptyResp(): SyncResp {
  return {
    added: [],
    modified: [],
    removed: [],
    next_cursor: "c1",
    has_more: false,
  };
}

function addedResp(externalAccountId: string): SyncResp {
  return {
    added: [
      {
        transaction_id: `txn-${randomUUID()}`,
        account_id: externalAccountId,
        amount: 12.34,
        date: "2026-05-15",
        pending: true,
        name: "Test Pending Charge",
      },
    ],
    modified: [],
    removed: [],
    next_cursor: "c2",
    has_more: false,
  };
}

describe("(#671) poll-after-refresh in syncPlaidItem", () => {
  it("retries the cursor walk when forceRefresh=true and the first walk is empty", async () => {
    const { itemRowId, externalAccountId } = await seedItem();
    // First attempt: refresh succeeds but Plaid's cache hasn't ingested
    // the new pending charge yet → empty. Second attempt: cache caught
    // up → one new pending row.
    transactionsSyncResponses.push(emptyResp(), addedResp(externalAccountId));

    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      forceRefresh: true,
    });

    expect(transactionsRefreshCalls).toBe(1);
    expect(result.added).toBe(1);
    expect(result.error ?? null).toBeNull();

    // Confirm the row actually landed in Postgres — this is the user-
    // facing contract, not just an in-memory counter.
    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).toBe("Test Pending Charge");
  });

  it("(#717) polls one extra empty drain after fresh data lands to confirm Plaid finished ingesting", async () => {
    // Before #717 the sync broke on the first non-empty cursor walk,
    // which on real Chase items routinely drained the *stale historical
    // backlog* sitting in the cursor from before /transactions/refresh
    // and stopped before the freshly ingested rows landed — exactly how
    // a user's healthy item ended up with 48 April rows and zero of
    // the May 14–18 transactions the refresh was asking for. The fix
    // keeps polling until we see an empty drain (Plaid has clearly
    // finished writing) once at least one row is in hand.
    const { itemRowId, externalAccountId } = await seedItem();
    transactionsSyncResponses.push(addedResp(externalAccountId));

    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      forceRefresh: true,
    });

    expect(result.added).toBe(1);
    expect(result.stillPreparing ?? false).toBe(false);
    // The queued addedResp was consumed; one follow-up walk fired and
    // hit the default-empty branch (no further queued responses), so
    // the queue is still drained to zero. Sync then exits because the
    // empty drain confirmed ingestion settled. Asserting the *call
    // count* directly (not just queue length) pins the new contract:
    // exactly TWO /transactions/sync calls — the first that returned
    // the row, plus the confirm-settled empty drain.
    expect(transactionsSyncResponses.length).toBe(0);
    expect(transactionsSyncCalls).toBe(2);
  });

  it("(#717) keeps draining stale historical rows until fresh post-refresh rows arrive", async () => {
    // Reproduces the production Chase incident: attempt #1 drains
    // historical April rows that were already sitting in the cursor,
    // attempt #2 surfaces the freshly-refreshed May rows Plaid just
    // ingested, attempt #3 confirms settled with an empty drain. All
    // four rows must land in Postgres — never just the stale four.
    const { itemRowId, externalAccountId } = await seedItem();
    const staleApril: SyncResp = {
      added: [
        {
          transaction_id: `txn-${randomUUID()}`,
          account_id: externalAccountId,
          amount: 11.11,
          date: "2026-04-17",
          pending: false,
          name: "Stale April Charge A",
        },
        {
          transaction_id: `txn-${randomUUID()}`,
          account_id: externalAccountId,
          amount: 22.22,
          date: "2026-04-24",
          pending: false,
          name: "Stale April Charge B",
        },
      ],
      modified: [],
      removed: [],
      next_cursor: "c-after-stale",
      has_more: false,
    };
    const freshMay: SyncResp = {
      added: [
        {
          transaction_id: `txn-${randomUUID()}`,
          account_id: externalAccountId,
          amount: 33.33,
          date: "2026-05-15",
          pending: true,
          name: "Fresh May Pending A",
        },
        {
          transaction_id: `txn-${randomUUID()}`,
          account_id: externalAccountId,
          amount: 44.44,
          date: "2026-05-18",
          pending: true,
          name: "Fresh May Pending B",
        },
      ],
      modified: [],
      removed: [],
      next_cursor: "c-after-fresh",
      has_more: false,
    };
    transactionsSyncResponses.push(staleApril, freshMay);

    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      forceRefresh: true,
    });

    expect(transactionsRefreshCalls).toBe(1);
    expect(result.added).toBe(4);
    expect(result.error ?? null).toBeNull();
    expect(result.stillPreparing ?? false).toBe(false);
    // Critically: the freshest row in the importedDateRange must be
    // the fresh May row, not the stale April row. The old code returned
    // 2026-04-24 here and shipped that to the toast.
    expect(result.importedDateRange).toEqual({
      min: "2026-04-17",
      max: "2026-05-18",
    });
    expect(result.lastOccurredOn).toBe("2026-05-18");

    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(rows).toHaveLength(4);
    const dates = rows.map((r) => r.occurredOn).sort();
    expect(dates).toEqual(["2026-04-17", "2026-04-24", "2026-05-15", "2026-05-18"]);
  });

  it("returns stillPreparing=true when refresh succeeded and the retry budget is exhausted with zero rows", async () => {
    // Layer 1 contract: Plaid accepted /transactions/refresh but its
    // cache still hadn't ingested by the time the (3-attempt default)
    // budget ran out. The sync must signal "still preparing" so the
    // UI skips the destructive "Added 0" toast and offers a retry —
    // same UX as the PRODUCT_NOT_READY catch path.
    const { itemRowId } = await seedItem();
    // Queue more empty responses than the retry budget so every
    // attempt returns empty.
    transactionsSyncResponses.push(
      emptyResp(),
      emptyResp(),
      emptyResp(),
      emptyResp(),
      emptyResp(),
    );

    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      forceRefresh: true,
    });

    expect(transactionsRefreshCalls).toBe(1);
    expect(result.added).toBe(0);
    expect(result.modified).toBe(0);
    expect(result.error ?? null).toBeNull();
    expect(result.stillPreparing).toBe(true);
  });

  it("does NOT set stillPreparing when data lands within the retry budget", async () => {
    // Negative case for the previous test: as long as some row landed
    // (even on the last attempt), we treat the sync as a normal
    // success — never stillPreparing.
    const { itemRowId, externalAccountId } = await seedItem();
    transactionsSyncResponses.push(emptyResp(), addedResp(externalAccountId));

    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      forceRefresh: true,
    });

    expect(result.added).toBe(1);
    expect(result.stillPreparing ?? false).toBe(false);
  });

  it("does NOT set stillPreparing when forceRefresh=false (cursor-only path)", async () => {
    // Cron/webhook paths intentionally don't fire /transactions/refresh,
    // so a zero-row walk is a true no-op — not a "still preparing"
    // condition. Only the user-driven refresh path should ever flip
    // the flag.
    const { itemRowId } = await seedItem();
    transactionsSyncResponses.push(emptyResp());

    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      forceRefresh: false,
    });

    expect(result.added).toBe(0);
    expect(result.stillPreparing ?? false).toBe(false);
  });

  it("does not retry when forceRefresh=false (hourly cron / webhook path stays cheap)", async () => {
    const { itemRowId } = await seedItem();
    // Queue two empty responses — only the first should be consumed.
    transactionsSyncResponses.push(emptyResp(), emptyResp());

    const result = await syncPlaidItem(TEST_USER, itemRowId, {
      forceRefresh: false,
    });

    expect(transactionsRefreshCalls).toBe(0);
    expect(result.added).toBe(0);
    // Exactly one /transactions/sync call → one response consumed.
    expect(transactionsSyncResponses.length).toBe(1);
  });
});
