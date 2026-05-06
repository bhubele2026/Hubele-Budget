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
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq } from "drizzle-orm";

const TEST_USER = `cutoff-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

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

let server: Server;
let baseUrl: string;

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

beforeEach(async () => {
  await cleanup();
  nextSyncResponse = { added: [], modified: [], removed: [] };
});

async function seedAmexCardScenario(opts: {
  withLinkedDebt?: boolean;
  manualDates?: string[];
  amexSourceDates?: string[];
}): Promise<{
  itemRowId: string;
  acctRowId: string;
  externalAcctId: string;
  debtId: string | null;
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
  let debtId: string | null = null;
  if (opts.withLinkedDebt) {
    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        name: "Amex Gold",
        balance: "1000",
        plaidAccountId: acct!.id,
      })
      .returning();
    debtId = debt!.id;
    for (const d of opts.manualDates ?? []) {
      await db.insert(transactionsTable).values({
        userId: TEST_USER,
        occurredOn: d,
        description: `manual ${d}`,
        amount: "-50.00",
        source: "manual",
        debtId,
      });
    }
  }
  for (const d of opts.amexSourceDates ?? []) {
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      occurredOn: d,
      description: `amex import ${d}`,
      amount: "-25.00",
      source: "amex",
      debtId,
    });
  }
  return { itemRowId: item!.id, acctRowId: acct!.id, externalAcctId, debtId };
}

describe("(#361) Plaid first-sync import cutoff", () => {
  it("auto-detects the cutoff from existing manual rows on a linked credit account", async () => {
    const { itemRowId, acctRowId } = await seedAmexCardScenario({
      withLinkedDebt: true,
      manualDates: ["2026-01-15", "2026-02-20", "2026-02-28"],
    });
    await autoDetectCutoffsForItem(TEST_USER, itemRowId, "amex");
    const [acct] = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.id, acctRowId));
    expect(acct.importCutoffDate).toBe("2026-02-28");
    expect(acct.firstSyncCompletedAt).toBeNull();
  });

  it("falls back to source='amex' rows when an Amex account has no linked debt yet", async () => {
    const { itemRowId, acctRowId } = await seedAmexCardScenario({
      withLinkedDebt: false,
      amexSourceDates: ["2026-03-01", "2026-03-10"],
    });
    await autoDetectCutoffsForItem(TEST_USER, itemRowId, "amex");
    const [acct] = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.id, acctRowId));
    expect(acct.importCutoffDate).toBe("2026-03-10");
  });

  it("first sync skips added rows on/before the cutoff and stamps firstSyncCompletedAt", async () => {
    const { itemRowId, acctRowId, externalAcctId } =
      await seedAmexCardScenario({
        withLinkedDebt: true,
        manualDates: ["2026-02-28"],
      });
    await autoDetectCutoffsForItem(TEST_USER, itemRowId, "amex");
    nextSyncResponse = {
      added: [
        {
          transaction_id: "plaid-old-1",
          account_id: externalAcctId,
          date: "2026-02-10",
          amount: 12.34,
          name: "Old purchase before cutoff",
        },
        {
          transaction_id: "plaid-on-cutoff",
          account_id: externalAcctId,
          date: "2026-02-28",
          amount: 99.0,
          name: "On cutoff (no manual match) — skipped",
        },
        {
          transaction_id: "plaid-new-1",
          account_id: externalAcctId,
          date: "2026-03-05",
          amount: 7.5,
          name: "After cutoff — kept",
        },
      ],
      modified: [],
      removed: [],
    };
    await syncPlaidItem(TEST_USER, itemRowId);

    const txns = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    const plaidIds = txns
      .map((t) => t.plaidTransactionId)
      .filter((x): x is string => x !== null)
      .sort();
    expect(plaidIds).toEqual(["plaid-new-1"]);
    // Manual row preserved untouched.
    const manualRows = txns.filter((t) => t.source === "manual");
    expect(manualRows).toHaveLength(1);
    expect(manualRows[0].plaidTransactionId).toBeNull();

    const [acct] = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.id, acctRowId));
    expect(acct.firstSyncCompletedAt).not.toBeNull();
  });

  it("merges a near-cutoff added row into a matching manual row by adopting plaidTransactionId", async () => {
    const { itemRowId, externalAcctId, debtId } = await seedAmexCardScenario({
      withLinkedDebt: true,
      manualDates: ["2026-02-26"],
    });
    // Pre-seed a separate manual row at $42 on 2026-02-26 that the
    // sync's added row should merge with (same date, amount, debt
    // scope, source=manual, plaidTransactionId NULL).
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      occurredOn: "2026-02-26",
      description: "Coffee — manually entered before link",
      amount: "-42.00",
      source: "manual",
      debtId,
    });
    await autoDetectCutoffsForItem(TEST_USER, itemRowId, "amex");

    nextSyncResponse = {
      added: [
        {
          transaction_id: "plaid-merge-target",
          account_id: externalAcctId,
          // 1 day before the cutoff (2026-02-26): inside ±7d so the
          // merge path runs first; also <= cutoff so without the merge
          // it would be skipped instead of duplicated.
          date: "2026-02-26",
          amount: 42.0,
          name: "Coffee shop",
        },
      ],
      modified: [],
      removed: [],
    };
    await syncPlaidItem(TEST_USER, itemRowId);

    const matched = await db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, TEST_USER),
          eq(transactionsTable.plaidTransactionId, "plaid-merge-target"),
        ),
      );
    expect(matched).toHaveLength(1);
    expect(matched[0].source).toBe("manual");
    expect(matched[0].amount).toBe("-42.00");
    expect(matched[0].description).toBe("Coffee — manually entered before link");
  });

  it("does not gate added rows once firstSyncCompletedAt is stamped", async () => {
    const { itemRowId, acctRowId, externalAcctId } =
      await seedAmexCardScenario({
        withLinkedDebt: true,
        manualDates: ["2026-02-28"],
      });
    // Pretend the first sync already completed.
    await db
      .update(plaidAccountsTable)
      .set({
        importCutoffDate: "2026-02-28",
        firstSyncCompletedAt: new Date("2026-03-01T00:00:00Z"),
      })
      .where(eq(plaidAccountsTable.id, acctRowId));

    nextSyncResponse = {
      added: [
        {
          transaction_id: "plaid-late-arrival",
          account_id: externalAcctId,
          // On the cutoff — would be skipped on first sync, must not be
          // skipped on subsequent syncs.
          date: "2026-02-28",
          amount: 5.0,
          name: "Late arrival from Plaid",
        },
      ],
      modified: [],
      removed: [],
    };
    await syncPlaidItem(TEST_USER, itemRowId);

    const [hit] = await db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, TEST_USER),
          eq(transactionsTable.plaidTransactionId, "plaid-late-arrival"),
        ),
      );
    expect(hit).toBeDefined();
  });

  it("removed events never delete a manual row that the merge logic never claimed", async () => {
    const { itemRowId, debtId } = await seedAmexCardScenario({
      withLinkedDebt: true,
      manualDates: ["2026-02-15"],
    });
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      occurredOn: "2026-02-20",
      description: "Pure manual row",
      amount: "-9.99",
      source: "manual",
      debtId,
    });
    await autoDetectCutoffsForItem(TEST_USER, itemRowId, "amex");

    nextSyncResponse = {
      added: [],
      modified: [],
      removed: [{ transaction_id: "plaid-never-existed" }],
    };
    await syncPlaidItem(TEST_USER, itemRowId);

    const remaining = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.userId, TEST_USER));
    // Both manual rows still present.
    expect(remaining.filter((t) => t.source === "manual")).toHaveLength(2);
  });

  it("PATCH /plaid/accounts/:id/import-cutoff overrides while first sync is pending and rejects after", async () => {
    const { acctRowId } = await seedAmexCardScenario({
      withLinkedDebt: true,
      manualDates: ["2026-02-28"],
    });
    const ok = await fetch(
      `${baseUrl}/plaid/accounts/${acctRowId}/import-cutoff`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ importCutoffDate: "2026-01-01" }),
      },
    );
    expect(ok.status).toBe(200);
    const [acct] = await db
      .select()
      .from(plaidAccountsTable)
      .where(eq(plaidAccountsTable.id, acctRowId));
    expect(acct.importCutoffDate).toBe("2026-01-01");

    // Simulate first sync completion, then attempt another override.
    await db
      .update(plaidAccountsTable)
      .set({ firstSyncCompletedAt: new Date() })
      .where(eq(plaidAccountsTable.id, acctRowId));
    const denied = await fetch(
      `${baseUrl}/plaid/accounts/${acctRowId}/import-cutoff`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ importCutoffDate: "2026-04-01" }),
      },
    );
    expect(denied.status).toBe(409);

    const bad = await fetch(
      `${baseUrl}/plaid/accounts/${acctRowId}/import-cutoff`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ importCutoffDate: "not-a-date" }),
      },
    );
    expect(bad.status).toBe(400);
  });
});
