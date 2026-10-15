// ⭐ (Q2) THE UNDO GAPS — synthetic. Every name, amount and account is made up.
//
//   1. Undoing a category decision restored the CATEGORY only: a row filed under
//      Transfer stayed a transfer (`is_transfer`), its person's override stayed
//      on, and its weekly / monthly / unplanned flags stayed cleared. A `user`
//      decision now keeps the five flags before and after its write
//      (0220_category_decision_flags.sql) and its undo puts back each flag it
//      changed; a flag it did not change is never touched.
//   2. `POST /forecast/resolutions` deleted neighbouring answers and kept no
//      trace. The write now lives in `writeForecastResolution`, which returns
//      every row it deleted; `restoreForecastResolutions` puts them back exactly.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq, inArray } from "drizzle-orm";

const tag = `${process.pid}-${randomUUID().slice(0, 8)}`;
const U = `ug-${tag}`;
const HH: Record<string, { householdId: string; ownerUserId: string }> = {};

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    const hh = HH[U]!;
    req.userId = hh.ownerUserId;
    req.actualUserId = hh.ownerUserId;
    req.householdId = hh.householdId;
    req.householdOwnerId = hh.ownerUserId;
    next();
  },
}));

import {
  db,
  budgetCategoriesTable,
  categoryDecisionsTable,
  forecastResolutionsTable,
  merchantMemoryTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import transactionsRouter from "../routes/transactions";
import categorizationRouter from "../routes/categorization";
import forecastRouter from "../routes/forecast";
import {
  resolutionNeighbours,
  restoreForecastResolutions,
  writeForecastResolution,
} from "../lib/forecastResolutionWrite";
import { flagsToRestore } from "../lib/categorizer/review";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(transactionsRouter);
app.use(categorizationRouter);
app.use(forecastRouter);

let server: Server;
let baseUrl: string;
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

const cat: Record<string, string> = {};
const hh = () => HH[U]!.householdId;

async function cleanup(): Promise<void> {
  const hhIds = Object.values(HH).map((h) => h.householdId);
  if (hhIds.length === 0) return;
  await db.delete(categoryDecisionsTable).where(inArray(categoryDecisionsTable.householdId, hhIds));
  await db.delete(merchantMemoryTable).where(inArray(merchantMemoryTable.householdId, hhIds));
  await db.delete(forecastResolutionsTable).where(inArray(forecastResolutionsTable.householdId, hhIds));
  await db.delete(transactionsTable).where(inArray(transactionsTable.householdId, hhIds));
  await db.delete(recurringItemsTable).where(inArray(recurringItemsTable.householdId, hhIds));
  await db.delete(budgetCategoriesTable).where(inArray(budgetCategoriesTable.householdId, hhIds));
}

async function txn(over: Partial<typeof transactionsTable.$inferInsert> = {}): Promise<string> {
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: U,
      householdId: hh(),
      occurredOn: "2026-10-05",
      description: `UG SHOP ${randomUUID().slice(0, 6)}`,
      amount: "-42.00",
      source: "manual",
      ...over,
    })
    .returning({ id: transactionsTable.id });
  return t!.id;
}

const flagsOf = async (id: string) => {
  const [r] = await db
    .select({
      categoryId: transactionsTable.categoryId,
      isTransfer: transactionsTable.isTransfer,
      isTransferUserOverridden: transactionsTable.isTransferUserOverridden,
      weeklyAllowance: transactionsTable.weeklyAllowance,
      monthlyAllowance: transactionsTable.monthlyAllowance,
      unplannedAllowance: transactionsTable.unplannedAllowance,
      locked: transactionsTable.categoryLockedByUser,
    })
    .from(transactionsTable)
    .where(eq(transactionsTable.id, id));
  return r!;
};

beforeAll(async () => {
  HH[U] = await createTestHousehold(U);
  await cleanup();
  for (const [key, name] of [
    ["groceries", "Groceries"],
    ["dining", "Dining"],
    ["transfer", "Transfer"],
  ] as const) {
    const [c] = await db.insert(budgetCategoriesTable).values({ userId: U, householdId: hh(), name, kind: "expense", groupName: "UG" }).returning();
    cat[key] = c!.id;
  }
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await cleanup();
});

describe("a category decision's undo restores the flags it moved", () => {
  it("⭐ Transfer picked by hand, then undone: spending again, with its weekly flag and no person's override", async () => {
    const id = await txn({ categoryId: cat.groceries, weeklyAllowance: true });
    const before = await flagsOf(id);
    const r = await call("PATCH", `/transactions/${id}`, { categoryId: cat.transfer });
    expect(r.status).toBe(200);
    expect(await flagsOf(id)).toMatchObject({ categoryId: cat.transfer, isTransfer: true, isTransferUserOverridden: true, weeklyAllowance: false });
    const [d] = await db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.id, r.body.decisionId));
    expect(d).toMatchObject({
      flagsBefore: { isTransfer: false, isTransferUserOverridden: false, weeklyAllowance: true, monthlyAllowance: false, unplannedAllowance: false },
      flagsAfter: { isTransfer: true, isTransferUserOverridden: true, weeklyAllowance: false, monthlyAllowance: false, unplannedAllowance: false },
    });
    const u = await call("POST", `/category-decisions/${r.body.decisionId}/undo`);
    expect(u.status).toBe(200);
    expect(await flagsOf(id)).toEqual(before);
  });

  it("a flag the decision did not change, set since, stays as the person left it", async () => {
    const id = await txn({ categoryId: cat.groceries, weeklyAllowance: true });
    const r = await call("PATCH", `/transactions/${id}`, { categoryId: cat.dining });
    expect(r.status).toBe(200);
    // Later the household takes the weekly flag off.
    expect((await call("PATCH", `/transactions/${id}`, { weeklyAllowance: false })).status).toBe(200);
    expect((await call("POST", `/category-decisions/${r.body.decisionId}/undo`)).status).toBe(200);
    // The category and the override come back; the weekly flag stays off.
    expect(await flagsOf(id)).toMatchObject({ categoryId: cat.groceries, isTransfer: false, isTransferUserOverridden: false, weeklyAllowance: false });
  });

  it("a bulk Transfer flag with a category, undone, clears both; a pattern move's undo restores the override", async () => {
    const id = await txn({ categoryId: cat.groceries, monthlyAllowance: true });
    const b = await call("POST", "/transactions/bulk-update", { ids: [id], patch: { categoryId: cat.transfer, isTransfer: true, monthlyAllowance: false } });
    expect(b.status).toBe(200);
    expect((await call("POST", `/category-decisions/${b.body.decisionIds[0]}/undo`)).status).toBe(200);
    expect(await flagsOf(id)).toMatchObject({ categoryId: cat.groceries, isTransfer: false, isTransferUserOverridden: false, monthlyAllowance: true });

    const desc = `UG PATTERN ${randomUUID().slice(0, 6)}`;
    const p = await txn({ description: desc });
    const moved = await call("POST", "/transactions/recategorize-by-pattern", { pattern: desc, matchType: "exact", fromCategoryId: null, toCategoryId: cat.dining });
    expect(moved).toMatchObject({ status: 200, body: { updated: 1 } });
    const [d] = await db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.transactionId, p));
    expect(d).toMatchObject({ flagsBefore: { isTransferUserOverridden: false }, flagsAfter: { isTransferUserOverridden: true } });
    expect((await call("POST", `/category-decisions/${d!.id}/undo`)).status).toBe(200);
    expect(await flagsOf(p)).toMatchObject({ categoryId: null, isTransferUserOverridden: false });
  });

  it("a decision written before 0210 (no snapshot) undoes the category only, as before", async () => {
    const id = await txn({ categoryId: cat.groceries, weeklyAllowance: true });
    const r = await call("PATCH", `/transactions/${id}`, { categoryId: cat.transfer });
    await db.update(categoryDecisionsTable).set({ flagsBefore: null, flagsAfter: null }).where(eq(categoryDecisionsTable.id, r.body.decisionId));
    expect((await call("POST", `/category-decisions/${r.body.decisionId}/undo`)).status).toBe(200);
    expect(await flagsOf(id)).toMatchObject({ categoryId: cat.groceries, isTransfer: true, weeklyAllowance: false });
  });

  it("flagsToRestore: only changed flags, back to their before value", () => {
    const f = (o: Partial<Record<string, boolean>> = {}) => ({
      isTransfer: false,
      isTransferUserOverridden: false,
      weeklyAllowance: false,
      monthlyAllowance: false,
      unplannedAllowance: false,
      ...o,
    });
    expect(flagsToRestore({ flagsBefore: f({ weeklyAllowance: true }), flagsAfter: f({ isTransfer: true }) }, f({ isTransfer: true }))).toEqual({
      isTransfer: false,
      weeklyAllowance: true,
    });
    expect(flagsToRestore({ flagsBefore: null, flagsAfter: null }, f())).toEqual({});
  });
});

describe("the forecast resolution write returns what it deleted, and those rows come back exactly", () => {
  it("⭐ a match replaces the occurrence's skip, the row's other match and the pair's 'Not this'; restore puts all three back", async () => {
    const [bill] = await db
      .insert(recurringItemsTable)
      .values({ userId: U, householdId: hh(), name: "UG Water", kind: "bill", amount: "60", frequency: "monthly", dayOfMonth: 5, anchorDate: "2026-06-05", active: "true" })
      .returning();
    const row = await txn({ amount: "-60.00", occurredOn: "2026-10-06" });
    const base = { userId: U, householdId: hh() };
    const seeded = await db
      .insert(forecastResolutionsTable)
      .values([
        { ...base, recurringItemId: bill!.id, occurrenceDate: "2026-10-05", status: "skipped" },
        { ...base, recurringItemId: bill!.id, occurrenceDate: "2026-09-05", status: "matched", matchedTxnId: row },
        { ...base, recurringItemId: bill!.id, occurrenceDate: "2026-10-05", status: "not_match", matchedTxnId: row },
        // Untouched: another occurrence's answer.
        { ...base, recurringItemId: bill!.id, occurrenceDate: "2026-08-05", status: "skipped" },
      ])
      .returning();
    const input = { ...base, recurringItemId: bill!.id, occurrenceDate: "2026-10-05", status: "matched", matchedTxnId: row };
    const wouldDelete = await resolutionNeighbours(input);
    expect(wouldDelete.map((r) => r.id)).toEqual(seeded.slice(0, 3).map((r) => r.id).sort());

    const { row: written, deleted } = await writeForecastResolution(db, input);
    expect(deleted.map((r) => r.id)).toEqual(seeded.slice(0, 3).map((r) => r.id));
    expect([...deleted].sort((a, b) => a.id.localeCompare(b.id))).toEqual(wouldDelete);
    const left = await db.select().from(forecastResolutionsTable).where(eq(forecastResolutionsTable.householdId, hh()));
    expect(left.map((r) => r.id).sort()).toEqual([written.id, seeded[3]!.id].sort());

    // The undo: delete what was written, restore what it replaced — byte for byte.
    await db.transaction(async (tx) => {
      await tx.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.id, written.id));
      await restoreForecastResolutions(tx, deleted);
    });
    const back = await db.select().from(forecastResolutionsTable).where(eq(forecastResolutionsTable.householdId, hh()));
    const byId = (rows: typeof back) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(back)).toEqual(byId(seeded));
  });

  it("the route's answer is unchanged: POST /forecast/resolutions still replaces the occurrence's answer", async () => {
    const [bill] = await db
      .insert(recurringItemsTable)
      .values({ userId: U, householdId: hh(), name: "UG Power", kind: "bill", amount: "90", frequency: "monthly", dayOfMonth: 9, anchorDate: "2026-06-09", active: "true" })
      .returning();
    const first = await call("POST", "/forecast/resolutions", { recurringItemId: bill!.id, occurrenceDate: "2026-10-09", status: "skipped" });
    expect(first.status).toBe(200);
    const second = await call("POST", "/forecast/resolutions", { recurringItemId: bill!.id, occurrenceDate: "2026-10-09", status: "missed" });
    expect(second).toMatchObject({ status: 200, body: { status: "missed", recurringItemId: bill!.id, occurrenceDate: "2026-10-09", householdId: hh() } });
    const rows = await db.select().from(forecastResolutionsTable).where(eq(forecastResolutionsTable.recurringItemId, bill!.id));
    expect(rows.map((r) => r.status)).toEqual(["missed"]);
    expect((await call("POST", "/forecast/resolutions", {})).status).toBe(400);
  });
});
