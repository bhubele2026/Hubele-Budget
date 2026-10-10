// PR-0 · Workbook import and transactions.category_locked_by_user.
//
// A Payments row whose Target column names a category was filed by a person
// in the spreadsheet: it is imported locked. A row the importer files by the
// Mapping rules is not. On a re-import, a preserved manual override keeps the
// lock its prior row had.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import * as XLSX from "xlsx";
import {
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  db,
  importBatchesTable,
  importSnapshotsTable,
  mappingRulesTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import { importWorkbook } from "../lib/workbookImporter";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `wblock-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

async function deleteAllForUser(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(budgetLinesTable).where(eq(budgetLinesTable.userId, TEST_USER));
  await db.delete(budgetMonthsTable).where(eq(budgetMonthsTable.userId, TEST_USER));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, TEST_USER));
  await db.delete(mappingRulesTable).where(eq(mappingRulesTable.userId, TEST_USER));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db.delete(importSnapshotsTable).where(eq(importSnapshotsTable.userId, TEST_USER));
  await db.delete(importBatchesTable).where(eq(importBatchesTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await deleteAllForUser();
});

afterAll(deleteAllForUser);

function buildWorkbook(): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const pad = (n: number, label: string): unknown[][] => Array.from({ length: n }, () => [label]);
  const add = (rows: unknown[][], name: string) =>
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  add(pad(4, "DT"), "Debt Tracker");
  add(
    [...pad(5, "MB"), [1, "Coffee", 50, null, null, null, null], [2, "Household", 100, null, null, null, null]],
    "Monthly Budget",
  );
  add(pad(5, "RI"), "Recurring Items");
  add([...pad(4, "MAP"), ["CAFE", "Coffee"]], "Mapping");
  add(
    [
      ...pad(5, "PAY"),
      // Target names the category → filed by a person.
      [null, "2026-03-04", "HARDWARE STORE 12", "Expense", "Household", 20, null, null],
      // Target empty, a Mapping rule matches → filed by rule.
      [null, "2026-03-05", "CAFE CORNER 7", "Expense", null, 4.5, null, null],
      // Target empty, no rule → uncategorized.
      [null, "2026-03-06", "UNMATCHED THING", "Expense", null, 9, null, null],
      // (WP5d) A CREDIT the Mapping rule files: money back on the card, so the
      // direction guard leaves it with its purchase category.
      [null, "2026-03-07", "CAFE CORNER 7 REVERSAL", "Credit", null, 4.5, null, null],
    ],
    "Payments",
  );
  return wb;
}

async function runImport(): Promise<void> {
  const [batch] = await db
    .insert(importBatchesTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, filename: "lock.xlsx" })
    .returning();
  await importWorkbook(TEST_USER, TEST_HOUSEHOLD_ID, buildWorkbook(), batch!.id);
}

async function rows(): Promise<Map<string, { categoryId: string | null; locked: boolean }>> {
  const all = await db
    .select({
      description: transactionsTable.description,
      categoryId: transactionsTable.categoryId,
      locked: transactionsTable.categoryLockedByUser,
    })
    .from(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  return new Map(all.map((r) => [r.description, { categoryId: r.categoryId, locked: r.locked }]));
}

describe("workbook import and the category lock", () => {
  it("locks Target-named rows only; rule-filed and uncategorized rows stay unlocked", async () => {
    await runImport();
    const r = await rows();
    expect(r.get("HARDWARE STORE 12")!.categoryId).not.toBeNull();
    expect(r.get("HARDWARE STORE 12")!.locked).toBe(true);
    expect(r.get("CAFE CORNER 7")!.categoryId).not.toBeNull();
    expect(r.get("CAFE CORNER 7")!.locked).toBe(false);
    expect(r.get("UNMATCHED THING")).toEqual({ categoryId: null, locked: false });
    // (WP5d) The card's credit is filed by the rule like its purchase, unlocked.
    expect(r.get("CAFE CORNER 7 REVERSAL")).toEqual({ categoryId: r.get("CAFE CORNER 7")!.categoryId, locked: false });
  });

  it("a re-import keeps a preserved override's lock", async () => {
    // A person re-files the rule-filed row by hand between imports.
    const before = await rows();
    const ruleCat = before.get("CAFE CORNER 7")!.categoryId;
    const cats = await db
      .select({ id: budgetCategoriesTable.id, name: budgetCategoriesTable.name })
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.userId, TEST_USER));
    const other = cats.find((c) => c.id !== ruleCat)!;
    const otherName = other.name;
    await db
      .update(transactionsTable)
      .set({ categoryId: other.id, categoryLockedByUser: true })
      .where(
        and(
          eq(transactionsTable.userId, TEST_USER),
          eq(transactionsTable.description, "CAFE CORNER 7"),
        ),
      );

    await runImport();
    const r = await rows();
    expect(r.get("CAFE CORNER 7")!.locked).toBe(true);
    // The person's pick survived (category ids are re-minted by an import, so
    // compare by name).
    const [cat] = await db
      .select({ name: budgetCategoriesTable.name })
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.id, r.get("CAFE CORNER 7")!.categoryId!));
    expect(cat!.name).toBe(otherName);
    expect(r.get("HARDWARE STORE 12")!.locked).toBe(true);
    expect(r.get("UNMATCHED THING")!.locked).toBe(false);
  });
});
