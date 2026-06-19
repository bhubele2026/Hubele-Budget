import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as XLSX from "xlsx";

import {
  db,
  importBatchesTable,
  importSnapshotsTable,
  transactionsTable,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  recurringItemsTable,
  mappingRulesTable,
  monthlySnapshotsTable,
  debtsTable,
} from "@workspace/db";
import { importWorkbook } from "../lib/workbookImporter";
import { restoreImportSnapshot } from "../lib/importSnapshot";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

function dateInCurrentMonth(day: number): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Build a minimal valid workbook. `cats` drives the Monthly Budget + Mapping +
// Payments rows so importA and importB produce distinguishable data.
function buildWorkbook(opts: {
  category: string;
  planned: number;
  pattern: string;
  payDesc: string;
  payAmount: number;
}): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const pad = (n: number, label: string): unknown[][] =>
    Array.from({ length: n }, () => [label]);

  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ...pad(4, "DT"),
      [null, "Visa", "Card", 24.99, 1000, 35],
    ]),
    "Debt Tracker",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ...pad(5, "MB"),
      [1, opts.category, opts.planned, null, null, null, null],
    ]),
    "Monthly Budget",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ...pad(5, "RI"),
      [null, "Netflix", "Expense", 15.99, "monthly", 14, null, "Yes"],
    ]),
    "Recurring Items",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([...pad(4, "MAP"), [opts.pattern, opts.category]]),
    "Mapping",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ...pad(5, "PAY"),
      [null, dateInCurrentMonth(6), opts.payDesc, "Expense", null, opts.payAmount, null, null],
    ]),
    "Payments",
  );
  return wb;
}

async function snapshotState() {
  const where = eq(transactionsTable.userId, TEST_USER);
  const txns = await db.select().from(transactionsTable).where(where);
  const cats = await db
    .select()
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, TEST_USER));
  const lines = await db
    .select()
    .from(budgetLinesTable)
    .where(eq(budgetLinesTable.userId, TEST_USER));
  const debts = await db
    .select()
    .from(debtsTable)
    .where(eq(debtsTable.userId, TEST_USER));
  const recurring = await db
    .select()
    .from(recurringItemsTable)
    .where(eq(recurringItemsTable.userId, TEST_USER));
  const rules = await db
    .select()
    .from(mappingRulesTable)
    .where(eq(mappingRulesTable.userId, TEST_USER));
  return {
    txns: txns
      .map((t) => `${t.occurredOn}|${t.description}|${t.amount}`)
      .sort(),
    cats: cats.map((c) => c.name).sort(),
    lines: lines.map((l) => l.plannedAmount).sort(),
    debts: debts.map((d) => `${d.name}|${d.balance}`).sort(),
    recurring: recurring.map((r) => `${r.name}|${r.amount}`).sort(),
    rules: rules.map((r) => r.pattern).sort(),
  };
}

async function cleanup() {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(budgetLinesTable).where(eq(budgetLinesTable.userId, TEST_USER));
  await db.delete(budgetMonthsTable).where(eq(budgetMonthsTable.userId, TEST_USER));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, TEST_USER));
  await db.delete(mappingRulesTable).where(eq(mappingRulesTable.userId, TEST_USER));
  await db.delete(monthlySnapshotsTable).where(eq(monthlySnapshotsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db.delete(importSnapshotsTable).where(eq(importSnapshotsTable.userId, TEST_USER));
  await db.delete(importBatchesTable).where(eq(importBatchesTable.userId, TEST_USER));
}

async function runImport(wb: XLSX.WorkBook, filename: string) {
  const [batch] = await db
    .insert(importBatchesTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, filename })
    .returning();
  return importWorkbook(TEST_USER, TEST_HOUSEHOLD_ID, wb, batch!.id, { filename });
}

beforeAll(async () => {
  const h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = h.householdId;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

describe("import snapshot → import → restore round-trip", () => {
  it("restores the exact pre-import state after a destructive re-import", async () => {
    // Import A — the data we want to be able to get back.
    const wbA = buildWorkbook({
      category: "Coffee",
      planned: 120,
      pattern: "STARBUCKS",
      payDesc: "STARBUCKS COFFEE #1",
      payAmount: 4.25,
    });
    const resA = await runImport(wbA, "import-a.xlsx");
    expect(resA.snapshotId).toBeTruthy();
    const stateA = await snapshotState();
    expect(stateA.cats).toContain("Coffee");
    expect(stateA.txns.length).toBe(1);

    // Import B — a DIFFERENT workbook. This wipes A's per-user data and seeds
    // B's, and (critically) snapshots A first.
    const wbB = buildWorkbook({
      category: "Dining",
      planned: 999,
      pattern: "CHIPOTLE",
      payDesc: "CHIPOTLE #2",
      payAmount: 11.5,
    });
    const resB = await runImport(wbB, "import-b.xlsx");
    expect(resB.snapshotId).toBeTruthy();

    const stateB = await snapshotState();
    expect(stateB.cats).toContain("Dining");
    expect(stateB.cats).not.toContain("Coffee");
    expect(stateB).not.toEqual(stateA);

    // The snapshot taken during import B must contain A's data (the pre-B state).
    const [snapRow] = await db
      .select()
      .from(importSnapshotsTable)
      .where(eq(importSnapshotsTable.id, resB.snapshotId!));
    expect(snapRow.status).toBe("available");
    expect(snapRow.filename).toBe("import-b.xlsx");
    const payload = snapRow.payload as Record<string, unknown[]>;
    expect(payload.budgetCategories.length).toBe(stateA.cats.length);
    expect(payload.transactions.length).toBe(1);

    // Restore the import-B snapshot → we should be back to exactly state A.
    const restore = await restoreImportSnapshot(resB.snapshotId!, TEST_USER);
    expect(restore.ok).toBe(true);

    const restored = await snapshotState();
    expect(restored).toEqual(stateA);
    expect(restored.cats).toContain("Coffee");
    expect(restored.cats).not.toContain("Dining");

    // The snapshot is now marked restored and cannot be replayed.
    const [snapAfter] = await db
      .select()
      .from(importSnapshotsTable)
      .where(eq(importSnapshotsTable.id, resB.snapshotId!));
    expect(snapAfter.status).toBe("restored");
    expect(snapAfter.restoredAt).not.toBeNull();

    const replay = await restoreImportSnapshot(resB.snapshotId!, TEST_USER);
    expect(replay.ok).toBe(false);
  });

  it("refuses to restore another user's snapshot (scoped by user_id)", async () => {
    const wb = buildWorkbook({
      category: "Coffee",
      planned: 50,
      pattern: "STARBUCKS",
      payDesc: "STARBUCKS #9",
      payAmount: 3.0,
    });
    const res = await runImport(wb, "scoped.xlsx");
    expect(res.snapshotId).toBeTruthy();
    const restore = await restoreImportSnapshot(res.snapshotId!, "a-different-user");
    expect(restore.ok).toBe(false);
    if (!restore.ok) {
      expect(restore.status).toBe(404);
    }
  });
});
