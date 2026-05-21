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
import { and, eq, inArray } from "drizzle-orm";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `vanpend-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

type Txn = {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
  pending?: boolean;
};

// Cursor-sync mock state
let nextSyncResponse: {
  added: Txn[];
  modified: Txn[];
  removed: { transaction_id: string }[];
} = { added: [], modified: [], removed: [] };

// /transactions/get mock state for the gap-backfill path
let nextGetResponse: { transactions: Txn[]; total_transactions: number } = {
  transactions: [],
  total_transactions: 0,
};

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
          next_cursor: "cursor-x",
          has_more: false,
        },
      }),
      transactionsGet: async () => ({ data: nextGetResponse }),
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
  debtsTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  plaidSyncAttemptsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import { runGapBackfillForItem, syncPlaidItem } from "../lib/plaidSync";

async function cleanup(): Promise<void> {
  await db
    .delete(forecastResolutionsTable)
    .where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db
    .delete(recurringItemsTable)
    .where(eq(recurringItemsTable.userId, TEST_USER));
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db
    .delete(plaidSyncAttemptsTable)
    .where(eq(plaidSyncAttemptsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
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
  nextSyncResponse = { added: [], modified: [], removed: [] };
  nextGetResponse = { transactions: [], total_transactions: 0 };
});

async function seedAmexItem(): Promise<{
  itemRowId: string;
  acctRowId: string;
  externalAcctId: string;
}> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "American Express",
      institutionSlug: "amex",
      // Pretend this account has already completed a first sync, so
      // the #361 first-sync cutoff gate doesn't interfere with the
      // pending sweep we're actually exercising here.
      cursor: "prior-cursor",
    })
    .returning();
  const externalAcctId = `acct-${randomUUID()}`;
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalAcctId,
      name: "Amex Gold",
      type: "credit",
      subtype: "credit card",
      firstSyncCompletedAt: new Date("2026-04-01T00:00:00Z"),
    })
    .returning();
  return { itemRowId: item!.id, acctRowId: acct!.id, externalAcctId };
}

describe("(#732) vanished pending sweep", () => {
  it("cursor sync SAFETY: an empty cursor delta does NOT delete unchanged in-flight pendings", async () => {
    // Regression guard against the obvious-but-wrong implementation
    // of #732 that wires the sweep into the cursor path. Plaid's
    // /transactions/sync is delta-based — an unchanged pending will
    // simply not appear in `added`/`modified` on a quiet cycle. If
    // the cursor path swept based on "id absent from this delta",
    // every still-in-flight pending would be falsely deleted the
    // first time Plaid had nothing new to report. This test pins
    // that behavior: cursor sync with an empty delta must leave the
    // local pending exactly where it is.
    const { itemRowId, externalAcctId } = await seedAmexItem();

    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-12",
      description: "In-flight pending Plaid simply isn't re-emitting",
      amount: "-42.00",
      source: "plaid:amex",
      plaidAccountId: externalAcctId,
      plaidTransactionId: "plaid-inflight-pending",
      pending: true,
    });

    nextSyncResponse = { added: [], modified: [], removed: [] };
    await syncPlaidItem(TEST_USER, itemRowId);

    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(rows).toHaveLength(1);
    expect(rows[0].plaidTransactionId).toBe("plaid-inflight-pending");
    expect(rows[0].pending).toBe(true);
  });

  it("cursor sync: a pending that flipped to posted under the same plaid_transaction_id is preserved via the upsert", async () => {
    // Smoke check for the existing cursor upsert lifecycle — flips
    // the pending boolean in place instead of inserting/deleting.
    // The sweep doesn't run on this path; the upsert is what carries
    // pending → posted transitions.
    const { itemRowId, externalAcctId } = await seedAmexItem();

    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-12",
      description: "Restaurant (pending)",
      amount: "-32.10",
      source: "plaid:amex",
      plaidAccountId: externalAcctId,
      plaidTransactionId: "plaid-rest",
      pending: true,
    });

    nextSyncResponse = {
      added: [],
      modified: [
        {
          transaction_id: "plaid-rest",
          account_id: externalAcctId,
          date: "2026-05-13",
          amount: 32.1,
          name: "Restaurant",
          pending: false,
        },
      ],
      removed: [],
    };

    await syncPlaidItem(TEST_USER, itemRowId);

    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(rows).toHaveLength(1);
    expect(rows[0].plaidTransactionId).toBe("plaid-rest");
    expect(rows[0].pending).toBe(false);
  });

  it("gap-backfill: cleans up forecast_resolutions pointing at the doomed pending row", async () => {
    const { itemRowId, externalAcctId } = await seedAmexItem();

    const [pending] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-15",
        description: "Vanishing pre-auth",
        amount: "-50.00",
        source: "plaid:amex",
        plaidAccountId: externalAcctId,
        plaidTransactionId: "plaid-vanish-res",
        pending: true,
      })
      .returning();
    const [recurring] = await db
      .insert(recurringItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Some bill",
        amount: "-50.00",
        frequency: "monthly",
        dayOfMonth: 15,
      })
      .returning();
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      recurringItemId: recurring!.id,
      occurrenceDate: "2026-05-15",
      status: "matched",
      matchedTxnId: pending!.id,
    });

    // Plaid returns nothing in the gap-backfill window — the pending
    // silently vanished. The cascade must drop the
    // forecast_resolutions row first so the txn delete doesn't fail
    // on a dangling FK.
    nextGetResponse = { transactions: [], total_transactions: 0 };
    await runGapBackfillForItem(TEST_USER, itemRowId, {
      today: new Date("2026-05-20T12:00:00Z"),
      overlapDays: 1,
    });

    const txns = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(txns).toHaveLength(0);
    const resolutions = await db
      .select()
      .from(forecastResolutionsTable)
      .where(eq(forecastResolutionsTable.userId, TEST_USER));
    expect(resolutions).toHaveLength(0);
  });

  it("gap-backfill: deletes a vanished pending inside the fetched window and leaves still-reported and out-of-window pendings alone", async () => {
    const { itemRowId, externalAcctId } = await seedAmexItem();

    // Seed: a still-pending charge at 2026-05-16 anchors the
    // gap-backfill window. With overlapDays:1 (the same value the
    // stale-cursor branch uses), startStr = lastBankTxOn - 1 day =
    // 2026-05-15, so the [2026-05-15, today] window includes the
    // vanishing pre-auth at 2026-05-15 — the exact lifecycle this
    // sweep exists to clean up.
    await db.insert(transactionsTable).values([
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-15",
        description: "Vanishing pre-auth",
        amount: "-77.00",
        source: "plaid:amex",
        plaidAccountId: externalAcctId,
        plaidTransactionId: "plaid-vanish-bf",
        pending: true,
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-16",
        description: "Still-pending charge",
        amount: "-8.00",
        source: "plaid:amex",
        plaidAccountId: externalAcctId,
        plaidTransactionId: "plaid-still-bf",
        pending: true,
      },
      // (#734) Older pending that Plaid is STILL reporting — must
      // survive. After #734 the gap-backfill window is widened back
      // to the oldest local pending, so this row is now inside the
      // fetched window; what protects it from the sweep is Plaid
      // re-emitting its id, not the window floor sitting above it.
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-04-15",
        description: "Old still-reported pending",
        amount: "-3.00",
        source: "plaid:amex",
        plaidAccountId: externalAcctId,
        plaidTransactionId: "plaid-old-pending",
        pending: true,
      },
    ]);

    nextGetResponse = {
      transactions: [
        {
          transaction_id: "plaid-still-bf",
          account_id: externalAcctId,
          date: "2026-05-16",
          amount: 8.0,
          name: "Still-pending charge",
          pending: true,
        },
        {
          transaction_id: "plaid-old-pending",
          account_id: externalAcctId,
          date: "2026-04-15",
          amount: 3.0,
          name: "Old still-reported pending",
          pending: true,
        },
      ],
      total_transactions: 2,
    };

    await runGapBackfillForItem(TEST_USER, itemRowId, {
      today: new Date("2026-05-20T12:00:00Z"),
      overlapDays: 1,
    });

    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    const ptids = rows.map((r) => r.plaidTransactionId).sort();
    expect(ptids).toEqual(["plaid-old-pending", "plaid-still-bf"]);
  });

  it("(#734) gap-backfill: widens window to oldest local pending so a vanished pre-auth older than the newest local row is still swept", async () => {
    // Regression for #734. The original window was anchored strictly
    // at max(occurredOn) of all local Plaid rows for the account (with
    // an optional 1-day overlap). The moment a newer pending lands
    // locally, the floor jumps past every older still-pending row, so
    // a vanished older pre-auth could never be reconciled via the
    // gap-backfill path. After the fix, startStr is widened to
    // min(startStr, oldestLocalPendingOn) so Plaid is asked about the
    // full pending range.
    const { itemRowId, externalAcctId } = await seedAmexItem();

    await db.insert(transactionsTable).values([
      // Vanishing OLD pending — older than the newest local row. With
      // the pre-#734 window (anchored at 2026-05-18 - 1 day =
      // 2026-05-17) this row at 2026-05-02 would fall outside the
      // sweep window and survive forever.
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-02",
        description: "Old vanishing pre-auth",
        amount: "-44.00",
        source: "plaid:amex",
        plaidAccountId: externalAcctId,
        plaidTransactionId: "plaid-old-vanish",
        pending: true,
      },
      // Newer posted row that anchors max(occurredOn) and would
      // otherwise pin the gap-backfill window past the old pending.
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-18",
        description: "Recent posted charge",
        amount: "-12.00",
        source: "plaid:amex",
        plaidAccountId: externalAcctId,
        plaidTransactionId: "plaid-recent-posted",
        pending: false,
      },
    ]);

    // Plaid no longer reports the old pending. The recent posted row
    // is re-emitted (idempotent upsert).
    nextGetResponse = {
      transactions: [
        {
          transaction_id: "plaid-recent-posted",
          account_id: externalAcctId,
          date: "2026-05-18",
          amount: 12.0,
          name: "Recent posted charge",
          pending: false,
        },
      ],
      total_transactions: 1,
    };

    await runGapBackfillForItem(TEST_USER, itemRowId, {
      today: new Date("2026-05-20T12:00:00Z"),
      overlapDays: 1,
    });

    const rows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    const ptids = rows.map((r) => r.plaidTransactionId).sort();
    expect(ptids).toEqual(["plaid-recent-posted"]);
  });

  it("(#733) gap-backfill: writes a single pending_cleanup audit row summarizing the dropped pre-auths, and nothing when the sweep is a no-op", async () => {
    const { itemRowId, externalAcctId } = await seedAmexItem();

    // Two vanishing pre-auths inside the [2026-05-15, today] window
    // anchored by the still-pending charge below.
    await db.insert(transactionsTable).values([
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-15",
        description: "Metro pre-auth A",
        amount: "-12.34",
        source: "plaid:amex",
        plaidAccountId: externalAcctId,
        plaidTransactionId: "plaid-vanish-audit-a",
        pending: true,
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-17",
        description: "Metro pre-auth B",
        amount: "-29.84",
        source: "plaid:amex",
        plaidAccountId: externalAcctId,
        plaidTransactionId: "plaid-vanish-audit-b",
        pending: true,
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-18",
        description: "Still-pending charge",
        amount: "-8.00",
        source: "plaid:amex",
        plaidAccountId: externalAcctId,
        plaidTransactionId: "plaid-still-audit",
        pending: true,
      },
    ]);

    nextGetResponse = {
      transactions: [
        {
          transaction_id: "plaid-still-audit",
          account_id: externalAcctId,
          date: "2026-05-18",
          amount: 8.0,
          name: "Still-pending charge",
          pending: true,
        },
      ],
      total_transactions: 1,
    };

    await runGapBackfillForItem(TEST_USER, itemRowId, {
      today: new Date("2026-05-20T12:00:00Z"),
      // Wider overlap so the [startStr, today] window reaches back to
      // pick up both vanishing pre-auths (lastBankTxOn=2026-05-18).
      overlapDays: 5,
    });

    const attempts = await db
      .select()
      .from(plaidSyncAttemptsTable)
      .where(eq(plaidSyncAttemptsTable.userId, TEST_USER));
    const cleanupRows = attempts.filter((a) => a.kind === "pending_cleanup");
    expect(cleanupRows).toHaveLength(1);
    const row = cleanupRows[0]!;
    expect(row.success).toBe(true);
    // Summary should call out count + account + total + date range so a
    // user skimming Recent activity can see what was tidied at a glance.
    expect(row.errorMessage).toContain("Cleared 2 dropped pending charges");
    expect(row.errorMessage).toContain("Amex Gold");
    expect(row.errorMessage).toContain("$42.18");
    expect(row.errorMessage).toContain("2026-05-15");
    expect(row.errorMessage).toContain("2026-05-17");

    const details = row.cleanupDetails as {
      accountName: string | null;
      count: number;
      totalAmount: string;
      minOccurredOn: string;
      maxOccurredOn: string;
      items: Array<{
        description: string | null;
        amount: string;
        occurredOn: string;
        plaidTransactionId: string;
      }>;
    };
    expect(details.accountName).toBe("Amex Gold");
    expect(details.count).toBe(2);
    expect(details.totalAmount).toBe("-42.18");
    expect(details.minOccurredOn).toBe("2026-05-15");
    expect(details.maxOccurredOn).toBe("2026-05-17");
    const ptids = details.items.map((i) => i.plaidTransactionId).sort();
    expect(ptids).toEqual(["plaid-vanish-audit-a", "plaid-vanish-audit-b"]);
    // Per-deletion detail rows carry the fields the UI's "View details"
    // expander renders verbatim.
    const a = details.items.find(
      (i) => i.plaidTransactionId === "plaid-vanish-audit-a",
    )!;
    expect(a.description).toBe("Metro pre-auth A");
    expect(a.amount).toBe("-12.34");
    expect(a.occurredOn).toBe("2026-05-15");

    // No-op sweep: rerun with Plaid still reporting the still-pending
    // charge and no other pendings to delete. Must NOT write another
    // pending_cleanup row.
    await runGapBackfillForItem(TEST_USER, itemRowId, {
      today: new Date("2026-05-20T12:00:00Z"),
      overlapDays: 1,
    });
    const afterNoop = await db
      .select()
      .from(plaidSyncAttemptsTable)
      .where(eq(plaidSyncAttemptsTable.userId, TEST_USER));
    const cleanupAfter = afterNoop.filter((a) => a.kind === "pending_cleanup");
    expect(cleanupAfter).toHaveLength(1);
  });

  it("gap-backfill: a thrown /transactions/get error does NOT wipe local pendings", async () => {
    const { itemRowId, externalAcctId } = await seedAmexItem();

    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-10",
      description: "Anchor",
      amount: "-1.00",
      source: "plaid:amex",
      plaidAccountId: externalAcctId,
      plaidTransactionId: "plaid-anchor",
      pending: false,
    });
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-12",
      description: "Local pending",
      amount: "-99.00",
      source: "plaid:amex",
      plaidAccountId: externalAcctId,
      plaidTransactionId: "plaid-local-pending",
      pending: true,
    });

    // Force the /transactions/get mock to throw on this call by
    // installing a throwing getter on the response object the mock
    // returns. The gap-backfill loop wraps the per-account pull in a
    // try/catch (so transient Plaid errors are non-fatal) — the
    // vanished-pending sweep lives INSIDE that try, which means a
    // throw here must also bypass the sweep and leave local rows
    // untouched.
    nextGetResponse = { transactions: [], total_transactions: 0 };
    Object.defineProperty(nextGetResponse, "transactions", {
      get() {
        throw new Error("plaid transient");
      },
      configurable: true,
    });

    await runGapBackfillForItem(TEST_USER, itemRowId, {
      today: new Date("2026-05-20T12:00:00Z"),
    });

    const rows = await db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, TEST_USER),
          inArray(transactionsTable.plaidTransactionId, [
            "plaid-anchor",
            "plaid-local-pending",
          ]),
        ),
      );
    expect(rows).toHaveLength(2);
    const stillPending = rows.find(
      (r) => r.plaidTransactionId === "plaid-local-pending",
    );
    expect(stillPending?.pending).toBe(true);
  });
});
