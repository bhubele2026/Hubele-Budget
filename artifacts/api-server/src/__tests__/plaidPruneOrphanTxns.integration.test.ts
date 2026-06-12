import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import {
  db,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { pruneOrphanPlaidTransactionsForHousehold } from "../lib/plaidSync";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `prune-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const OTHER_USER = `prune-other-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let HH: string;
let OTHER_HH: string;

async function cleanup(): Promise<void> {
  for (const u of [TEST_USER, OTHER_USER]) {
    await db.delete(transactionsTable).where(eq(transactionsTable.userId, u));
    await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, u));
    await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, u));
  }
}

beforeAll(async () => {
  HH = (await createTestHousehold(TEST_USER)).householdId;
  OTHER_HH = (await createTestHousehold(OTHER_USER)).householdId;
});
beforeEach(cleanup);
afterAll(cleanup);

async function insertItemWithAccount(opts: {
  user: string;
  household: string;
}): Promise<{ itemRowId: string; accountId: string }> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: opts.user,
      householdId: opts.household,
      itemId: `item-${randomUUID().slice(0, 8)}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionId: "ins_56",
      institutionSlug: "chase",
      institutionName: "Chase",
    })
    .returning();
  const accountId = `acct-${randomUUID().slice(0, 8)}`;
  await db.insert(plaidAccountsTable).values({
    userId: opts.user,
    householdId: opts.household,
    itemId: item!.id,
    accountId,
    name: "Total Checking",
    mask: "5526",
    type: "depository",
    subtype: "checking",
  });
  return { itemRowId: item!.id, accountId };
}

async function insertPlaidTxn(opts: {
  user: string;
  household: string;
  plaidAccountId: string;
  plaidTransactionId: string;
  occurredOn?: string;
}): Promise<string> {
  const [row] = await db
    .insert(transactionsTable)
    .values({
      userId: opts.user,
      householdId: opts.household,
      occurredOn: opts.occurredOn ?? "2026-05-01",
      description: "Test charge",
      amount: "-12.34",
      source: "plaid:chase",
      plaidTransactionId: opts.plaidTransactionId,
      plaidAccountId: opts.plaidAccountId,
    })
    .returning({ id: transactionsTable.id });
  return row!.id;
}

async function insertManualTxn(opts: {
  user: string;
  household: string;
}): Promise<string> {
  const [row] = await db
    .insert(transactionsTable)
    .values({
      userId: opts.user,
      householdId: opts.household,
      occurredOn: "2026-05-02",
      description: "Manual entry",
      amount: "-9.99",
      source: "manual",
    })
    .returning({ id: transactionsTable.id });
  return row!.id;
}

describe("pruneOrphanPlaidTransactionsForHousehold", () => {
  it("deletes plaid txns whose plaid_account_id no longer exists, leaves live and manual rows alone, and never crosses household lines", async () => {
    // Live (current) account in our household — txn should survive.
    const live = await insertItemWithAccount({
      user: TEST_USER,
      household: HH,
    });
    const liveTxnId = await insertPlaidTxn({
      user: TEST_USER,
      household: HH,
      plaidAccountId: live.accountId,
      plaidTransactionId: `live-${randomUUID().slice(0, 8)}`,
    });

    // Orphan plaid txn in our household: account row never existed.
    const orphanAcctId = `acct-deleted-${randomUUID().slice(0, 8)}`;
    const orphanTxnId = await insertPlaidTxn({
      user: TEST_USER,
      household: HH,
      plaidAccountId: orphanAcctId,
      plaidTransactionId: `orph-${randomUUID().slice(0, 8)}`,
    });

    // Manual txn in our household — must survive.
    const manualTxnId = await insertManualTxn({
      user: TEST_USER,
      household: HH,
    });

    // Orphan plaid txn in a DIFFERENT household — must survive (scope guard).
    const otherOrphanAcctId = `acct-other-${randomUUID().slice(0, 8)}`;
    const otherTxnId = await insertPlaidTxn({
      user: OTHER_USER,
      household: OTHER_HH,
      plaidAccountId: otherOrphanAcctId,
      plaidTransactionId: `other-${randomUUID().slice(0, 8)}`,
    });

    const pruned = await pruneOrphanPlaidTransactionsForHousehold(HH);
    expect(pruned).toBe(1);

    async function exists(id: string): Promise<boolean> {
      const [r] = await db
        .select({ id: transactionsTable.id })
        .from(transactionsTable)
        .where(eq(transactionsTable.id, id))
        .limit(1);
      return !!r;
    }
    expect(await exists(liveTxnId)).toBe(true);
    expect(await exists(orphanTxnId)).toBe(false);
    expect(await exists(manualTxnId)).toBe(true);
    expect(await exists(otherTxnId)).toBe(true);

    // Idempotent: a second call is a no-op.
    expect(await pruneOrphanPlaidTransactionsForHousehold(HH)).toBe(0);
  });

  it("never prunes a touched (categorized / allowance-flagged) orphan — protects user work across resync & reconnect", async () => {
    // Pristine orphan (account row gone, no user data) → should be pruned.
    const pristine = await insertPlaidTxn({
      user: TEST_USER,
      household: HH,
      plaidAccountId: `acct-gone-${randomUUID().slice(0, 8)}`,
      plaidTransactionId: `prist-${randomUUID().slice(0, 8)}`,
    });

    // Same "account deleted" condition, but the user flagged it Unplanned —
    // this is the Amex ··1009 reconnect case. It must SURVIVE the prune.
    const [flagged] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: HH,
        occurredOn: "2026-06-11",
        description: "Short Story",
        amount: "-371.68",
        source: "plaid:amex",
        plaidTransactionId: `flag-${randomUUID().slice(0, 8)}`,
        plaidAccountId: `acct-gone-${randomUUID().slice(0, 8)}`,
        unplannedAllowance: true,
      })
      .returning({ id: transactionsTable.id });

    const pruned = await pruneOrphanPlaidTransactionsForHousehold(HH);
    expect(pruned).toBe(1); // only the pristine orphan, never the flagged one

    const stillThere = async (id: string): Promise<boolean> => {
      const [r] = await db
        .select({ id: transactionsTable.id })
        .from(transactionsTable)
        .where(eq(transactionsTable.id, id))
        .limit(1);
      return !!r;
    };
    expect(await stillThere(pristine)).toBe(false);
    expect(await stillThere(flagged!.id)).toBe(true);
  });

  it("is a no-op when the household has no plaid txns at all", async () => {
    await insertManualTxn({ user: TEST_USER, household: HH });
    expect(await pruneOrphanPlaidTransactionsForHousehold(HH)).toBe(0);
    const [n] = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, HH),
          eq(transactionsTable.userId, TEST_USER),
        ),
      );
    expect(n).toBeTruthy();
  });
});
