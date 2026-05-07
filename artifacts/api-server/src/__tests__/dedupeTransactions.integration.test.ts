import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  forecastResolutionsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import {
  dedupeTransactionsForAccount,
  dedupeTransactionsForUser,
} from "../lib/dedupeTransactions";

const TEST_USER = `dedupe-txn-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

async function cleanup(): Promise<void> {
  await db
    .delete(forecastResolutionsTable)
    .where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(cleanup);
afterAll(cleanup);

async function seedAccount(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      itemId: `item-${suffix}`,
      accessToken: "test-no-access",
      institutionName: "Chase",
      institutionSlug: "chase",
    })
    .returning();
  const externalAcctId = `chase-acct-${suffix}`;
  await db.insert(plaidAccountsTable).values({
    userId: TEST_USER,
    itemId: item!.id,
    accountId: externalAcctId,
    name: "Chase Checking",
    mask: "5526",
    type: "depository",
    subtype: "checking",
  });
  return externalAcctId;
}

async function insertTxn(
  values: Partial<typeof transactionsTable.$inferInsert> & {
    plaidAccountId: string;
    occurredOn: string;
    amount: string;
    description: string;
  },
  createdAt?: Date,
): Promise<string> {
  const [row] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      source: "plaid:chase",
      ...values,
      ...(createdAt ? { createdAt } : {}),
    })
    .returning({ id: transactionsTable.id });
  return row!.id;
}

describe("dedupeTransactionsForAccount (#452)", () => {
  it("collapses two duplicate Chase rows: keeps the one with more user state, merges loser fields, deletes the loser", async () => {
    await cleanup();
    const acct = await seedAccount();
    // Loser: brand-new, no user state, but has a plaid_transaction_id
    // (so the survivor can adopt it).
    const loserId = await insertTxn(
      {
        plaidAccountId: acct,
        occurredOn: "2026-05-01",
        amount: "-12.34",
        description: "EXACT  SCIENCES",
        plaidTransactionId: `pt-loser-${randomUUID().slice(0, 8)}`,
      },
      new Date(Date.now() - 1000),
    );
    // Survivor: older, hand-categorized + reimbursable + has notes.
    const survivorId = await insertTxn(
      {
        plaidAccountId: acct,
        occurredOn: "2026-05-01",
        amount: "-12.34",
        description: "exact sciences",
        categoryId: randomUUID(),
        reimbursable: true,
        notes: "split with sister",
        forecastFlag: true,
      },
      new Date(Date.now() - 60_000),
    );

    const report = await dedupeTransactionsForAccount(TEST_USER, acct);
    expect(report.groupsScanned).toBe(1);
    expect(report.duplicatesRemoved).toBe(1);

    const remaining = await db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, TEST_USER),
          eq(transactionsTable.plaidAccountId, acct),
        ),
      );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(survivorId);
    // Loser's plaid_transaction_id was adopted onto the survivor so the
    // next /transactions/sync refreshes via onConflictDoUpdate.
    expect(remaining[0].plaidTransactionId).toBeTruthy();
    expect(remaining[0].forecastFlag).toBe(true);
    expect(remaining[0].reimbursable).toBe(true);
    expect(remaining[0].notes).toBe("split with sister");
    // Loser is gone.
    const [stale] = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.id, loserId));
    expect(stale).toBeUndefined();
  });

  it("repoints forecast_resolutions.matched_txn_id from the loser onto the survivor before deleting", async () => {
    await cleanup();
    const acct = await seedAccount();
    // Survivor wins on user state: forecastFlag + categoryId +
    // reimbursable + notes outweigh the loser's lone resolution match.
    const survivorId = await insertTxn(
      {
        plaidAccountId: acct,
        occurredOn: "2026-04-15",
        amount: "-100.00",
        description: "Rent",
        forecastFlag: true,
        categoryId: randomUUID(),
        reimbursable: true,
        notes: "rent split",
      },
      new Date(Date.now() - 60_000),
    );
    const loserId = await insertTxn(
      {
        plaidAccountId: acct,
        occurredOn: "2026-04-15",
        amount: "-100.00",
        description: "RENT",
      },
      new Date(Date.now() - 1000),
    );
    // Place the resolution on the loser — must be repointed onto the
    // survivor before the loser is deleted.
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      status: "matched",
      matchedTxnId: loserId,
    });

    const report = await dedupeTransactionsForAccount(TEST_USER, acct);
    expect(report.duplicatesRemoved).toBe(1);
    expect(report.resolutionsRepointed).toBe(1);

    const resolutions = await db
      .select()
      .from(forecastResolutionsTable)
      .where(eq(forecastResolutionsTable.userId, TEST_USER));
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].matchedTxnId).toBe(survivorId);
    const [gone] = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.id, loserId));
    expect(gone).toBeUndefined();
  });

  it("normalizes description whitespace and case so 'CHASE  PAYMENT' and 'chase payment' collapse", async () => {
    await cleanup();
    const acct = await seedAccount();
    await insertTxn(
      {
        plaidAccountId: acct,
        occurredOn: "2026-03-20",
        amount: "250.00",
        description: "CHASE  PAYMENT",
      },
      new Date(Date.now() - 60_000),
    );
    await insertTxn(
      {
        plaidAccountId: acct,
        occurredOn: "2026-03-20",
        amount: "250.00",
        description: "chase payment",
      },
      new Date(Date.now() - 1000),
    );
    const report = await dedupeTransactionsForAccount(TEST_USER, acct);
    expect(report.duplicatesRemoved).toBe(1);
    const remaining = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(remaining).toHaveLength(1);
  });

  it("does not collapse rows with a different signed amount (deposit vs. spend)", async () => {
    await cleanup();
    const acct = await seedAccount();
    await insertTxn({
      plaidAccountId: acct,
      occurredOn: "2026-03-21",
      amount: "-50.00",
      description: "Refund-eligible vendor",
    });
    await insertTxn({
      plaidAccountId: acct,
      occurredOn: "2026-03-21",
      amount: "50.00",
      description: "Refund-eligible vendor",
    });
    const report = await dedupeTransactionsForAccount(TEST_USER, acct);
    expect(report.duplicatesRemoved).toBe(0);
    const remaining = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(remaining).toHaveLength(2);
  });

  it("is idempotent: a second run on a clean account reports zero changes", async () => {
    await cleanup();
    const acct = await seedAccount();
    await insertTxn({
      plaidAccountId: acct,
      occurredOn: "2026-03-22",
      amount: "-1.00",
      description: "Solo row",
    });
    const r1 = await dedupeTransactionsForAccount(TEST_USER, acct);
    expect(r1.duplicatesRemoved).toBe(0);
    const r2 = await dedupeTransactionsForAccount(TEST_USER, acct);
    expect(r2).toEqual(r1);
  });

  it("dedupeTransactionsForUser scans every plaid account belonging to the user", async () => {
    await cleanup();
    const acctA = await seedAccount();
    const acctB = await seedAccount();
    for (const a of [acctA, acctB]) {
      await insertTxn(
        {
          plaidAccountId: a,
          occurredOn: "2026-02-01",
          amount: "-9.99",
          description: "Twin",
        },
        new Date(Date.now() - 60_000),
      );
      await insertTxn(
        {
          plaidAccountId: a,
          occurredOn: "2026-02-01",
          amount: "-9.99",
          description: "twin",
        },
        new Date(Date.now() - 1000),
      );
    }
    const report = await dedupeTransactionsForUser(TEST_USER);
    expect(report.accountsScanned).toBeGreaterThanOrEqual(2);
    expect(report.duplicatesRemoved).toBe(2);
    const remaining = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(remaining).toHaveLength(2);
  });
});
