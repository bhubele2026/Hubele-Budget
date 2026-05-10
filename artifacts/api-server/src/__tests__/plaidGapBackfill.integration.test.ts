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

import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `gapbf-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

// (#408) Mocked /transactions/get response that the backfill helper
// pages through. Each test seeds this before invoking the backfill so
// we can assert on the start/end window the helper computes per
// account, the ±7-day merge with manual rows, and the duplicate-free
// idempotency guarantee.
type MockTxn = {
  transaction_id: string;
  account_id: string;
  date: string;
  amount: number;
  name: string;
  pending?: boolean;
};
let nextGetResponse: { transactions: MockTxn[]; total_transactions: number } = {
  transactions: [],
  total_transactions: 0,
};
let lastGetCall: {
  start_date: string;
  end_date: string;
  account_ids: string[];
} | null = null;

vi.mock("../lib/plaid", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({
      transactionsGet: async (req: {
        access_token: string;
        start_date: string;
        end_date: string;
        options?: { account_ids?: string[]; count?: number; offset?: number };
      }) => {
        lastGetCall = {
          start_date: req.start_date,
          end_date: req.end_date,
          account_ids: req.options?.account_ids ?? [],
        };
        return { data: nextGetResponse };
      },
    }),
  };
});

import {
  db,
  debtsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { runGapBackfillForItem } from "../lib/plaidSync";

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
  nextGetResponse = { transactions: [], total_transactions: 0 };
  lastGetCall = null;
});

describe("(#408) runGapBackfillForItem", () => {
  it("calls /transactions/get with start = day after lastBankTxOn and end = today, per account", async () => {
    const externalItemId = `item-${randomUUID()}`;
    const externalAcctId = `acct-${randomUUID()}`;
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: externalItemId,
        accessToken: "access-sandbox-fresh-token-after-relink",
        institutionId: "ins_56",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalAcctId,
      name: "Chase Sapphire",
      type: "credit",
      subtype: "credit card",
      mask: "1234",
    });
    // The newest Plaid-sourced row already on file for this account.
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-04-20",
      description: "older row",
      amount: "-15.50",
      source: "plaid:chase",
      plaidAccountId: externalAcctId,
      plaidTransactionId: `pre-${randomUUID()}`,
    });

    nextGetResponse = {
      transactions: [
        {
          transaction_id: "plaid-may-3",
          account_id: externalAcctId,
          date: "2026-05-03",
          amount: 12.34,
          name: "Latte",
        },
      ],
      total_transactions: 1,
    };

    const result = await runGapBackfillForItem(TEST_USER, item!.id, {
      today: new Date("2026-05-07T12:00:00Z"),
    });

    expect(lastGetCall).not.toBeNull();
    // Day AFTER 2026-04-20 → 2026-04-21, end_date is today.
    expect(lastGetCall!.start_date).toBe("2026-04-21");
    expect(lastGetCall!.end_date).toBe("2026-05-07");
    expect(lastGetCall!.account_ids).toEqual([externalAcctId]);
    expect(result.added).toBe(1);
    expect(result.importedDateRange).toEqual({
      min: "2026-05-03",
      max: "2026-05-03",
    });

    // The new May row landed via the backfill insert path with the
    // correct sign convention (Plaid positive amount → our negative).
    const inserted = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.plaidTransactionId, "plaid-may-3"));
    expect(inserted).toHaveLength(1);
    expect(inserted[0].amount).toBe("-12.34");
    expect(inserted[0].source).toBe("plaid:chase");
  });

  it("is idempotent: running backfill twice does not duplicate rows", async () => {
    const externalItemId = `item-${randomUUID()}`;
    const externalAcctId = `acct-${randomUUID()}`;
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: externalItemId,
        accessToken: "access-sandbox-fresh-token-idem",
        institutionId: "ins_56",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalAcctId,
      name: "Chase Sapphire",
      type: "credit",
      subtype: "credit card",
      mask: "1234",
      importCutoffDate: "2026-04-30",
    });

    nextGetResponse = {
      transactions: [
        {
          transaction_id: "plaid-may-2-idem",
          account_id: externalAcctId,
          date: "2026-05-02",
          amount: 5.0,
          name: "Coffee",
        },
      ],
      total_transactions: 1,
    };

    const r1 = await runGapBackfillForItem(TEST_USER, item!.id, {
      today: new Date("2026-05-07T12:00:00Z"),
    });
    expect(r1.added).toBe(1);

    // Second run with the same Plaid response — onConflictDoUpdate on
    // plaid_transaction_id makes this a no-op insert: zero new rows,
    // single row in the DB.
    const r2 = await runGapBackfillForItem(TEST_USER, item!.id, {
      today: new Date("2026-05-07T12:00:00Z"),
    });
    expect(r2.added).toBe(0);

    const all = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(all).toHaveLength(1);
    expect(all[0].plaidTransactionId).toBe("plaid-may-2-idem");
  });

  it("merges with an unattached manual row within ±7 days instead of duplicating", async () => {
    const externalItemId = `item-${randomUUID()}`;
    const externalAcctId = `acct-${randomUUID()}`;
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: externalItemId,
        accessToken: "access-sandbox-fresh-token-merge",
        institutionId: "ins_56",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    const [acct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: item!.id,
        accountId: externalAcctId,
        name: "Chase Sapphire",
        type: "credit",
        subtype: "credit card",
        mask: "1234",
        importCutoffDate: "2026-04-30",
      })
      .returning();
    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Chase Sapphire",
        balance: "1500",
        plaidAccountId: acct!.id,
      })
      .returning();
    // A manual row the user added during the outage — same date and
    // amount as the row Plaid is about to surface. Backfill must adopt
    // this row (attach plaid_transaction_id) instead of inserting a
    // duplicate.
    const [manual] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-02",
        description: "manual outage entry",
        amount: "-42.00",
        source: "manual",
        debtId: debt!.id,
      })
      .returning();

    nextGetResponse = {
      transactions: [
        {
          transaction_id: "plaid-may-2-merge",
          account_id: externalAcctId,
          date: "2026-05-02",
          amount: 42.0,
          name: "Plaid surfaced version",
        },
      ],
      total_transactions: 1,
    };

    const result = await runGapBackfillForItem(TEST_USER, item!.id, {
      today: new Date("2026-05-07T12:00:00Z"),
    });
    // Merged in-place — NOT counted as a new add.
    expect(result.added).toBe(0);

    const all = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(manual!.id);
    expect(all[0].plaidTransactionId).toBe("plaid-may-2-merge");
    expect(all[0].source).toBe("manual");
    expect(all[0].description).toBe("manual outage entry");
  });

  it("skips accounts that have no anchor (no prior bank txn AND no importCutoffDate)", async () => {
    const externalItemId = `item-${randomUUID()}`;
    const externalAcctId = `acct-${randomUUID()}`;
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: externalItemId,
        accessToken: "access-sandbox-fresh-token-noanchor",
        institutionId: "ins_56",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalAcctId,
      name: "Chase Sapphire",
      type: "credit",
      subtype: "credit card",
      mask: "1234",
      // No importCutoffDate, no prior bank txn → no anchor.
    });

    const result = await runGapBackfillForItem(TEST_USER, item!.id, {
      today: new Date("2026-05-07T12:00:00Z"),
    });
    expect(result.added).toBe(0);
    expect(result.perAccount[0].added).toBe(0);
    // /transactions/get must NOT have been called on a no-anchor account.
    expect(lastGetCall).toBeNull();
  });

  it("merges with an unattached manual checking row when the account is the bank-snapshot account (mirrors first-sync scope)", async () => {
    const externalItemId = `item-${randomUUID()}`;
    const externalAcctId = `acct-${randomUUID()}`;
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: externalItemId,
        accessToken: "access-sandbox-fresh-token-checking",
        institutionId: "ins_56",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    const [acct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: item!.id,
        accountId: externalAcctId,
        name: "Chase Checking",
        type: "depository",
        subtype: "checking",
        mask: "5555",
        importCutoffDate: "2026-04-30",
      })
      .returning();
    // The user picked this checking account as the bank snapshot —
    // backfill must adopt unattached manual|bank rows with no debt
    // link instead of inserting a duplicate Plaid row.
    await db.insert(forecastSettingsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      bankSnapshotAccountId: acct!.id,
    });
    const [manual] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-03",
        description: "manual checking outage entry",
        amount: "-77.00",
        source: "manual",
      })
      .returning();

    nextGetResponse = {
      transactions: [
        {
          transaction_id: "plaid-may-3-checking",
          account_id: externalAcctId,
          date: "2026-05-03",
          amount: 77.0,
          name: "Plaid checking version",
        },
      ],
      total_transactions: 1,
    };

    const result = await runGapBackfillForItem(TEST_USER, item!.id, {
      today: new Date("2026-05-07T12:00:00Z"),
    });
    expect(result.added).toBe(0);

    const all = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(manual!.id);
    expect(all[0].plaidTransactionId).toBe("plaid-may-3-checking");
    expect(all[0].plaidAccountId).toBe(externalAcctId);
    expect(all[0].source).toBe("manual");
  });

  it("returns zero (and never calls Plaid) when the stored access_token is malformed", async () => {
    const externalItemId = `item-${randomUUID()}`;
    const externalAcctId = `acct-${randomUUID()}`;
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: externalItemId,
        accessToken: "",
        institutionId: "ins_56",
        institutionName: "Chase",
        institutionSlug: "chase",
      })
      .returning();
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalAcctId,
      name: "Chase Sapphire",
      type: "credit",
      subtype: "credit card",
      mask: "1234",
      importCutoffDate: "2026-04-30",
    });

    const result = await runGapBackfillForItem(TEST_USER, item!.id, {
      today: new Date("2026-05-07T12:00:00Z"),
    });
    expect(result.added).toBe(0);
    expect(lastGetCall).toBeNull();
  });
});
