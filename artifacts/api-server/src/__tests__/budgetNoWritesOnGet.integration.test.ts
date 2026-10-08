// (PR-E) A GET WRITES NOTHING.
//
// `GET /budget/months/:monthStart` and `GET /budget/categories` used to run the
// seed, the category migration, the system-category ensures, the auto_debts /
// auto_bills / Avalanche-payment syncs and the carry-forward inserts on the way
// to answering. They no longer do: those run from the budget and debt WRITE
// routes and from the nightly job (`prepareBudgetMonth`). This file proves
//   - two consecutive GETs change no row, from a state no pass has ever touched;
//   - the month response of an already-synced household is the same with or
//     without a sync having just run (so removing the sync from the GET moved no
//     figure), and a carried-forward line is still shown (in memory);
//   - the writes the GET used to do now happen on the debt write paths, the
//     nightly run and the first budget write — and a never-seeded household is
//     seeded by that first write, not by a read.
//
// Synthetic data only.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";

const OWNER = `pre-get-${process.pid}-${randomUUID().slice(0, 8)}`;
let HH = "";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = OWNER;
    req.actualUserId = OWNER;
    req.householdId = HH;
    req.householdOwnerId = OWNER;
    next();
  },
}));

import {
  db,
  pool,
  avalancheSettingsTable,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  debtsTable,
  recurringItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import budgetRouter, { _resetBudgetOneTimePassGatesForTests, prepareBudgetMonth } from "../routes/budget";
import debtsRouter from "../routes/debts";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";
import { runMetricsSnapshot } from "../jobs/handlers/metricsSnapshot";
import { householdTodayISO } from "../lib/householdClock";

const routes = express.Router();
routes.use(budgetRouter);
routes.use(debtsRouter);
const { request } = createTestApp(routes);

const TODAY = householdTodayISO();
const THIS_MONTH = `${TODAY.slice(0, 7)}-01`;
const PRIOR_MONTH = "2026-08-01";
const MONTH = "2026-09-01";

const TABLES: Array<[string, string]> = [
  ["budget_categories", "household_id"],
  ["budget_lines", "household_id"],
  ["budget_months", "household_id"],
  ["transactions", "household_id"],
  ["recurring_items", "household_id"],
  ["debts", "household_id"],
  ["avalanche_settings", "household_id"],
  ["settings", "user_id"],
];

/** Row count and a content hash per table, so an UPDATE shows as well as an INSERT/DELETE. */
async function fingerprint(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [table, col] of TABLES) {
    const key = col === "user_id" ? OWNER : HH;
    const { rows } = await pool.query(
      `select count(*)::int as n, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h from ${table} t where ${col} = $1`,
      [key],
    );
    out[table] = `${rows[0].n}:${rows[0].h}`;
  }
  return out;
}

async function wipe(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.householdId, HH));
  await db.delete(budgetLinesTable).where(eq(budgetLinesTable.householdId, HH));
  await db.delete(budgetMonthsTable).where(eq(budgetMonthsTable.householdId, HH));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.householdId, HH));
  await db.delete(debtsTable).where(eq(debtsTable.householdId, HH));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.householdId, HH));
  await db.delete(avalancheSettingsTable).where(eq(avalancheSettingsTable.householdId, HH));
  await db.delete(settingsTable).where(eq(settingsTable.userId, OWNER));
}

async function autoDebtCats() {
  return db
    .select()
    .from(budgetCategoriesTable)
    .where(and(eq(budgetCategoriesTable.householdId, HH), eq(budgetCategoriesTable.sourceKind, "auto_debts")));
}

/** A household with every kind of row the old GET used to write for. */
async function seedHousehold(): Promise<{ manualCategoryId: string; debtId: string }> {
  await db.insert(settingsTable).values({ userId: OWNER, householdId: HH, preferences: { defaultsSeededAt: "2026-01-01T00:00:00.000Z" } }).onConflictDoNothing();
  const [manual] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: OWNER, householdId: HH, name: "Birthday gifts", kind: "expense", groupName: "My budget", sourceKind: "manual", sortOrder: 5 })
    .returning();
  await db.insert(budgetMonthsTable).values({ userId: OWNER, householdId: HH, monthStart: PRIOR_MONTH });
  await db.insert(budgetLinesTable).values({ userId: OWNER, householdId: HH, monthStart: PRIOR_MONTH, categoryId: manual!.id, plannedAmount: "42.00", note: "carried" });
  const [debt] = await db
    .insert(debtsTable)
    .values({ userId: OWNER, householdId: HH, name: "Visa", balance: "900.00", originalBalance: "1500.00", apr: "0.2", minPayment: "35.00", type: "credit_card" })
    .returning();
  await db.insert(recurringItemsTable).values({
    userId: OWNER,
    householdId: HH,
    name: "Paycheck",
    amount: "2000.00",
    kind: "income",
    frequency: "monthly",
    dayOfMonth: 1,
    active: "true",
  } as typeof recurringItemsTable.$inferInsert);
  await db.insert(avalancheSettingsTable).values({ userId: OWNER, householdId: HH, manualExtra: "75.00" });
  return { manualCategoryId: manual!.id, debtId: debt!.id };
}

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
  await wipe();
});

beforeEach(async () => {
  _resetBudgetOneTimePassGatesForTests();
  await wipe();
});

afterAll(async () => {
  await wipe();
});

describe("a GET writes nothing", () => {
  it("two consecutive GETs of the month and the category list change no row, from an untouched state", async () => {
    await seedHousehold();
    const before = await fingerprint();
    for (let i = 0; i < 2; i++) {
      expect((await request("GET", `/budget/months/${MONTH}`)).status).toBe(200);
      expect((await request("GET", `/budget/months/${THIS_MONTH}`)).status).toBe(200);
      expect((await request("GET", "/budget/categories")).status).toBe(200);
      expect(await fingerprint()).toEqual(before);
    }
    expect(await autoDebtCats()).toHaveLength(0);
  });

  it("a household nobody has ever touched is not seeded by a read", async () => {
    const before = await fingerprint();
    const { status, json } = await request("GET", "/budget/categories");
    expect(status).toBe(200);
    expect(json).toEqual([]);
    expect((await request("GET", `/budget/months/${MONTH}`)).status).toBe(200);
    expect(await fingerprint()).toEqual(before);
  });
});

describe("the month response does not move", () => {
  it("is identical with or without a sync having just run, for an already-synced household", async () => {
    await seedHousehold();
    await prepareBudgetMonth(HH, OWNER, OWNER, MONTH); // the write-path sync
    const synced = await request("GET", `/budget/months/${MONTH}`);
    expect(synced.status).toBe(200);
    // The sync again (what the old GET did on every read) changes no figure.
    await prepareBudgetMonth(HH, OWNER, OWNER, MONTH);
    const again = await request("GET", `/budget/months/${MONTH}`);
    expect(again.json).toEqual(synced.json);
    // The debt line is there, at the debt's minimum.
    const lines = (synced.json as { lines: Array<{ categoryName: string; plannedAmount: string }> }).lines;
    expect(JSON.stringify(lines)).toContain("Visa");
    expect(JSON.stringify(synced.json)).toContain("35.00");
  });

  it("shows a carried-forward line in memory: same planned amount, no row written", async () => {
    const { manualCategoryId } = await seedHousehold();
    const read = await request("GET", `/budget/months/${MONTH}`);
    const line = (read.json as { lines: Array<{ categoryId: string; plannedAmount: string; id: string | null }> }).lines.find(
      (l) => l.categoryId === manualCategoryId,
    );
    expect(line, "the manual category is on the month").toBeTruthy();
    expect(line!.plannedAmount).toBe("42.00");
    expect(line!.id).toBeNull();
    const stored = await db.select().from(budgetLinesTable).where(and(eq(budgetLinesTable.householdId, HH), eq(budgetLinesTable.monthStart, MONTH)));
    expect(stored).toHaveLength(0);
    // The write-path sync stores it; the response is unchanged but for the id.
    await prepareBudgetMonth(HH, OWNER, OWNER, MONTH);
    const after = await request("GET", `/budget/months/${MONTH}`);
    const line2 = (after.json as { lines: Array<{ categoryId: string; plannedAmount: string; id: string | null }> }).lines.find(
      (l) => l.categoryId === manualCategoryId,
    );
    expect(line2!.plannedAmount).toBe("42.00");
    expect(line2!.id).not.toBeNull();
  });
});

describe("the writes moved", () => {
  it("POST, PATCH and DELETE /debts keep the auto_debts categories current, with no GET in between", async () => {
    await seedHousehold();
    const create = await request("POST", "/debts", { name: "Store card", balance: "300.00", apr: "0.25", minPayment: "20.00", type: "credit_card" });
    expect(create.status).toBe(201);
    const id = (create.json as { id: string }).id;
    let cats = await autoDebtCats();
    expect(cats.map((c) => c.name).sort()).toEqual(["Store card", "Visa"]);
    const line = await db
      .select()
      .from(budgetLinesTable)
      .where(and(eq(budgetLinesTable.householdId, HH), eq(budgetLinesTable.monthStart, THIS_MONTH), eq(budgetLinesTable.categoryId, cats.find((c) => c.name === "Store card")!.id)));
    expect(line[0]!.plannedAmount).toBe("20.00");

    expect((await request("PATCH", `/debts/${id}`, { name: "Store card plus" })).status).toBe(200);
    cats = await autoDebtCats();
    expect(cats.map((c) => c.name).sort()).toEqual(["Store card plus", "Visa"]);

    expect((await request("DELETE", `/debts/${id}`)).status).toBe(204);
    cats = await autoDebtCats();
    expect(cats.map((c) => c.name)).toEqual(["Visa"]);
  });

  it("the nightly run gives a household whose debt categories were never synced its categories and this month's lines", async () => {
    const { debtId } = await seedHousehold();
    expect(await autoDebtCats()).toHaveLength(0);
    await runMetricsSnapshot(HH, OWNER);
    const cats = await autoDebtCats();
    expect(cats).toHaveLength(1);
    expect(cats[0]!.debtId).toBe(debtId);
    const [line] = await db
      .select()
      .from(budgetLinesTable)
      .where(and(eq(budgetLinesTable.householdId, HH), eq(budgetLinesTable.categoryId, cats[0]!.id), eq(budgetLinesTable.monthStart, THIS_MONTH)));
    expect(line!.plannedAmount).toBe("35.00");
    // Run twice: still one category, one line.
    await runMetricsSnapshot(HH, OWNER);
    expect(await autoDebtCats()).toHaveLength(1);
  });

  it("the nightly run does not seed a never-seeded household", async () => {
    await runMetricsSnapshot(HH, OWNER);
    const names = (await db.select({ n: budgetCategoriesTable.name }).from(budgetCategoriesTable).where(eq(budgetCategoriesTable.householdId, HH))).map((r) => r.n).sort();
    // The system rows the month pass has always ensured; none of the ~50 seed categories.
    expect(names).toEqual(["Avalanche payment", "Ignore", "Transfer", "Uncategorized"]);
    const [{ n }] = (await pool.query(`select count(*)::int as n from recurring_items where household_id = $1`, [HH])).rows;
    expect(n).toBe(0);
  });

  it("the first budget write seeds a never-seeded household; a read before it did not", async () => {
    expect(((await request("GET", "/budget/categories")).json as unknown[]).length).toBe(0);
    const made = await request("POST", "/budget/categories", { name: "Pet fund", groupName: "My budget" });
    expect(made.status).toBeLessThan(300);
    const list = (await request("GET", "/budget/categories")).json as Array<{ name: string }>;
    expect(list.length).toBeGreaterThan(10); // the default seed is there
    expect(list.map((c) => c.name)).toContain("Pet fund");
    // And it is once: a second write does not seed again.
    const n = list.length;
    await request("POST", "/budget/categories", { name: "Pet fund 2", groupName: "My budget" });
    expect(((await request("GET", "/budget/categories")).json as unknown[]).length).toBe(n + 1);
  });
});
