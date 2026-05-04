import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
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
    // Task #185 — explicit-remember path creates a brand-new specific
    // rule and reports it back to the client so it can show a toast.
    const patchBody = patch.json as {
      ruleAction: { kind: string; pattern: string | null };
    };
    expect(patchBody.ruleAction.kind).toBe("created");
    expect(patchBody.ruleAction.pattern).toBe(merchant);

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
    // Second PATCH matches the existing specific rule (the one we just
    // created above) so the auto-relearn flow repoints it instead of
    // creating a duplicate. RuleAction reflects that.
    const patch2Body = patch2.json as {
      ruleAction: { kind: string; pattern: string | null };
    };
    expect(patch2Body.ruleAction.kind).toBe("repointed");
    expect(patch2Body.ruleAction.pattern).toBe(merchant);
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
    // Task #185 — auto-derived path with no generic conflict reports
    // `created` so the client toast can say "Future 'X' charges will
    // auto-categorize here."
    const patchBody = patch.json as {
      ruleAction: { kind: string; pattern: string | null };
    };
    expect(patchBody.ruleAction.kind).toBe("created");
    expect(patchBody.ruleAction.pattern).toBe(`${merchant} STORE`);

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

  it("PATCH /transactions/:id reports repointedRules with a candidateCount and POST /transactions/recategorize-by-pattern bulk-flips the historical rows", async () => {
    // Mirror the production "AMERICAN EXPRESS ACH → Misc/Buffer" seed
    // scenario: a mapping rule was pre-pointed at Misc/Buffer, several
    // older payments were already auto-categorized into Misc/Buffer, and
    // the user picks the real per-debt category for one of them. The
    // PATCH response should include the repointed rule + candidate count
    // for the remaining historical rows, and POSTing to the bulk
    // endpoint should flip exactly those rows (skipping any manually
    // categorized to a different category and leaving the originally
    // edited row alone).
    const [miscCat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        name: `Misc Buffer Bulk ${randomUUID().slice(0, 6)}`,
        kind: "expense",
        groupName: "Other",
        sourceKind: "manual",
      })
      .returning();
    const [debtCat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        name: `Amex Bulk ${randomUUID().slice(0, 6)}`,
        kind: "expense",
        groupName: "Debt",
        sourceKind: "manual",
      })
      .returning();
    const [otherCat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        name: `Other Bulk ${randomUUID().slice(0, 6)}`,
        kind: "expense",
        groupName: "Other",
        sourceKind: "manual",
      })
      .returning();

    // Real debt seed patterns ship as 2+ whitespace-separated tokens
    // ("AMERICAN EXPRESS ACH", "AMEX EPAYMENT", ...). Task #182's smarter
    // auto-relearn only silently repoints those *specific* shapes, so this
    // bulk-re-categorize fixture mirrors a realistic seed shape.
    const seedPattern = `BULKAMEX ACH-${randomUUID().slice(0, 6).toUpperCase()}`;
    const [seedRule] = await db
      .insert(mappingRulesTable)
      .values({
        userId: TEST_USER,
        pattern: seedPattern,
        matchType: "contains",
        categoryId: miscCat!.id,
        priority: 50,
      })
      .returning();

    // Three older payments already auto-categorized into Misc/Buffer
    // (the rule's old category) — these should snap onto debtCat in bulk.
    const olderIds: string[] = [];
    for (let day = 5; day <= 7; day++) {
      const [r] = await db
        .insert(transactionsTable)
        .values({
          userId: TEST_USER,
          occurredOn: dateInCurrentMonth(day),
          description: `${seedPattern} PMT XXXX${1000 + day}`,
          amount: "-150.00",
          source: "bank",
          categoryId: miscCat!.id,
        })
        .returning();
      olderIds.push(r!.id);
    }

    // One matching payment that the user manually re-categorized to a
    // different non-Misc category — must be preserved.
    const [manualOther] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        occurredOn: dateInCurrentMonth(8),
        description: `${seedPattern} PMT MANUAL`,
        amount: "-99.00",
        source: "bank",
        categoryId: otherCat!.id,
      })
      .returning();

    // One uncategorized matching payment — also must be left alone (we
    // only touch rows currently in fromCategoryId).
    const [uncatRow] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        occurredOn: dateInCurrentMonth(9),
        description: `${seedPattern} PMT UNCAT`,
        amount: "-12.00",
        source: "bank",
      })
      .returning();

    // The "trigger" txn — the user picks the real debt category for one
    // of the historical rows. Server should repoint the seed rule and
    // report 2 remaining candidates (3 older - 1 just edited).
    const triggerId = olderIds[0];
    const patch = await api("PATCH", `/transactions/${triggerId}`, {
      categoryId: debtCat!.id,
    });
    expect(patch.status).toBe(200);
    const patchBody = patch.json as {
      id: string;
      categoryId: string;
      repointedRules: {
        ruleId: string;
        pattern: string;
        matchType: string;
        fromCategoryId: string;
        toCategoryId: string;
        candidateCount: number;
      }[];
      ruleAction: { kind: string; pattern: string | null };
    };
    expect(patchBody.categoryId).toBe(debtCat!.id);
    expect(patchBody.repointedRules.length).toBe(1);
    // Task #185 — when an existing specific rule is repointed (no new
    // rule created), ruleAction.kind is "repointed" and pattern echoes
    // the rule's pattern so the client can show "Updated your '...' rule
    // to point here." alongside the existing "apply to past" prompt.
    expect(patchBody.ruleAction.kind).toBe("repointed");
    expect(patchBody.ruleAction.pattern).toBe(seedPattern);
    const reported = patchBody.repointedRules[0]!;
    expect(reported.ruleId).toBe(seedRule!.id);
    expect(reported.pattern).toBe(seedPattern);
    expect(reported.matchType).toBe("contains");
    expect(reported.fromCategoryId).toBe(miscCat!.id);
    expect(reported.toCategoryId).toBe(debtCat!.id);
    expect(reported.candidateCount).toBe(2);

    // POST the bulk re-categorize and verify only the 2 remaining
    // Misc/Buffer rows flipped onto debtCat.
    const bulk = await api("POST", `/transactions/recategorize-by-pattern`, {
      pattern: reported.pattern,
      matchType: reported.matchType,
      fromCategoryId: reported.fromCategoryId,
      toCategoryId: reported.toCategoryId,
    });
    expect(bulk.status).toBe(200);
    const bulkBody = bulk.json as {
      updated: number;
      affectedMonths: string[];
      affectedIds: string[];
    };
    expect(bulkBody.updated).toBe(2);
    expect(bulkBody.affectedMonths).toEqual([currentMonthStart()]);
    // The flipped ids are exactly the two remaining Misc rows (the
    // trigger row was already on debtCat before this call).
    expect(new Set(bulkBody.affectedIds)).toEqual(
      new Set(olderIds.slice(1)),
    );

    // The two historical Misc rows are now on debtCat.
    const finalRows = await db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, TEST_USER),
          inArray(transactionsTable.id, [
            ...olderIds,
            manualOther!.id,
            uncatRow!.id,
          ]),
        ),
      );
    const byId = new Map(finalRows.map((r) => [r.id, r]));
    for (const id of olderIds) {
      expect(byId.get(id)!.categoryId).toBe(debtCat!.id);
    }
    // Manual edits and uncategorized rows are preserved.
    expect(byId.get(manualOther!.id)!.categoryId).toBe(otherCat!.id);
    expect(byId.get(uncatRow!.id)!.categoryId).toBeNull();

    // A re-fired bulk on the same pattern is now idempotent — nothing in
    // fromCategoryId still matches.
    const replay = await api("POST", `/transactions/recategorize-by-pattern`, {
      pattern: reported.pattern,
      matchType: reported.matchType,
      fromCategoryId: reported.fromCategoryId,
      toCategoryId: reported.toCategoryId,
    });
    const replayBody = replay.json as { updated: number };
    expect(replayBody.updated).toBe(0);

    // Undo flow — re-run the same endpoint with from/to swapped and
    // scoped to the affectedIds. Should move exactly those two rows
    // back to miscCat. Then simulate the user editing one of those
    // reverted rows to a different category before clicking Undo a
    // second time — the second Undo must skip that re-edited row.
    const undo = await api("POST", `/transactions/recategorize-by-pattern`, {
      pattern: reported.pattern,
      matchType: reported.matchType,
      fromCategoryId: reported.toCategoryId,
      toCategoryId: reported.fromCategoryId,
      ids: bulkBody.affectedIds,
    });
    expect(undo.status).toBe(200);
    const undoBody = undo.json as {
      updated: number;
      affectedIds: string[];
    };
    expect(undoBody.updated).toBe(2);
    expect(new Set(undoBody.affectedIds)).toEqual(
      new Set(bulkBody.affectedIds),
    );
    const afterUndoRows = await db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, TEST_USER),
          inArray(transactionsTable.id, olderIds),
        ),
      );
    const afterUndoById = new Map(
      afterUndoRows.map((r) => [r.id, r]),
    );
    // The trigger row stays on debtCat (it wasn't in affectedIds); the
    // two formerly-bulk-flipped rows are back on miscCat.
    expect(afterUndoById.get(triggerId!)!.categoryId).toBe(debtCat!.id);
    for (const id of olderIds.slice(1)) {
      expect(afterUndoById.get(id)!.categoryId).toBe(miscCat!.id);
    }

    // Now redo the bulk again, then have the user manually move one of
    // the two flipped rows to `otherCat`. A subsequent Undo (again
    // scoped to the original affectedIds) should leave the manually
    // re-edited row alone and only revert the untouched one.
    const redo = await api("POST", `/transactions/recategorize-by-pattern`, {
      pattern: reported.pattern,
      matchType: reported.matchType,
      fromCategoryId: reported.fromCategoryId,
      toCategoryId: reported.toCategoryId,
    });
    const redoBody = redo.json as {
      updated: number;
      affectedIds: string[];
    };
    expect(redoBody.updated).toBe(2);
    const userEditedId = redoBody.affectedIds[0]!;
    const stillOnDebtId = redoBody.affectedIds[1]!;
    await db
      .update(transactionsTable)
      .set({ categoryId: otherCat!.id })
      .where(eq(transactionsTable.id, userEditedId));
    const undo2 = await api("POST", `/transactions/recategorize-by-pattern`, {
      pattern: reported.pattern,
      matchType: reported.matchType,
      fromCategoryId: reported.toCategoryId,
      toCategoryId: reported.fromCategoryId,
      ids: redoBody.affectedIds,
    });
    const undo2Body = undo2.json as {
      updated: number;
      affectedIds: string[];
    };
    expect(undo2Body.updated).toBe(1);
    expect(undo2Body.affectedIds).toEqual([stillOnDebtId]);
    const finalAfterPartialUndo = await db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, TEST_USER),
          inArray(transactionsTable.id, [userEditedId, stillOnDebtId]),
        ),
      );
    const finalById = new Map(
      finalAfterPartialUndo.map((r) => [r.id, r]),
    );
    expect(finalById.get(userEditedId)!.categoryId).toBe(otherCat!.id);
    expect(finalById.get(stillOnDebtId)!.categoryId).toBe(miscCat!.id);

    // Defensive: an explicit empty `ids` array must be treated as a
    // no-op. Otherwise a degenerate Undo payload (no rows to revert)
    // would silently re-flip every pattern match in the category.
    const noopRow = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.id, stillOnDebtId))
      .limit(1);
    const noopBefore = noopRow[0]!.categoryId;
    const noop = await api("POST", `/transactions/recategorize-by-pattern`, {
      pattern: reported.pattern,
      matchType: reported.matchType,
      fromCategoryId: reported.fromCategoryId,
      toCategoryId: reported.toCategoryId,
      ids: [],
    });
    const noopBody = noop.json as {
      updated: number;
      affectedIds: string[];
      affectedMonths: string[];
    };
    expect(noopBody.updated).toBe(0);
    expect(noopBody.affectedIds).toEqual([]);
    expect(noopBody.affectedMonths).toEqual([]);
    const noopAfterRow = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.id, stillOnDebtId))
      .limit(1);
    expect(noopAfterRow[0]!.categoryId).toBe(noopBefore);
  });

  it("PATCH /transactions/:id auto-relearns: repoints an existing matching rule onto the new category instead of creating a duplicate", async () => {
    // Simulate the seed state: a debt-payment mapping rule pre-pointed at
    // "Misc / Buffer" because the per-debt category didn't exist yet at
    // seed time. The first time the user manually picks the real debt
    // category for a payment txn, that rule should snap onto it (and we
    // shouldn't duplicate the rule with an auto-derived shorter pattern).
    const [miscCat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        name: `Misc Buffer ${randomUUID().slice(0, 6)}`,
        kind: "expense",
        groupName: "Other",
        sourceKind: "manual",
      })
      .returning();
    const [debtCat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        name: `Amex Delta SkyMiles ${randomUUID().slice(0, 6)}`,
        kind: "expense",
        groupName: "Debt",
        sourceKind: "manual",
      })
      .returning();

    // Real debt seed patterns ("AMERICAN EXPRESS ACH", "AMEX EPAYMENT",
    // "DISCOVER E-PAYMENT", ...) are all ≥ 2 whitespace-separated tokens,
    // which is what `isPatternSpecific` keys on to decide whether silent
    // auto-repoint is safe. Use a 2-token random seed pattern here so the
    // test mirrors a realistic seed shape.
    const seedPattern = `SEEDPMT ACH-${randomUUID().slice(0, 6).toUpperCase()}`;
    await db.insert(mappingRulesTable).values({
      userId: TEST_USER,
      pattern: seedPattern,
      matchType: "contains",
      categoryId: miscCat!.id,
      priority: 50,
    });

    const [txn] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        occurredOn: dateInCurrentMonth(25),
        description: `${seedPattern} PMT XXXX5234`,
        amount: "-200.00",
        source: "bank",
      })
      .returning();

    const patch = await api("PATCH", `/transactions/${txn!.id}`, {
      categoryId: debtCat!.id,
    });
    expect(patch.status).toBe(200);
    // Task #185 — auto-relearn repoint produces ruleAction.kind="repointed"
    // so the client can confirm the existing rule was reused.
    const patchBody = patch.json as {
      ruleAction: { kind: string; pattern: string | null };
    };
    expect(patchBody.ruleAction.kind).toBe("repointed");
    expect(patchBody.ruleAction.pattern).toBe(seedPattern);

    // The seed rule's pattern is unchanged; only its categoryId moved.
    // Priority is preserved (still 50, not bumped to 100).
    const seedRules = await db
      .select()
      .from(mappingRulesTable)
      .where(
        and(
          eq(mappingRulesTable.userId, TEST_USER),
          eq(mappingRulesTable.pattern, seedPattern),
        ),
      );
    expect(seedRules.length).toBe(1);
    expect(seedRules[0]!.categoryId).toBe(debtCat!.id);
    expect(seedRules[0]!.priority).toBe(50);

    // No duplicate auto-derived rule was created (e.g. a "SEEDPMT-XXXX PMT"
    // shortened pattern). The repoint is sufficient.
    const debtRules = await db
      .select()
      .from(mappingRulesTable)
      .where(
        and(
          eq(mappingRulesTable.userId, TEST_USER),
          eq(mappingRulesTable.categoryId, debtCat!.id),
        ),
      );
    expect(debtRules.length).toBe(1);
    expect(debtRules[0]!.pattern).toBe(seedPattern);

    // A future transaction with a similar description now auto-categorizes
    // to the debt category, not Misc / Buffer.
    const ruleRows = await loadUserRules(TEST_USER);
    const result = categorize(
      { description: `${seedPattern} PMT XXXX9999` },
      ruleRows,
    );
    expect(result.categoryId).toBe(debtCat!.id);
  });

  it("PATCH /transactions/:id keeps a generic 1-token rule independent when categorizing a more-specific charge (AMAZON vs AMAZON FRESH)", async () => {
    // Setup: the user previously authored a broad "AMAZON" → Shopping rule.
    // Today they manually pick Groceries for an "AMAZON FRESH 123" charge.
    // The original AMAZON rule must NOT silently re-aim at Groceries — that
    // would break general Amazon-as-shopping behavior across all of their
    // existing and future Amazon charges. Both rules should remain
    // independent, with the more-specific rule winning on future similar
    // charges.
    const [shoppingCat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        name: `Shopping ${randomUUID().slice(0, 6)}`,
        kind: "expense",
        groupName: "Other",
        sourceKind: "manual",
      })
      .returning();
    const [groceriesCat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        name: `Groceries ${randomUUID().slice(0, 6)}`,
        kind: "expense",
        groupName: "Other",
        sourceKind: "manual",
      })
      .returning();

    // Use a unique 1-token "merchant" tag so this test doesn't collide with
    // any other rules created earlier in this file's shared TEST_USER.
    const merchantTag = `AMZN${randomUUID().slice(0, 6).toUpperCase()}`;
    await db.insert(mappingRulesTable).values({
      userId: TEST_USER,
      pattern: merchantTag,
      matchType: "contains",
      categoryId: shoppingCat!.id,
      priority: 100,
    });

    const [txn] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        occurredOn: dateInCurrentMonth(26),
        description: `${merchantTag} FRESH 123`,
        amount: "-45.67",
        source: "bank",
      })
      .returning();

    const patch = await api("PATCH", `/transactions/${txn!.id}`, {
      categoryId: groceriesCat!.id,
    });
    expect(patch.status).toBe(200);
    // Task #185 — a new specific rule is created with priority above
    // the existing generic rule. ruleAction is "created_priority_bump"
    // and includes both patterns so the client can show
    // "Future 'X FRESH' charges will auto-categorize here. Your 'X'
    // rule is unchanged."
    const patchBody = patch.json as {
      ruleAction: {
        kind: string;
        pattern: string | null;
        genericPattern: string | null;
      };
    };
    expect(patchBody.ruleAction.kind).toBe("created_priority_bump");
    expect(patchBody.ruleAction.pattern).toBe(`${merchantTag} FRESH`);
    expect(patchBody.ruleAction.genericPattern).toBe(merchantTag);

    // The broad rule still routes to Shopping, untouched.
    const merchantRules = await db
      .select()
      .from(mappingRulesTable)
      .where(
        and(
          eq(mappingRulesTable.userId, TEST_USER),
          eq(mappingRulesTable.pattern, merchantTag),
        ),
      );
    expect(merchantRules.length).toBe(1);
    expect(merchantRules[0]!.categoryId).toBe(shoppingCat!.id);

    // A new, more-specific "MERCHANTTAG FRESH" rule was created for
    // Groceries — derived from the description's first two tokens.
    const groceryRules = await db
      .select()
      .from(mappingRulesTable)
      .where(
        and(
          eq(mappingRulesTable.userId, TEST_USER),
          eq(mappingRulesTable.categoryId, groceriesCat!.id),
        ),
      );
    expect(groceryRules.length).toBe(1);
    expect(groceryRules[0]!.pattern).toBe(`${merchantTag} FRESH`);
    expect(groceryRules[0]!.matchType).toBe("contains");
    // Priority must outrank the existing matching generic rule so future
    // "...FRESH..." charges land in Groceries instead of Shopping.
    expect(groceryRules[0]!.priority).toBeGreaterThan(
      merchantRules[0]!.priority,
    );

    // End-to-end: a future "MERCHANTTAG FRESH ..." charge auto-categorizes
    // to Groceries (specific rule wins on priority), while a generic
    // "MERCHANTTAG ..." charge still routes to Shopping.
    const ruleRows = await loadUserRules(TEST_USER);
    const freshResult = categorize(
      { description: `${merchantTag} FRESH ANOTHER STORE` },
      ruleRows,
    );
    expect(freshResult.categoryId).toBe(groceriesCat!.id);
    const genericResult = categorize(
      { description: `${merchantTag} BOOKS DEPARTMENT` },
      ruleRows,
    );
    expect(genericResult.categoryId).toBe(shoppingCat!.id);
  });

  it("PATCH /transactions/:id does not silently overwrite a generic rule via the auto-derive upsert path", async () => {
    // Sibling case to the AMAZON-FRESH test above: when the auto-derived
    // pattern would *equal* an existing generic 1-token rule (e.g. txn
    // description is just "AMAZON" with no extra tokens), the upsert path
    // would otherwise clobber the generic rule's categoryId — the same
    // bug, just via the back door. Verify the clobber guard catches it.
    const [shoppingCat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        name: `Shopping2 ${randomUUID().slice(0, 6)}`,
        kind: "expense",
        groupName: "Other",
        sourceKind: "manual",
      })
      .returning();
    const [otherCat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        name: `Other2 ${randomUUID().slice(0, 6)}`,
        kind: "expense",
        groupName: "Other",
        sourceKind: "manual",
      })
      .returning();

    const merchantTag = `SOLO${randomUUID().slice(0, 6).toUpperCase()}`;
    await db.insert(mappingRulesTable).values({
      userId: TEST_USER,
      pattern: merchantTag,
      matchType: "contains",
      categoryId: shoppingCat!.id,
      priority: 100,
    });

    const [txn] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        occurredOn: dateInCurrentMonth(27),
        description: merchantTag,
        amount: "-7.89",
        source: "bank",
      })
      .returning();

    const patch = await api("PATCH", `/transactions/${txn!.id}`, {
      categoryId: otherCat!.id,
    });
    expect(patch.status).toBe(200);
    // Task #185 — clobber-guard fires; ruleAction tells the client the
    // generic rule was deliberately preserved so the toast can say
    // "Your 'X' rule already routes 'X' — edit it to change that."
    const patchBody = patch.json as {
      ruleAction: {
        kind: string;
        pattern: string | null;
        genericPattern: string | null;
      };
    };
    expect(patchBody.ruleAction.kind).toBe("skipped_generic");
    expect(patchBody.ruleAction.pattern).toBe(merchantTag);
    expect(patchBody.ruleAction.genericPattern).toBe(merchantTag);

    // The generic rule is unchanged.
    const rules = await db
      .select()
      .from(mappingRulesTable)
      .where(
        and(
          eq(mappingRulesTable.userId, TEST_USER),
          eq(mappingRulesTable.pattern, merchantTag),
        ),
      );
    expect(rules.length).toBe(1);
    expect(rules[0]!.categoryId).toBe(shoppingCat!.id);
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
    // Task #185 — transfers skip the auto-learn flow entirely, so
    // ruleAction is "none" and the client suppresses the rule-status
    // toast description.
    const patchBody = patch.json as {
      ruleAction: { kind: string; pattern: string | null };
    };
    expect(patchBody.ruleAction.kind).toBe("none");
    expect(patchBody.ruleAction.pattern).toBeNull();

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
