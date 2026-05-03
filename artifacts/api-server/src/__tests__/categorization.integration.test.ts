import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq } from "drizzle-orm";
import * as XLSX from "xlsx";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const PLAID_ACCESS_TOKEN = "test-access-token";

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
  budgetLinesTable,
  budgetMonthsTable,
  importBatchesTable,
  mappingRulesTable,
  plaidItemsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import budgetRouter from "../routes/budget";
import transactionsRouter from "../routes/transactions";
import { syncPlaidItem } from "../lib/plaidSync";
import { importWorkbook } from "../lib/workbookImporter";
import { loadUserRules, categorize } from "../lib/autoCategorize";

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(budgetRouter);
app.use(transactionsRouter);

let server: Server;
let baseUrl: string;

function currentMonthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function dateInCurrentMonth(day: number): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function deleteAllForUser(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(budgetLinesTable).where(eq(budgetLinesTable.userId, TEST_USER));
  await db.delete(budgetMonthsTable).where(eq(budgetMonthsTable.userId, TEST_USER));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, TEST_USER));
  await db.delete(mappingRulesTable).where(eq(mappingRulesTable.userId, TEST_USER));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
  await db.delete(importBatchesTable).where(eq(importBatchesTable.userId, TEST_USER));
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

// Build a minimal in-memory workbook that satisfies importWorkbook's required
// sheet layout (sheet names + the row indices where it starts reading data).
function buildAmexWorkbook(): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const pad = (n: number, label: string): unknown[][] =>
    Array.from({ length: n }, () => [label]);

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([...pad(4, "DT")]),
    "Debt Tracker",
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ...pad(5, "MB"),
      [1, "Coffee", 50, null, null, null, null],
      [2, "Electric", 250, null, null, null, null],
      [3, "Amazon Misc", 100, null, null, null, null],
    ]),
    "Monthly Budget",
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([...pad(5, "RI")]),
    "Recurring Items",
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ...pad(4, "MAP"),
      ["STARBUCKS", "Coffee"],
      ["MGE", "Electric"],
      ["AMAZON", "Amazon Misc"],
    ]),
    "Mapping",
  );

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ...pad(5, "PAY"),
      [null, dateInCurrentMonth(6), "STARBUCKS COFFEE #221", "Expense", null, 4.25, null, null],
      [null, dateInCurrentMonth(20), "AMAZON.COM*Z123", "Expense", null, 32.18, null, null],
    ]),
    "Payments",
  );

  return wb;
}

type BudgetLineRow = {
  categoryName: string;
  plannedAmount: string;
  actualAmount: string;
  sourceBreakdown: { source: string; count: number; amount: string }[];
};

describe("categorization pipeline (integration)", () => {
  it("imports an Amex workbook + Plaid batch and reports correct per-line actuals", async () => {
    // 1) Run the real Amex workbook importer. This seeds budget_categories,
    //    mapping_rules, and source="amex" transactions for the test user.
    const [batch] = await db
      .insert(importBatchesTable)
      .values({ userId: TEST_USER, filename: "test.xlsx" })
      .returning();
    const wb = buildAmexWorkbook();
    const counts = await importWorkbook(TEST_USER, wb, batch!.id);
    expect(counts.budget_categories).toBe(3);
    expect(counts.mapping_rules).toBe(3);
    expect(counts.transactions).toBe(2);

    // 2) Insert a fake plaid_items row so syncPlaidItem can find it.
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
    expect(item).toBeTruthy();

    // 3) Mock Plaid transactionsSync to return:
    //    a) Starbucks → Coffee via description rule
    //    b) MGE → Electric via description rule
    //    c) "Online transfer to savings" → flagged via description, excluded
    //    d) TRANSFER_IN PFC → flagged via PFC, excluded
    const fakeTxns = [
      {
        transaction_id: `t-${randomUUID()}`,
        account_id: "acct-1",
        amount: 5.5,
        date: dateInCurrentMonth(4),
        name: "STARBUCKS STORE 4477",
        merchant_name: "Starbucks",
        pending: false,
        personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE" },
      },
      {
        transaction_id: `t-${randomUUID()}`,
        account_id: "acct-1",
        amount: 241.0,
        date: dateInCurrentMonth(10),
        name: "MGE ENERGY BILL",
        merchant_name: null,
        pending: false,
        personal_finance_category: { primary: "RENT_AND_UTILITIES", detailed: "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY" },
      },
      {
        transaction_id: `t-${randomUUID()}`,
        account_id: "acct-1",
        amount: 500.0,
        date: dateInCurrentMonth(12),
        name: "ONLINE TRANSFER TO SAVINGS XXXX1234",
        merchant_name: null,
        pending: false,
        personal_finance_category: null,
      },
      {
        transaction_id: `t-${randomUUID()}`,
        account_id: "acct-1",
        amount: -100.0,
        date: dateInCurrentMonth(15),
        name: "ACH credit from external account",
        merchant_name: null,
        pending: false,
        personal_finance_category: { primary: "TRANSFER_IN", detailed: "TRANSFER_IN_DEPOSIT" },
      },
    ];

    transactionsSyncMock.mockResolvedValueOnce({
      data: {
        added: fakeTxns,
        modified: [],
        removed: [],
        next_cursor: "cur-1",
        has_more: false,
      },
    });

    const syncResult = await syncPlaidItem(TEST_USER, item!.id);
    expect(syncResult.error).toBeNull();
    expect(syncResult.added).toBe(4);
    expect(syncResult.autoCategorized).toBe(2);

    // 4) Hit the budget month endpoint and assert per-line actuals + breakdowns.
    const monthRes = await api("GET", `/budget/months/${currentMonthStart()}`);
    expect(monthRes.status).toBe(200);
    const month = monthRes.json as { lines: BudgetLineRow[] };
    const lineByName = new Map(month.lines.map((l) => [l.categoryName, l]));

    const coffee = lineByName.get("Coffee");
    expect(coffee, "Coffee line exists").toBeTruthy();
    expect(coffee!.actualAmount).toBe("9.75"); // 5.50 plaid + 4.25 amex
    const coffeeSources = new Map(
      coffee!.sourceBreakdown.map((b) => [b.source, b]),
    );
    expect(coffeeSources.get("Bank")?.count).toBe(1);
    expect(coffeeSources.get("Amex")?.count).toBe(1);

    const electric = lineByName.get("Electric");
    expect(electric, "Electric line exists").toBeTruthy();
    expect(electric!.actualAmount).toBe("241.00");
    expect(
      electric!.sourceBreakdown.find((b) => b.source === "Bank")?.count,
    ).toBe(1);

    const amazon = lineByName.get("Amazon Misc");
    expect(amazon, "Amazon Misc line exists").toBeTruthy();
    expect(amazon!.actualAmount).toBe("32.18");
    expect(
      amazon!.sourceBreakdown.find((b) => b.source === "Amex")?.count,
    ).toBe(1);

    const totalActual = month.lines.reduce(
      (sum, l) => sum + (parseFloat(l.actualAmount) || 0),
      0,
    );
    // Transfers ($500 + $100) MUST NOT be included anywhere.
    expect(totalActual).toBeCloseTo(9.75 + 241.0 + 32.18, 2);

    const transferRows = await db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, TEST_USER),
          eq(transactionsTable.isTransfer, true),
        ),
      );
    expect(transferRows.length).toBe(2);
  });

  it("PATCH /transactions/:id with rememberPattern upserts a mapping_rule and re-categorizes similar txns", async () => {
    const merchant = `MYSTERY-${randomUUID().slice(0, 8).toUpperCase()}`;

    const [cat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        name: `Mystery Test ${randomUUID().slice(0, 6)}`,
        kind: "expense",
        groupName: "Other",
        sourceKind: "manual",
      })
      .returning();

    const [txn] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        occurredOn: dateInCurrentMonth(22),
        description: `${merchant} STORE 0001`,
        amount: "-12.34",
        source: "manual",
      })
      .returning();

    const patch = await api("PATCH", `/transactions/${txn!.id}`, {
      categoryId: cat!.id,
      rememberPattern: merchant,
    });
    expect(patch.status).toBe(200);

    const rules = await db
      .select()
      .from(mappingRulesTable)
      .where(
        and(
          eq(mappingRulesTable.userId, TEST_USER),
          eq(mappingRulesTable.pattern, merchant),
        ),
      );
    expect(rules.length).toBe(1);
    expect(rules[0]!.categoryId).toBe(cat!.id);
    expect(rules[0]!.priority).toBe(100);
    expect(rules[0]!.matchType).toBe("contains");

    // Re-running the rule engine should match a similar description.
    const ruleRows = await loadUserRules(TEST_USER);
    const result = categorize(
      { description: `${merchant} ANOTHER LOCATION 9999` },
      ruleRows,
    );
    expect(result.categoryId).toBe(cat!.id);

    // PATCH again with a different category — rule should update, not duplicate.
    const [cat2] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        name: `Mystery Test 2 ${randomUUID().slice(0, 6)}`,
        kind: "expense",
        groupName: "Other",
        sourceKind: "manual",
      })
      .returning();
    const patch2 = await api("PATCH", `/transactions/${txn!.id}`, {
      categoryId: cat2!.id,
      rememberPattern: merchant,
    });
    expect(patch2.status).toBe(200);
    const rules2 = await db
      .select()
      .from(mappingRulesTable)
      .where(
        and(
          eq(mappingRulesTable.userId, TEST_USER),
          eq(mappingRulesTable.pattern, merchant),
        ),
      );
    expect(rules2.length).toBe(1);
    expect(rules2[0]!.categoryId).toBe(cat2!.id);
  });

  it("PATCH /transactions/:id without rememberPattern auto-derives a rule from the description", async () => {
    const merchant = `AUTOMERCH${randomUUID().slice(0, 6).toUpperCase()}`;

    const [cat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        name: `Auto Test ${randomUUID().slice(0, 6)}`,
        kind: "expense",
        groupName: "Other",
        sourceKind: "manual",
      })
      .returning();

    const [txn] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        occurredOn: dateInCurrentMonth(23),
        description: `${merchant} STORE #5523`,
        amount: "-9.99",
        source: "manual",
      })
      .returning();

    // No rememberPattern in body — but a rule should still be created from
    // the cleaned description.
    const patch = await api("PATCH", `/transactions/${txn!.id}`, {
      categoryId: cat!.id,
    });
    expect(patch.status).toBe(200);

    const rules = await db
      .select()
      .from(mappingRulesTable)
      .where(
        and(
          eq(mappingRulesTable.userId, TEST_USER),
          eq(mappingRulesTable.categoryId, cat!.id),
        ),
      );
    expect(rules.length).toBe(1);
    // First 2 tokens after stripping '#...' suffix.
    expect(rules[0]!.pattern).toBe(`${merchant} STORE`);
    expect(rules[0]!.matchType).toBe("contains");
    expect(rules[0]!.priority).toBe(100);
  });

  it("PATCH /transactions/:id does not create a rule for an internal transfer", async () => {
    const [cat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        name: `Transfer Test ${randomUUID().slice(0, 6)}`,
        kind: "expense",
        groupName: "Other",
        sourceKind: "manual",
      })
      .returning();

    const uniqueDesc = `XFER-DESC-${randomUUID().slice(0, 8)}`;
    const [txn] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        occurredOn: dateInCurrentMonth(24),
        description: uniqueDesc,
        amount: "-50.00",
        source: "bank",
        isTransfer: true,
      })
      .returning();

    const patch = await api("PATCH", `/transactions/${txn!.id}`, {
      categoryId: cat!.id,
    });
    expect(patch.status).toBe(200);

    const rules = await db
      .select()
      .from(mappingRulesTable)
      .where(
        and(
          eq(mappingRulesTable.userId, TEST_USER),
          eq(mappingRulesTable.categoryId, cat!.id),
        ),
      );
    expect(rules.length).toBe(0);
  });
});
