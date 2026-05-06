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
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `amex-resync-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = TEST_USER;
    next();
  },
}));

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
          next_cursor: "cursor-next",
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
  debtsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import plaidRouter from "../routes/plaid";
import { syncPlaidItem } from "../lib/plaidSync";
import { autoDetectCutoffsForItem } from "../lib/plaidImportCutoff";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  next();
});
app.use(plaidRouter);

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
}

beforeAll(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await cleanup();
  nextSyncResponse = { added: [], modified: [], removed: [] };
});

async function seedAmexItem(): Promise<{
  itemRowId: string;
  acctRowId: string;
  externalAcctId: string;
  debtId: string;
}> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      itemId: `item-${randomUUID()}`,
      accessToken: `access-sandbox-${randomUUID()}`,
      institutionName: "American Express",
      institutionSlug: "amex",
    })
    .returning();
  const externalAcctId = `acct-${randomUUID()}`;
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      itemId: item!.id,
      accountId: externalAcctId,
      name: "Amex Gold",
      type: "credit",
      subtype: "credit card",
    })
    .returning();
  const [debt] = await db
    .insert(debtsTable)
    .values({
      userId: TEST_USER,
      name: "Amex Gold",
      balance: "1000",
      plaidAccountId: acct!.id,
    })
    .returning();
  return {
    itemRowId: item!.id,
    acctRowId: acct!.id,
    externalAcctId,
    debtId: debt!.id,
  };
}

describe("(#373) Amex re-sync of an already-reconciled card adds zero duplicates", () => {
  it("a manual row + a near-cutoff Plaid added row collapse into one merged row, and a second sync of the same payload is a no-op", async () => {
    const { itemRowId, acctRowId, externalAcctId, debtId } =
      await seedAmexItem();

    // Manual row the user typed in before linking — exact charge that
    // Plaid will report once the link succeeds.
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      occurredOn: "2026-04-28",
      description: "Coffee shop — manual",
      amount: "-42.00",
      source: "manual",
      debtId,
    });

    await autoDetectCutoffsForItem(TEST_USER, itemRowId, "amex");

    // First sync: Plaid reports the same charge inside the ±7-day merge
    // window so the merge path adopts the manual row instead of creating
    // a duplicate.
    nextSyncResponse = {
      added: [
        {
          transaction_id: "plaid-amex-coffee",
          account_id: externalAcctId,
          date: "2026-04-28",
          amount: 42.0,
          name: "Coffee shop",
        },
        {
          transaction_id: "plaid-amex-new-1",
          account_id: externalAcctId,
          date: "2026-05-02",
          amount: 7.5,
          name: "Bakery — after cutoff",
        },
      ],
      modified: [],
      removed: [],
    };
    await syncPlaidItem(TEST_USER, itemRowId);

    const afterFirst = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    // Exactly two rows: the merged coffee charge + the post-cutoff bakery row.
    expect(afterFirst).toHaveLength(2);
    const merged = afterFirst.find(
      (t) => t.plaidTransactionId === "plaid-amex-coffee",
    );
    expect(merged).toBeDefined();
    // Merge adopts the manual row in place — keeps the manual description /
    // negative-amount sign, just stamps the Plaid id onto it.
    expect(merged!.source).toBe("manual");
    expect(merged!.amount).toBe("-42.00");

    const [acctAfterFirst] = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.id, acctRowId));
    expect(acctAfterFirst.firstSyncCompletedAt).not.toBeNull();

    // Second sync of the SAME payload (Plaid hasn't changed) must add
    // zero new rows — every added row is already known via plaidTxnId.
    nextSyncResponse = {
      added: [
        {
          transaction_id: "plaid-amex-coffee",
          account_id: externalAcctId,
          date: "2026-04-28",
          amount: 42.0,
          name: "Coffee shop",
        },
        {
          transaction_id: "plaid-amex-new-1",
          account_id: externalAcctId,
          date: "2026-05-02",
          amount: 7.5,
          name: "Bakery — after cutoff",
        },
      ],
      modified: [],
      removed: [],
    };
    await syncPlaidItem(TEST_USER, itemRowId);

    const afterSecond = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(afterSecond).toHaveLength(2);

    // Hard duplicate guard: no two rows share the same plaidTransactionId.
    const ids = afterSecond
      .map((t) => t.plaidTransactionId)
      .filter((x): x is string => x !== null);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Note: this task does NOT change the post-firstSync cutoff
  // semantics — once `firstSyncCompletedAt` is stamped the cutoff is
  // intentionally lifted so legitimately late-arriving Plaid rows can
  // land (see `plaidFirstSyncCutoff.integration.test.ts` ::
  // "does not gate added rows once firstSyncCompletedAt is stamped").
  // What matters for #373 is that re-running sync against an already-
  // reconciled Amex item never produces a duplicate of an existing
  // manually-reconciled row, and never re-issues the same
  // `plaidTransactionId`. That's what this case asserts.
  it("re-syncing after firstSyncCompletedAt never duplicates a manually-reconciled charge or re-issues the same plaidTransactionId", async () => {
    const { itemRowId, acctRowId, externalAcctId, debtId } =
      await seedAmexItem();

    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      occurredOn: "2026-02-28",
      description: "Old reconciled charge",
      amount: "-99.00",
      source: "manual",
      debtId,
    });
    await autoDetectCutoffsForItem(TEST_USER, itemRowId, "amex");
    // Pretend the first sync already completed weeks ago.
    await db
      .update(plaidAccountsTable)
      .set({ firstSyncCompletedAt: new Date("2026-03-01T00:00:00Z") })
      .where(eq(plaidAccountsTable.id, acctRowId));

    const baselineRows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    expect(baselineRows).toHaveLength(1);

    // Plaid replays a long history of pre-cutoff added rows — none of
    // these are inside the ±7-day window of the manual row, so the merge
    // path won't claim them either. They should simply be inserted
    // (post-firstSync, the cutoff no longer gates), but none should
    // duplicate the manual row's date+amount on the same debt.
    nextSyncResponse = {
      added: [
        {
          transaction_id: "plaid-old-1",
          account_id: externalAcctId,
          date: "2025-12-15",
          amount: 5.0,
          name: "Old purchase A",
        },
        {
          transaction_id: "plaid-old-2",
          account_id: externalAcctId,
          date: "2026-01-15",
          amount: 6.0,
          name: "Old purchase B",
        },
      ],
      modified: [],
      removed: [],
    };
    await syncPlaidItem(TEST_USER, itemRowId);

    const after = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    // 1 manual + 2 newly inserted Plaid rows — and crucially, the manual
    // row is still the only row at -99 / 2026-02-28.
    const dupesOfManual = after.filter(
      (t) => t.amount === "-99.00" && t.occurredOn === "2026-02-28",
    );
    expect(dupesOfManual).toHaveLength(1);
    expect(dupesOfManual[0].source).toBe("manual");

    const plaidIds = after
      .map((t) => t.plaidTransactionId)
      .filter((x): x is string => x !== null);
    expect(new Set(plaidIds).size).toBe(plaidIds.length);
  });
});
