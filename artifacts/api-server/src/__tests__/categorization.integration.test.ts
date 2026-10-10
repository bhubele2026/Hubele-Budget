import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import * as XLSX from "xlsx";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;
const PLAID_ACCESS_TOKEN = "access-sandbox-test-access-token";

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
  categoryDecisionsTable,
  importBatchesTable,
  mappingRulesTable,
  plaidItemsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import budgetRouter from "../routes/budget";
import { createTestHousehold } from "./_helpers/testHousehold";
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
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
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
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, filename: "test.xlsx" })
      .returning();
    const wb = buildAmexWorkbook();
    const { counts, ruleAttributions } = await importWorkbook(
      TEST_USER,
      TEST_HOUSEHOLD_ID,
      wb,
      batch!.id,
    );
    expect(counts.budget_categories).toBe(3);
    expect(counts.mapping_rules).toBe(3);
    expect(counts.transactions).toBe(2);
    // Both Payments rows leave Target empty, so the Mapping rules should
    // attribute one each: STARBUCKS → Coffee and AMAZON → Amazon Misc.
    const attrByPattern = new Map(
      ruleAttributions.map((a) => [a.pattern, a.count]),
    );
    expect(attrByPattern.get("STARBUCKS")).toBe(1);
    expect(attrByPattern.get("AMAZON")).toBe(1);

    // 2) Insert a fake plaid_items row so syncPlaidItem can find it.
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
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
    //    c) "Online transfer to savings" — (#666) auto-detect disabled,
    //       this row is NOT flagged as transfer; lands as un-categorized
    //       and is excluded from buckets only because it has no allowance
    //       flag set (the dashboard never includes un-tagged rows).
    //    d) TRANSFER_IN PFC — (#666) same; the PFC arm is disabled so the
    //       row lands as un-categorized, no transfer flag.
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

    // (#666) Auto-detect disabled: no Plaid-synced row gets isTransfer=true
    // automatically. Both the description-shaped and PFC-shaped rows land
    // as plain un-categorized rows (still correctly excluded from bucket
    // totals because no allowance flag was set).
    const transferRows = await db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, TEST_USER),
          eq(transactionsTable.isTransfer, true),
        ),
      );
    expect(transferRows.length).toBe(0);
  });

  // (PR-A) The PATCH auto-learn flow (2-token auto-rule creation, repointing
  // matching rules, ruleAction/repointedRules toasts) was removed:
  // mapping_rules are user-authored only. A hand pick now writes a `user`
  // decision and merchant memory (categorizerEngine.integration.test.ts covers
  // memory, retroactive candidates and undo). These replace the nine tests
  // that pinned the old behaviour.
  it("(PR-A) PATCH /transactions/:id with a category creates and repoints no mapping rule", async () => {
    const [cat] = await db
      .insert(budgetCategoriesTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: `PRA Learn ${randomUUID().slice(0, 6)}`, kind: "expense", groupName: "Other", sourceKind: "manual" })
      .returning();
    const [other] = await db
      .insert(budgetCategoriesTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: `PRA Seed ${randomUUID().slice(0, 6)}`, kind: "expense", groupName: "Other", sourceKind: "manual" })
      .returning();
    const uniq = `PRA${randomUUID().slice(0, 6).toUpperCase()}`;
    // A specific (2-token) rule that used to be repointed by the pick.
    await db.insert(mappingRulesTable).values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, pattern: `${uniq} PAYMENT`, matchType: "contains", categoryId: other!.id, priority: 0 });
    const rulesBefore = await db.select().from(mappingRulesTable).where(eq(mappingRulesTable.householdId, TEST_HOUSEHOLD_ID));
    const [txn] = await db
      .insert(transactionsTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, occurredOn: dateInCurrentMonth(5), description: `${uniq} PAYMENT 0042`, amount: "-75.00", source: "bank" })
      .returning();
    const patch = await api("PATCH", `/transactions/${txn!.id}`, { categoryId: cat!.id, rememberPattern: `${uniq} PAYMENT` });
    expect(patch.status).toBe(200);
    const body = patch.json as { ruleAction: { kind: string }; repointedRules: unknown[]; categoryLockedByUser: boolean };
    expect(body.ruleAction.kind).toBe("none");
    expect(body.repointedRules).toEqual([]);
    expect(body.categoryLockedByUser).toBe(true);
    const rulesAfter = await db.select().from(mappingRulesTable).where(eq(mappingRulesTable.householdId, TEST_HOUSEHOLD_ID));
    expect(rulesAfter.map((r) => [r.id, r.pattern, r.categoryId]).sort()).toEqual(rulesBefore.map((r) => [r.id, r.pattern, r.categoryId]).sort());
  });

  it("(PR-A) PATCH /transactions/:id on a transfer-flagged row clears the transfer flag (Task #479) and creates no rule", async () => {
    const [cat] = await db
      .insert(budgetCategoriesTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: `Transfer Test ${randomUUID().slice(0, 6)}`, kind: "expense", groupName: "Other", sourceKind: "manual" })
      .returning();
    const uniqueDesc = `XFER-DESC-${randomUUID().slice(0, 8)}`;
    const [txn] = await db
      .insert(transactionsTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, occurredOn: dateInCurrentMonth(24), description: uniqueDesc, amount: "-50.00", source: "bank", isTransfer: true })
      .returning();
    const patch = await api("PATCH", `/transactions/${txn!.id}`, { categoryId: cat!.id });
    expect(patch.status).toBe(200);
    expect((patch.json as { isTransfer: boolean }).isTransfer).toBe(false);
    const rules = await db.select().from(mappingRulesTable).where(and(eq(mappingRulesTable.userId, TEST_USER), eq(mappingRulesTable.categoryId, cat!.id)));
    expect(rules).toHaveLength(0);
  });

  it("(PR-A) POST /transactions/recategorize-by-pattern still bulk-flips the matching rows (null and real fromCategoryId)", async () => {
    const [from] = await db
      .insert(budgetCategoriesTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: `PRA From ${randomUUID().slice(0, 6)}`, kind: "expense", groupName: "Other", sourceKind: "manual" })
      .returning();
    const [to] = await db
      .insert(budgetCategoriesTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: `PRA To ${randomUUID().slice(0, 6)}`, kind: "expense", groupName: "Other", sourceKind: "manual" })
      .returning();
    const uniq = `PRB${randomUUID().slice(0, 6).toUpperCase()}`;
    const mk = (categoryId: string | null, day: number) =>
      db.insert(transactionsTable).values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, occurredOn: dateInCurrentMonth(day), description: `${uniq} SHOP`, amount: "-10.00", source: "bank", categoryId }).returning();
    const [[n1], [n2], [f1]] = await Promise.all([mk(null, 2), mk(null, 3), mk(from!.id, 4)]);
    const a = await api("POST", "/transactions/recategorize-by-pattern", { pattern: uniq, matchType: "contains", fromCategoryId: null, toCategoryId: to!.id });
    expect((a.json as { updated: number }).updated).toBe(2);
    const b = await api("POST", "/transactions/recategorize-by-pattern", { pattern: uniq, matchType: "contains", fromCategoryId: from!.id, toCategoryId: to!.id });
    expect((b.json as { updated: number }).updated).toBe(1);
    const rows = await db.select().from(transactionsTable).where(inArray(transactionsTable.id, [n1!.id, n2!.id, f1!.id]));
    expect(rows.every((r) => r.categoryId === to!.id && r.categoryLockedByUser)).toBe(true);
  });

  it("(WP5d) POST /transactions never lets a rule file money against its direction: stored uncategorized, queued naming the rule", async () => {
    const [dining] = await db
      .insert(budgetCategoriesTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: `Dir Dining ${randomUUID().slice(0, 6)}`, kind: "expense", groupName: "Other" })
      .returning();
    const merchant = `DIRMERCH${randomUUID().slice(0, 6).toUpperCase()}`;
    const [rule] = await db
      .insert(mappingRulesTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, pattern: merchant, matchType: "contains", categoryId: dining!.id, priority: 100 })
      .returning();

    // Money in that the rule would file under Dining: stored uncategorized, queued.
    const inflow = await api("POST", "/transactions", {
      occurredOn: dateInCurrentMonth(14),
      description: `${merchant} PAYROLL`,
      amount: "2500.00",
      source: "manual",
    });
    expect(inflow.status).toBe(201);
    const inRow = inflow.json as { id: string; categoryId: string | null; categoryLockedByUser: boolean; autoCategorizedRuleId: string | null };
    expect(inRow).toMatchObject({ categoryId: null, categoryLockedByUser: false, autoCategorizedRuleId: null });
    const decisions = await db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.transactionId, inRow.id));
    expect(decisions).toEqual([
      expect.objectContaining({
        source: "rule",
        band: "queue",
        categoryId: dining!.id,
        ruleId: rule!.id,
        explanation: "Money in, but this would file it under an expense category.",
      }),
    ]);

    // Money out: filed by the rule as before, attributed, not locked.
    const outflow = await api("POST", "/transactions", {
      occurredOn: dateInCurrentMonth(14),
      description: `${merchant} CAFE`,
      amount: "-8.50",
      source: "manual",
    });
    expect(outflow.json).toMatchObject({ categoryId: dining!.id, categoryLockedByUser: false, autoCategorizedRuleId: rule!.id });

    // A person's explicit pick is never second-guessed: kept and locked.
    const explicit = await api("POST", "/transactions", {
      occurredOn: dateInCurrentMonth(14),
      description: `${merchant} PAYROLL 2`,
      amount: "2500.00",
      source: "manual",
      categoryId: dining!.id,
    });
    expect(explicit.json).toMatchObject({ categoryId: dining!.id, categoryLockedByUser: true });

    // A reimbursable credit is expected in an expense category: filed by the rule.
    const reimbursed = await api("POST", "/transactions", {
      occurredOn: dateInCurrentMonth(14),
      description: `${merchant} SPLIT FROM J`,
      amount: "30.00",
      source: "manual",
      reimbursable: true,
    });
    expect(reimbursed.json).toMatchObject({ categoryId: dining!.id, autoCategorizedRuleId: rule!.id });
  });

  it("POST /transactions auto-categorizes hand-entered rows via the existing rules", async () => {
    // Task #207 — POST should mirror the import / Plaid-sync auto-
    // categorize pipeline so a hand-typed merchant lands in the same
    // category an imported row would. Cover three branches in one test:
    //   1. body omits categoryId → server fills it from the matching rule
    //   2. description mentions "online transfer to savings" → isTransfer
    //      flips to true so the row is excluded from budget actuals
    //   3. body explicitly passes a categoryId → that wins, even when a
    //      rule would have picked something different
    const [coffeeCat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: `Manual Coffee ${randomUUID().slice(0, 6)}`,
        kind: "expense",
        groupName: "Other",
        sourceKind: "manual",
      })
      .returning();
    const [otherCat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: `Manual Other ${randomUUID().slice(0, 6)}`,
        kind: "expense",
        groupName: "Other",
        sourceKind: "manual",
      })
      .returning();
    const merchant = `MANUALMERCH${randomUUID().slice(0, 6).toUpperCase()}`;
    await db.insert(mappingRulesTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      pattern: merchant,
      matchType: "contains",
      categoryId: coffeeCat!.id,
      priority: 100,
    });

    // 1) POST without categoryId → categorize() picks coffeeCat from the rule.
    const created = await api("POST", "/transactions", {
      occurredOn: dateInCurrentMonth(11),
      description: `${merchant} STORE #221`,
      amount: "-4.25",
      source: "manual",
    });
    expect(created.status).toBe(201);
    const createdRow = created.json as {
      id: string;
      categoryId: string | null;
      isTransfer: boolean;
      autoCategorizedRuleId: string | null;
    };
    expect(createdRow.categoryId).toBe(coffeeCat!.id);
    expect(createdRow.isTransfer).toBe(false);
    // Task #218 — POST should report which mapping rule auto-attributed
    // the row so the Add-Transaction client can show a "matched by rule
    // X" confirmation toast and offer Undo to clear the auto-pick.
    const [matchedRuleRow] = await db
      .select()
      .from(mappingRulesTable)
      .where(
        and(
          eq(mappingRulesTable.userId, TEST_USER),
          eq(mappingRulesTable.pattern, merchant),
        ),
      );
    expect(createdRow.autoCategorizedRuleId).toBe(matchedRuleRow!.id);

    // 2) (#666) POST a description that previously tripped the
    //    transfer-detection regex → with auto-detect disabled, the row
    //    must NOT be auto-flagged. The user is in full manual control;
    //    they explicitly pick the system "Transfer" category when they
    //    want a row excluded from buckets.
    const transfer = await api("POST", "/transactions", {
      occurredOn: dateInCurrentMonth(12),
      description: "ONLINE TRANSFER TO SAVINGS XXXX9999",
      amount: "-500.00",
      source: "manual",
    });
    expect(transfer.status).toBe(201);
    const transferRow = transfer.json as {
      id: string;
      categoryId: string | null;
      isTransfer: boolean;
      autoCategorizedRuleId: string | null;
    };
    expect(transferRow.isTransfer).toBe(false);
    expect(transferRow.categoryId).toBeNull();
    expect(transferRow.autoCategorizedRuleId).toBeNull();
    const [persistedTransfer] = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.id, transferRow.id));
    expect(persistedTransfer!.isTransfer).toBe(false);

    // 3) POST with an explicit categoryId → server must NOT silently
    //    overwrite it with the rule's pick (otherCat wins even though
    //    the merchant matches a coffeeCat rule).
    const overridden = await api("POST", "/transactions", {
      occurredOn: dateInCurrentMonth(13),
      description: `${merchant} STORE #444`,
      amount: "-9.99",
      source: "manual",
      categoryId: otherCat!.id,
    });
    expect(overridden.status).toBe(201);
    const overriddenRow = overridden.json as {
      id: string;
      categoryId: string | null;
    };
    expect(overriddenRow.categoryId).toBe(otherCat!.id);
  });
});
