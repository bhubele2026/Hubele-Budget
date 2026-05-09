import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq } from "drizzle-orm";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const PLAID_ACCESS_TOKEN = "access-sandbox-test-token";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = TEST_USER;
    next();
  },
}));

const transactionsSyncMock = vi.fn();
vi.mock("../lib/plaid", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => ({ transactionsSync: transactionsSyncMock }),
  };
});

import {
  db,
  budgetCategoriesTable,
  mappingRulesTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import transactionsRouter from "../routes/transactions";
import { syncPlaidItem } from "../lib/plaidSync";

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(transactionsRouter);

let server: Server;
let baseUrl: string;

async function deleteAllForUser(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(mappingRulesTable).where(eq(mappingRulesTable.userId, TEST_USER));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  await deleteAllForUser();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await deleteAllForUser();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function readRow(id: string) {
  const [row] = await db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.id, id),
        eq(transactionsTable.userId, TEST_USER),
      ),
    );
  return row;
}

describe("isTransfer user override (#479)", () => {
  it("PATCH isTransfer=false sets isTransferUserOverridden=true", async () => {
    const [row] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        occurredOn: "2026-05-01",
        description: "ONLINE TRANSFER TO SAVINGS",
        amount: "-100.00",
        isTransfer: true,
        source: "manual",
      })
      .returning();
    expect(row!.isTransferUserOverridden).toBe(false);

    const r = await api("PATCH", `/transactions/${row!.id}`, {
      isTransfer: false,
    });
    expect(r.status).toBe(200);

    const after = await readRow(row!.id);
    expect(after.isTransfer).toBe(false);
    expect(after.isTransferUserOverridden).toBe(true);
  });

  it("PATCH isTransfer=true on a non-transfer row also sets the override flag", async () => {
    const [row] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        occurredOn: "2026-05-02",
        description: "STARBUCKS STORE 4477",
        amount: "-5.50",
        isTransfer: false,
        source: "manual",
      })
      .returning();

    const r = await api("PATCH", `/transactions/${row!.id}`, {
      isTransfer: true,
    });
    expect(r.status).toBe(200);

    const after = await readRow(row!.id);
    expect(after.isTransfer).toBe(true);
    expect(after.isTransferUserOverridden).toBe(true);
  });

  it("Picking a category on a Transfer row clears isTransfer and sets override", async () => {
    const [cat] = await db
      .insert(budgetCategoriesTable)
      .values({ userId: TEST_USER, name: "Coffee" })
      .returning();
    const [row] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        occurredOn: "2026-05-03",
        description: "AMAZON.COM AMZN.COM/BILL WA",
        amount: "-32.18",
        isTransfer: true,
        source: "manual",
      })
      .returning();

    const r = await api("PATCH", `/transactions/${row!.id}`, {
      categoryId: cat!.id,
    });
    expect(r.status).toBe(200);

    const after = await readRow(row!.id);
    expect(after.categoryId).toBe(cat!.id);
    expect(after.isTransfer).toBe(false);
    expect(after.isTransferUserOverridden).toBe(true);
  });

  it("Plaid sync onConflictDoUpdate preserves isTransfer when override flag is set", async () => {
    // 1) Insert a Plaid-tagged transaction the user has manually un-flagged
    //    as a transfer (override = true).
    const plaidTxnId = `t-${randomUUID()}`;
    const [row] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        occurredOn: "2026-05-04",
        description: "ONLINE TRANSFER TO SAVINGS XXXX1234",
        amount: "-500.00",
        isTransfer: false,
        isTransferUserOverridden: true,
        source: "plaid:bank",
        plaidTransactionId: plaidTxnId,
        plaidAccountId: "acct-1",
      })
      .returning();
    expect(row!.isTransfer).toBe(false);
    expect(row!.isTransferUserOverridden).toBe(true);

    // 2) Spin up a Plaid item and arrange syncPlaidItem to "modify" the same
    //    transaction with description+PFC that would re-trigger the auto-
    //    transfer heuristic. With the override flag set, the upsert must
    //    preserve isTransfer=false instead of flipping it back to true.
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        itemId: `it-${randomUUID()}`,
        accessToken: PLAID_ACCESS_TOKEN,
        institutionName: "Test Bank",
        institutionSlug: "bank",
      })
      .returning();

    transactionsSyncMock.mockResolvedValueOnce({
      data: {
        added: [],
        modified: [
          {
            transaction_id: plaidTxnId,
            account_id: "acct-1",
            amount: 500.0,
            date: "2026-05-04",
            name: "ONLINE TRANSFER TO SAVINGS XXXX1234",
            merchant_name: null,
            pending: false,
            personal_finance_category: {
              primary: "TRANSFER_OUT",
              detailed: "TRANSFER_OUT_SAVINGS",
            },
          },
        ],
        removed: [],
        next_cursor: "cur-1",
        has_more: false,
      },
    });

    const syncResult = await syncPlaidItem(TEST_USER, item!.id);
    expect(syncResult.error).toBeNull();

    const after = await readRow(row!.id);
    expect(after.isTransfer).toBe(false);
    expect(after.isTransferUserOverridden).toBe(true);
  });

  it("POST /transactions/:id/clear-transfer-override clears the override flag", async () => {
    const [row] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        occurredOn: "2026-05-06",
        description: "ONLINE TRANSFER TO SAVINGS XXXX5555",
        amount: "-50.00",
        isTransfer: false,
        isTransferUserOverridden: true,
        source: "manual",
      })
      .returning();
    expect(row!.isTransferUserOverridden).toBe(true);

    const r = await api(
      "POST",
      `/transactions/${row!.id}/clear-transfer-override`,
    );
    expect(r.status).toBe(200);

    const after = await readRow(row!.id);
    // isTransfer is left untouched — only the override flag is cleared.
    expect(after.isTransfer).toBe(false);
    expect(after.isTransferUserOverridden).toBe(false);
  });

  it("POST /transactions/:id/clear-transfer-override returns 404 for unknown ids", async () => {
    const r = await api(
      "POST",
      `/transactions/${randomUUID()}/clear-transfer-override`,
    );
    expect(r.status).toBe(404);
  });

  it("(#607) PATCH categoryId=Transfer flips isTransfer=true, sets override, clears allowance flags", async () => {
    // Seed the system-managed Transfer category the same way the budget
    // route's lazy-seed path would (excludeFromBudget=true, name="Transfer").
    const [transferCat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        name: "Transfer",
        excludeFromBudget: true,
      })
      .returning();
    const [row] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        occurredOn: "2026-05-07",
        description: "ZELLE PAYMENT TO MOM",
        amount: "-200.00",
        isTransfer: false,
        weeklyAllowance: true,
        monthlyAllowance: true,
        unplannedAllowance: true,
        source: "manual",
      })
      .returning();

    const r = await api("PATCH", `/transactions/${row!.id}`, {
      categoryId: transferCat!.id,
    });
    expect(r.status).toBe(200);

    const after = await readRow(row!.id);
    expect(after.categoryId).toBe(transferCat!.id);
    expect(after.isTransfer).toBe(true);
    expect(after.isTransferUserOverridden).toBe(true);
    expect(after.weeklyAllowance).toBe(false);
    expect(after.monthlyAllowance).toBe(false);
    expect(after.unplannedAllowance).toBe(false);
  });

  it("(#607) POST /transactions with categoryId=Transfer sets isTransfer=true + override and clears allowance flags", async () => {
    const [transferCat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        name: "Transfer",
        excludeFromBudget: true,
      })
      .onConflictDoUpdate({
        target: [budgetCategoriesTable.userId, budgetCategoriesTable.name],
        set: { excludeFromBudget: true },
      })
      .returning();

    const r = await api("POST", `/transactions`, {
      occurredOn: "2026-05-08",
      description: "INTERNAL TRANSFER NEW ROW",
      amount: "-75.00",
      categoryId: transferCat!.id,
      // Client mistakenly sends allowance flags; server must overrule.
      weeklyAllowance: true,
      monthlyAllowance: true,
      unplannedAllowance: true,
    });
    expect(r.status).toBe(201);
    const created = r.json as { id: string };

    const after = await readRow(created.id);
    expect(after.categoryId).toBe(transferCat!.id);
    expect(after.isTransfer).toBe(true);
    expect(after.isTransferUserOverridden).toBe(true);
    expect(after.weeklyAllowance).toBe(false);
    expect(after.monthlyAllowance).toBe(false);
    expect(after.unplannedAllowance).toBe(false);
  });

  it("Without the override flag, Plaid sync still re-applies the auto-Transfer heuristic", async () => {
    // Sanity check that the CASE expression's ELSE branch is wired up — a
    // row whose user-overridden flag is *false* keeps getting re-flagged
    // by future syncs (the existing pre-#479 behavior).
    const plaidTxnId = `t-${randomUUID()}`;
    const [row] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        occurredOn: "2026-05-05",
        description: "ONLINE TRANSFER TO SAVINGS XXXX9999",
        amount: "-200.00",
        isTransfer: false,
        isTransferUserOverridden: false,
        source: "plaid:bank",
        plaidTransactionId: plaidTxnId,
        plaidAccountId: "acct-1",
      })
      .returning();

    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        itemId: `it-${randomUUID()}`,
        accessToken: PLAID_ACCESS_TOKEN,
        institutionName: "Test Bank 2",
        institutionSlug: "bank2",
      })
      .returning();

    transactionsSyncMock.mockResolvedValueOnce({
      data: {
        added: [],
        modified: [
          {
            transaction_id: plaidTxnId,
            account_id: "acct-1",
            amount: 200.0,
            date: "2026-05-05",
            name: "ONLINE TRANSFER TO SAVINGS XXXX9999",
            merchant_name: null,
            pending: false,
            personal_finance_category: {
              primary: "TRANSFER_OUT",
              detailed: "TRANSFER_OUT_SAVINGS",
            },
          },
        ],
        removed: [],
        next_cursor: "cur-2",
        has_more: false,
      },
    });

    const syncResult = await syncPlaidItem(TEST_USER, item!.id);
    expect(syncResult.error).toBeNull();

    const after = await readRow(row!.id);
    expect(after.isTransfer).toBe(true);
    expect(after.isTransferUserOverridden).toBe(false);
    void row;
  });
});
