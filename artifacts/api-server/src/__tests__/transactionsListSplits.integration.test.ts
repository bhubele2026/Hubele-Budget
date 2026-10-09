// (F4b) GET /transactions carries the parts of a VALID split as `splits`, so
// the Cash flow money flow and the Budget actuals popover can file each part
// under its own category. A charge with no split, an invalid split, or parts
// that do not add up has NO `splits` key (it serializes as it always did and
// counts whole). The parts come from one batched query, not one per row.
// Synthetic data only.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";

const OWNER = `f4b-split-${process.pid}-${randomUUID().slice(0, 8)}`;
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

import { loadSplitsForTxns } from "../lib/categorizer/splits";
import { db, budgetCategoriesTable, transactionSplitsTable, transactionsTable } from "@workspace/db";
import categorizationRouter from "../routes/categorization";
import transactionsRouter from "../routes/transactions";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";

const both = express.Router();
both.use(categorizationRouter);
both.use(transactionsRouter);
const { request } = createTestApp(both);
const cats: Record<string, string> = {};
type Row = { id: string; amount: string; categoryId: string | null; splits?: { categoryId: string; amount: string }[] };

async function txn(o: Partial<typeof transactionsTable.$inferInsert> = {}): Promise<string> {
  const [r] = await db
    .insert(transactionsTable)
    .values({
      userId: OWNER,
      householdId: HH,
      occurredOn: "2026-09-12",
      description: "SPLIT STORE",
      amount: "-100.00",
      source: "plaid:bank",
      plaidAccountId: "acct-s",
      categoryId: cats.Groceries,
      ...o,
    })
    .returning({ id: transactionsTable.id });
  return r!.id;
}
const list = async () => (await request("GET", "/transactions?from=2026-09-01&to=2026-09-30")).json as Row[];

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
  for (const n of ["Groceries", "Household", "Gifts"]) {
    const [c] = await db
      .insert(budgetCategoriesTable)
      .values({ userId: OWNER, householdId: HH, name: `${n} ${randomUUID().slice(0, 6)}`, kind: "expense" })
      .returning({ id: budgetCategoriesTable.id });
    cats[n] = c!.id;
  }
});
beforeEach(async () => {
  await db.delete(transactionsTable).where(eq(transactionsTable.householdId, HH));
});

const split = (id: string) =>
  request("POST", `/transactions/${id}/splits`, {
    splits: [
      { categoryId: cats.Household, amount: "-60.00" },
      { categoryId: cats.Gifts, amount: "-40.00" },
    ],
  });

describe("GET /transactions — splits on list rows", () => {
  it("a valid split carries its parts (category + signed amount, adding up to the charge)", async () => {
    const id = await txn();
    expect((await split(id)).status).toBe(200);
    const row = (await list()).find((r) => r.id === id)!;
    expect(row.categoryId).toBe(cats.Groceries); // the parent keeps its own category
    expect(row.splits).toEqual([
      { categoryId: cats.Household, amount: "-60.00" },
      { categoryId: cats.Gifts, amount: "-40.00" },
    ]);
  });

  it("an unsplit charge and an invalid split have NO splits key", async () => {
    const plain = await txn({ description: "PLAIN" });
    const flagged = await txn({ description: "FLAGGED" });
    expect((await split(flagged)).status).toBe(200);
    await db.update(transactionsTable).set({ splitsInvalid: true }).where(eq(transactionsTable.id, flagged));
    const rows = await list();
    for (const id of [plain, flagged]) {
      const r = rows.find((x) => x.id === id)!;
      expect(Object.prototype.hasOwnProperty.call(r, "splits"), id).toBe(false);
    }
  });

  it("parts that no longer add up to the charge are left off (counts whole), like the server's totals", async () => {
    const id = await txn();
    await split(id);
    await db.update(transactionsTable).set({ amount: "-120.00" }).where(eq(transactionsTable.id, id));
    const row = (await list()).find((r) => r.id === id)!;
    expect(Object.prototype.hasOwnProperty.call(row, "splits")).toBe(false);
  });

  it("the parts are loaded in one batched query: the query count does not grow with the rows", async () => {
    const countQueries = async () => {
      const spy = vi.spyOn(db, "select");
      await list();
      const n = spy.mock.calls.length;
      spy.mockRestore();
      return n;
    };
    await txn({ description: "ONE" });
    const one = await countQueries();
    for (let i = 0; i < 5; i++) {
      const id = await txn({ description: `MANY ${i}` });
      if (i % 2 === 0) await split(id);
    }
    expect(await countQueries()).toBe(one);
  });

  it("loadSplitsForTxns takes the ids as one parameter: 70,000 ids (almost none real) still work", async () => {
    const real = await txn();
    await split(real);
    const ids: string[] = Array.from({ length: 70_000 }, () => randomUUID());
    ids.push(real);
    const out = await loadSplitsForTxns(HH, ids);
    expect(out.size).toBe(1);
    expect(out.get(real)).toHaveLength(2);
    expect((await loadSplitsForTxns(HH, [])).size).toBe(0);
  });
});
