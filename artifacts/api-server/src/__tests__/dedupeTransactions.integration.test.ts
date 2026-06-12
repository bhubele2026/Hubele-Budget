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
  dedupeTransactionsAcrossAccountsForUser,
  dedupeTransactionsForAccount,
  dedupeTransactionsForUser,
} from "../lib/dedupeTransactions";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `dedupe-txn-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

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

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
  await cleanup();
});
afterAll(cleanup);

async function seedAccount(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${suffix}`,
      accessToken: "test-no-access",
      institutionName: "Chase",
      institutionSlug: "chase",
    })
    .returning();
  const externalAcctId = `chase-acct-${suffix}`;
  await db.insert(plaidAccountsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
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
    plaidAccountId: string | null;
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
      householdId: TEST_HOUSEHOLD_ID,
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
      householdId: TEST_HOUSEHOLD_ID,
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

  // (#800) Affirm-pattern positive: two rows on the same account/date/
  // amount where one description is a token-subset of the other. The
  // old exact-key dedupe missed these because "Affirm" and "AFFIRM.COM
  // PAYME ... Merchant: Affirm" have different normalized descriptions.
  it("collapses fuzzy-description duplicates: 'Affirm' + 'AFFIRM.COM PAYME ... Merchant: Affirm' same account/date/amount → one row, keeps real plaid id", async () => {
    await cleanup();
    const acct = await seedAccount();
    // Older row: the real Plaid posting with the short merchant name.
    const survivorId = await insertTxn(
      {
        plaidAccountId: acct,
        occurredOn: "2026-05-10",
        amount: "-66.93",
        description: "Affirm",
        plaidTransactionId: `pt-affirm-${randomUUID().slice(0, 8)}`,
      },
      new Date(Date.now() - 60_000),
    );
    // Newer row: the long bank-statement variant of the same posting.
    const loserId = await insertTxn(
      {
        plaidAccountId: acct,
        occurredOn: "2026-05-10",
        amount: "-66.93",
        description: "AFFIRM.COM PAYME AFFIRM.COM ST-J6L0K3Z3X2C4 WEB ID: 1800948598 Merchant: Affirm",
      },
      new Date(Date.now() - 1000),
    );
    const report = await dedupeTransactionsForAccount(TEST_USER, acct);
    expect(report.groupsScanned).toBe(1);
    expect(report.duplicatesRemoved).toBe(1);
    const remaining = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(survivorId);
    expect(remaining[0].plaidTransactionId).toBeTruthy();
    const [gone] = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.id, loserId));
    expect(gone).toBeUndefined();
  });

  // (#800) Best Buy positive: two real-Plaid rows with identical
  // descriptions, same account/date/amount, both already categorized.
  // Survivor wins on tie via oldest createdAt and inherits the
  // loser's plaid_transaction_id (so future syncs upsert in place).
  it("collapses two real-Plaid Best Buy rows on the same account/date/amount; survivor = older createdAt, keeps category", async () => {
    await cleanup();
    const acct = await seedAccount();
    const category = randomUUID();
    const survivorId = await insertTxn(
      {
        plaidAccountId: acct,
        occurredOn: "2026-05-10",
        amount: "-179.34",
        description: "Best Buy",
        plaidTransactionId: `pt-bb-survivor-${randomUUID().slice(0, 8)}`,
        source: "plaid:amex",
        categoryId: category,
      },
      new Date(Date.now() - 60_000),
    );
    const loserId = await insertTxn(
      {
        plaidAccountId: acct,
        occurredOn: "2026-05-10",
        amount: "-179.34",
        description: "Best Buy",
        plaidTransactionId: `pt-bb-loser-${randomUUID().slice(0, 8)}`,
        source: "plaid:amex",
        categoryId: category,
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
    expect(remaining[0].id).toBe(survivorId);
    expect(remaining[0].categoryId).toBe(category);
    const [gone] = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.id, loserId));
    expect(gone).toBeUndefined();
  });

  // (#800) Negative: same account/date/amount but genuinely different
  // merchants. Neither description is a token-subset of the other, so
  // the fuzzy clustering must keep them as two singletons.
  it("does NOT collapse same-account/date/amount rows when descriptions are unrelated merchants ('REPLIT, INC.' vs 'LOVABLE DOVER DE')", async () => {
    await cleanup();
    const acct = await seedAccount();
    await insertTxn({
      plaidAccountId: acct,
      occurredOn: "2026-05-01",
      amount: "-100.00",
      description: "REPLIT, INC. FOSTER CITY CA",
      plaidTransactionId: `pt-replit-${randomUUID().slice(0, 8)}`,
    });
    await insertTxn({
      plaidAccountId: acct,
      occurredOn: "2026-05-01",
      amount: "-100.00",
      description: "LOVABLE DOVER DE",
      plaidTransactionId: `pt-lovable-${randomUUID().slice(0, 8)}`,
    });
    const report = await dedupeTransactionsForAccount(TEST_USER, acct);
    expect(report.duplicatesRemoved).toBe(0);
    const remaining = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(remaining).toHaveLength(2);
  });

  // (#800) Negative: a Target charge and a Walmart charge that happen
  // to share date+amount must never be merged — same per-account
  // scope, no token overlap.
  it("does NOT collapse different merchants Target vs Walmart on the same account/date/amount", async () => {
    await cleanup();
    const acct = await seedAccount();
    await insertTxn({
      plaidAccountId: acct,
      occurredOn: "2026-05-12",
      amount: "-47.21",
      description: "TARGET STORE #1234",
      plaidTransactionId: `pt-tgt-${randomUUID().slice(0, 8)}`,
    });
    await insertTxn({
      plaidAccountId: acct,
      occurredOn: "2026-05-12",
      amount: "-47.21",
      description: "WALMART SUPERCENTER",
      plaidTransactionId: `pt-wmt-${randomUUID().slice(0, 8)}`,
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

  it("dedupeTransactionsForUser fast pre-check: clean data short-circuits with zero accountsScanned", async () => {
    await cleanup();
    const acct = await seedAccount();
    await insertTxn({
      plaidAccountId: acct,
      occurredOn: "2026-04-10",
      amount: "-2.00",
      description: "Lone row",
    });
    const r = await dedupeTransactionsForUser(TEST_USER);
    expect(r.duplicatesRemoved).toBe(0);
    // Pre-check returned 0 dup groups so the per-account loop never ran.
    expect(r.accountsScanned).toBe(0);
  });

  it("dedupeTransactionsForUser pre-check still detects duplicates that differ only by leading/trailing whitespace", async () => {
    // Probe SQL must match the JS normalizeDescription (lower + collapse
    // whitespace + trim). If it doesn't, edge-whitespace duplicates
    // would falsely short-circuit.
    await cleanup();
    const acct = await seedAccount();
    await insertTxn(
      {
        plaidAccountId: acct,
        occurredOn: "2026-04-15",
        amount: "-3.50",
        description: "Coffee",
      },
      new Date(Date.now() - 60_000),
    );
    await insertTxn(
      {
        plaidAccountId: acct,
        occurredOn: "2026-04-15",
        amount: "-3.50",
        description: "  Coffee  ",
      },
      new Date(Date.now() - 1000),
    );
    const r = await dedupeTransactionsForUser(TEST_USER);
    expect(r.duplicatesRemoved).toBe(1);
    expect(r.accountsScanned).toBeGreaterThanOrEqual(1);
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

describe("dedupeTransactionsAcrossAccountsForUser (#475-followup)", () => {
  it("collapses duplicates across multiple plaid_account_id strings for the same bank family, preferring the live account", async () => {
    await cleanup();
    // Live (currently linked) Chase account.
    const liveAcct = await seedAccount();
    // Two orphan account strings (plaid_account_id present on rows but
    // no surviving plaid_accounts row) — simulates the post-re-link
    // duplicate-account_id explosion.
    const orphanA = `chase-orphan-a-${randomUUID().slice(0, 8)}`;
    const orphanB = `chase-orphan-b-${randomUUID().slice(0, 8)}`;

    // 3 twins of the same Toyota charge across 3 different account_ids
    // and 3 different plaid_transaction_ids.
    for (const [acct, pid] of [
      [orphanA, "ptx-a"],
      [orphanB, "ptx-b"],
      [liveAcct, "ptx-c"],
    ] as const) {
      await insertTxn({
        plaidAccountId: acct,
        plaidTransactionId: pid,
        occurredOn: "2026-05-04",
        amount: "-672.80",
        description: "TOYOTA",
        source: "plaid:chase",
      });
    }
    // An Amex row that happens to share date+amount+desc must NOT be
    // collapsed with the Chase rows.
    await insertTxn({
      plaidAccountId: "amex-acct",
      occurredOn: "2026-05-04",
      amount: "-672.80",
      description: "TOYOTA",
      source: "plaid:amex",
    });

    const report = await dedupeTransactionsAcrossAccountsForUser(TEST_USER);
    expect(report.duplicatesRemoved).toBe(2);
    expect(report.groupsScanned).toBe(1);

    const remaining = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    // 1 chase survivor + 1 amex (untouched) = 2 rows.
    expect(remaining).toHaveLength(2);
    const chase = remaining.find((r) => r.source === "plaid:chase");
    expect(chase).toBeTruthy();
    // Survivor was repointed onto the live account so it renders under
    // the user's currently-linked Chase row.
    expect(chase!.plaidAccountId).toBe(liveAcct);

    // Idempotency: a second pass is a no-op.
    const second = await dedupeTransactionsAcrossAccountsForUser(TEST_USER);
    expect(second.duplicatesRemoved).toBe(0);
    expect(second.groupsScanned).toBe(0);
  });

  it("does NOT collapse legitimate same-day same-amount same-desc rows across two live linked accounts at the same bank", async () => {
    await cleanup();
    // Two REAL linked Chase accounts (e.g. checking + savings or two
    // cards). Both account_ids resolve to live plaid_accounts rows.
    const liveA = await seedAccount();
    const liveB = await seedAccount();
    await insertTxn({
      plaidAccountId: liveA,
      plaidTransactionId: "ptx-a",
      occurredOn: "2026-05-04",
      amount: "-5.00",
      description: "STARBUCKS",
      source: "plaid:chase",
    });
    await insertTxn({
      plaidAccountId: liveB,
      plaidTransactionId: "ptx-b",
      occurredOn: "2026-05-04",
      amount: "-5.00",
      description: "STARBUCKS",
      source: "plaid:chase",
    });

    const report = await dedupeTransactionsAcrossAccountsForUser(TEST_USER);
    expect(report.duplicatesRemoved).toBe(0);
    const remaining = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(remaining).toHaveLength(2);
  });

  it("collapses an orphan+live twin even created same-day / near-simultaneously (it's relink residue — a real double charge would be on the SAME live card)", async () => {
    await cleanup();
    const live = await seedAccount();
    const orphan = `chase-orphan-${randomUUID().slice(0, 8)}`;
    const t = Date.now();
    await insertTxn(
      {
        plaidAccountId: orphan,
        plaidTransactionId: "ptx-orphan",
        occurredOn: "2026-05-04",
        amount: "-5.00",
        description: "STARBUCKS",
        source: "plaid:chase",
      },
      new Date(t),
    );
    await insertTxn(
      {
        plaidAccountId: live,
        plaidTransactionId: "ptx-live",
        occurredOn: "2026-05-04",
        amount: "-5.00",
        description: "STARBUCKS",
        source: "plaid:chase",
      },
      new Date(t + 60 * 1000), // 1 minute apart — old heuristic preserved
      // this; the orphan-vs-live signal correctly treats it as residue.
    );
    const report = await dedupeTransactionsAcrossAccountsForUser(TEST_USER);
    expect(report.duplicatesRemoved).toBe(1);
    const remaining = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(remaining).toHaveLength(1);
    // Survivor is the live-linked copy.
    expect(remaining[0]!.plaidAccountId).toBe(live);
  });

  it("collapses a NULL-account twin of a live card charge (the '—' no-card duplicate)", async () => {
    await cleanup();
    const live = await seedAccount();
    const t = Date.now();
    await insertTxn(
      {
        plaidAccountId: null,
        plaidTransactionId: "ptx-nullacct",
        occurredOn: "2026-06-12",
        amount: "-17.03",
        description: "SUBWAY",
        source: "plaid:amex",
      },
      new Date(t),
    );
    await insertTxn(
      {
        plaidAccountId: live,
        plaidTransactionId: "ptx-live-sub",
        occurredOn: "2026-06-12",
        amount: "-17.03",
        description: "SUBWAY",
        source: "plaid:amex",
      },
      new Date(t + 60 * 1000),
    );
    const report = await dedupeTransactionsAcrossAccountsForUser(TEST_USER);
    expect(report.duplicatesRemoved).toBe(1);
    const remaining = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.plaidAccountId).toBe(live);
  });

  it("does NOT touch manual transactions even when they share a key", async () => {
    await cleanup();
    await seedAccount();
    await insertTxn({
      plaidAccountId: "manual-no-link",
      occurredOn: "2026-05-04",
      amount: "-12.34",
      description: "COFFEE",
      source: "manual",
    });
    await insertTxn({
      plaidAccountId: "manual-no-link",
      occurredOn: "2026-05-04",
      amount: "-12.34",
      description: "COFFEE",
      source: "manual",
    });
    const report = await dedupeTransactionsAcrossAccountsForUser(TEST_USER);
    expect(report.duplicatesRemoved).toBe(0);
    const remaining = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(remaining).toHaveLength(2);
  });
});
