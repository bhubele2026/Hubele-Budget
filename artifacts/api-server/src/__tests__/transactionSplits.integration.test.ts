// (PR-A) transaction_splits: Σ = parent to the cent, replace-all, rescale on a
// small Plaid drift, invalid + queued on a large one, and the two readers
// (`buildSpendingFacts`, `aggregateBudgetMonth`) file category totals from
// splits only where splits exist. Synthetic data only.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

const OWNER = `pra-split-${process.pid}-${randomUUID().slice(0, 8)}`;
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
  budgetCategoriesTable,
  categoryDecisionsTable,
  transactionSplitsTable,
  transactionsTable,
} from "@workspace/db";
import categorizationRouter from "../routes/categorization";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";
import {
  expandSplits,
  loadSplitsByTxn,
  reconcileSplitsAfterSync,
  rescaleSplits,
  validateSplits,
} from "../lib/categorizer/splits";
import { buildSpendingFacts } from "../lib/spendingFacts";
import { aggregateBudgetMonth } from "../lib/budgetActuals";
import { findSupersededPending } from "../lib/supersededPending";

const { request } = createTestApp(categorizationRouter);
const cats: Record<string, string> = {};

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

describe("validation and arithmetic (pure)", () => {
  it("Σ must equal the parent to the cent, same sign, 2–20 parts", () => {
    expect(validateSplits("-100.00", [{ categoryId: "a", amount: "-60.00" }, { categoryId: "b", amount: "-40.00" }])).toBeNull();
    expect(validateSplits("-100.00", [{ categoryId: "a", amount: "-60.00" }, { categoryId: "b", amount: "-39.99" }])).toMatch(/add up/);
    expect(validateSplits("-100.00", [{ categoryId: "a", amount: "-110.00" }, { categoryId: "b", amount: "10.00" }])).toMatch(/sign/);
    expect(validateSplits("-100.00", [{ categoryId: "a", amount: "-100.00" }])).toMatch(/two/);
  });
  it("rescale is proportional and exact", () => {
    expect(rescaleSplits([-6000, -4000], -10040)).toEqual([-6024, -4016]);
    const r = rescaleSplits([-3333, -3333, -3334], -10001);
    expect(r.reduce((a, b) => a + b, 0)).toBe(-10001);
  });
  it("expandSplits lists only rows whose splits add up", () => {
    const m = new Map([
      ["ok", [{ categoryId: "a", amount: "-60.00" }, { categoryId: "b", amount: "-40.00" }]],
      ["off", [{ categoryId: "a", amount: "-60.00" }, { categoryId: "b", amount: "-41.00" }]],
    ]);
    const out = expandSplits([{ id: "ok", amount: "-100.00" }, { id: "off", amount: "-100.00" }, { id: "none", amount: "-5.00" }], m);
    expect([...out.keys()]).toEqual(["ok"]);
  });
});

describe("routes", () => {
  it("replace-all, keeps the parent's category, locks it; GET and DELETE", async () => {
    const id = await txn();
    const bad = await request("POST", `/transactions/${id}/splits`, {
      splits: [{ categoryId: cats.Groceries, amount: "-60.00" }, { categoryId: cats.Household, amount: "-30.00" }],
    });
    expect(bad.status).toBe(400);
    const ok = await request("POST", `/transactions/${id}/splits`, {
      splits: [{ categoryId: cats.Groceries, amount: "-60.00" }, { categoryId: cats.Household, amount: "-40.00", note: "soap" }],
    });
    expect(ok.status).toBe(200);
    const [parent] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, id));
    expect(parent).toMatchObject({ categoryId: cats.Groceries, categoryLockedByUser: true, splitsInvalid: false });
    const again = await request("POST", `/transactions/${id}/splits`, {
      splits: [{ categoryId: cats.Gifts, amount: "-10.00" }, { categoryId: cats.Household, amount: "-90.00" }],
    });
    expect((again.json as { splits: unknown[] }).splits).toHaveLength(2);
    const got = (await request("GET", `/transactions/${id}/splits`)).json as { splits: { categoryId: string; amount: string }[] };
    expect(got.splits.map((s) => [s.categoryId, s.amount])).toEqual([[cats.Gifts, "-10.00"], [cats.Household, "-90.00"]]);
    expect((await request("DELETE", `/transactions/${id}/splits`)).status).toBe(204);
    expect(await db.select().from(transactionSplitsTable).where(eq(transactionSplitsTable.transactionId, id))).toHaveLength(0);
  });
});

describe("after a Plaid upsert", () => {
  it("rescales a drift under $1, flags and queues one of $1 or more; the parent then counts whole", async () => {
    const small = await txn();
    const big = await txn({ description: "SPLIT STORE TWO" });
    for (const id of [small, big]) {
      await request("POST", `/transactions/${id}/splits`, {
        splits: [{ categoryId: cats.Groceries, amount: "-60.00" }, { categoryId: cats.Household, amount: "-40.00" }],
      });
    }
    await db.update(transactionsTable).set({ amount: "-100.40" }).where(eq(transactionsTable.id, small));
    await db.update(transactionsTable).set({ amount: "-112.00" }).where(eq(transactionsTable.id, big));
    expect(await reconcileSplitsAfterSync(HH, [small, big])).toEqual({ rescaled: 1, invalidated: 1 });
    const parts = await db.select().from(transactionSplitsTable).where(eq(transactionSplitsTable.transactionId, small)).orderBy(transactionSplitsTable.createdAt, transactionSplitsTable.id);
    expect(parts.map((p) => p.amount).sort()).toEqual(["-40.16", "-60.24"]);
    const [b] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, big));
    expect(b!.splitsInvalid).toBe(true);
    const [notice] = await db.select().from(categoryDecisionsTable).where(and(eq(categoryDecisionsTable.transactionId, big), eq(categoryDecisionsTable.band, "queue")));
    expect(notice!.explanation).toMatch(/split no longer adds up/);
    const review = (await request("GET", "/categorization/review")).json as { items: { transactionId: string; flags: { splitNeedsRebalance: boolean } }[] };
    expect(review.items.find((i) => i.transactionId === big)!.flags.splitNeedsRebalance).toBe(true);
    // Idempotent.
    expect(await reconcileSplitsAfterSync(HH, [small, big])).toEqual({ rescaled: 0, invalidated: 0 });
    // The invalid parent is not expanded: it counts whole.
    const loaded = await loadSplitsByTxn(HH);
    expect(loaded.has(big)).toBe(false);
    // Re-splitting it clears the flag and resolves the notice.
    await request("POST", `/transactions/${big}/splits`, {
      splits: [{ categoryId: cats.Groceries, amount: "-72.00" }, { categoryId: cats.Household, amount: "-40.00" }],
    });
    const [b2] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, big));
    expect(b2!.splitsInvalid).toBe(false);
    expect(((await request("GET", "/categorization/review")).json as { total: number }).total).toBe(0);
  });
});

describe("readers", () => {
  it("spending facts and the budget month file category totals from splits; every other figure is unchanged", async () => {
    const split = await txn();
    await txn({ description: "PLAIN STORE", amount: "-25.00" });
    const before = await buildSpendingFacts(HH, "2026-09-01", "2026-09-30");
    await request("POST", `/transactions/${split}/splits`, {
      splits: [{ categoryId: cats.Groceries, amount: "-70.00" }, { categoryId: cats.Gifts, amount: "-30.00" }],
    });
    const after = await buildSpendingFacts(HH, "2026-09-01", "2026-09-30");
    const byCat = (f: typeof after) => new Map(f.byCategory.map((c) => [c.categoryId, c.total]));
    expect(byCat(before).get(cats.Groceries!)).toBe(125);
    expect(byCat(after).get(cats.Groceries!)).toBe(95);
    expect(byCat(after).get(cats.Gifts!)).toBe(30);
    const strip = (f: typeof after) => ({ ...f, byCategory: undefined, monthlyTrends: undefined });
    expect(strip(after)).toEqual(strip(before));

    const rows = await db.select().from(transactionsTable).where(eq(transactionsTable.householdId, HH));
    const sup = await findSupersededPending(HH);
    const monthRows = rows.map((r) => ({ ...r }));
    const plain = aggregateBudgetMonth(monthRows, sup, { uncategorizedIds: new Set() });
    const withSplits = aggregateBudgetMonth(monthRows, sup, { uncategorizedIds: new Set() }, expandSplits(monthRows, await loadSplitsByTxn(HH)));
    expect(plain.byCategory.get(cats.Groceries!)!.spend.posted).toBe(12500);
    expect(withSplits.byCategory.get(cats.Groceries!)!.spend.posted).toBe(9500);
    expect(withSplits.byCategory.get(cats.Gifts!)!.spend.posted).toBe(3000);
    expect(withSplits.allowanceRows).toEqual(plain.allowanceRows);
  });
});
