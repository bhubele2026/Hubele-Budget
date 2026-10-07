// PR-0 · transactions.category_locked_by_user — every USER write path that
// picks a category locks the row; clearing the category unlocks it; a
// category the rules auto-filled is never locked; the flag cannot be written
// directly by a client.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

const TEST_USER = `lock-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

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

import {
  budgetCategoriesTable,
  db,
  mappingRulesTable,
  transactionsTable,
} from "@workspace/db";
import transactionsRouter from "../routes/transactions";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";

const { request } = createTestApp(transactionsRouter);

let CAT_A: string;
let CAT_B: string;

async function cleanupRows(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.householdId, TEST_HOUSEHOLD_ID));
  await db.delete(mappingRulesTable).where(eq(mappingRulesTable.householdId, TEST_HOUSEHOLD_ID));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanupRows();
  const cats = await db
    .insert(budgetCategoriesTable)
    .values(
      ["Lock test A", "Lock test B"].map((name) => ({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: `${name} ${randomUUID().slice(0, 6)}`,
        kind: "expense",
      })),
    )
    .returning({ id: budgetCategoriesTable.id });
  CAT_A = cats[0]!.id;
  CAT_B = cats[1]!.id;
});

afterAll(async () => {
  await cleanupRows();
  await db
    .delete(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.householdId, TEST_HOUSEHOLD_ID));
});

beforeEach(cleanupRows);

async function insertTxn(
  overrides: Partial<typeof transactionsTable.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-04-15",
      description: "LOCKTEST SHOP 0001",
      amount: "-12.34",
      source: "manual",
      ...overrides,
    })
    .returning({ id: transactionsTable.id });
  return row!.id;
}

async function lockOf(id: string): Promise<{ categoryId: string | null; locked: boolean }> {
  const [row] = await db
    .select({
      categoryId: transactionsTable.categoryId,
      locked: transactionsTable.categoryLockedByUser,
    })
    .from(transactionsTable)
    .where(eq(transactionsTable.id, id));
  return row!;
}

describe("POST /transactions", () => {
  it("locks a row whose body names the category", async () => {
    const r = await request("POST", "/transactions", {
      occurredOn: "2026-04-15",
      description: "LOCKTEST HAND TYPED",
      amount: "-5.00",
      categoryId: CAT_A,
    });
    expect(r.status).toBe(201);
    const body = r.json as { id: string; categoryLockedByUser: boolean };
    expect(body.categoryLockedByUser).toBe(true);
    expect(await lockOf(body.id)).toEqual({ categoryId: CAT_A, locked: true });
  });

  it("does NOT lock a category the rules auto-filled", async () => {
    await db.insert(mappingRulesTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      pattern: "LOCKTEST RULED",
      matchType: "contains",
      categoryId: CAT_B,
      priority: 100,
    });
    const r = await request("POST", "/transactions", {
      occurredOn: "2026-04-15",
      description: "LOCKTEST RULED 42",
      amount: "-5.00",
    });
    expect(r.status).toBe(201);
    const body = r.json as { id: string; autoCategorizedRuleId: string | null };
    expect(body.autoCategorizedRuleId).not.toBeNull();
    expect(await lockOf(body.id)).toEqual({ categoryId: CAT_B, locked: false });
  });

  it("does not lock an explicit null category", async () => {
    const r = await request("POST", "/transactions", {
      occurredOn: "2026-04-15",
      description: "LOCKTEST NO CATEGORY",
      amount: "-5.00",
      categoryId: null,
    });
    expect(r.status).toBe(201);
    expect(await lockOf((r.json as { id: string }).id)).toEqual({
      categoryId: null,
      locked: false,
    });
  });
});

describe("PATCH /transactions/:id", () => {
  it("picking a category locks; clearing it unlocks", async () => {
    const id = await insertTxn();
    const picked = await request("PATCH", `/transactions/${id}`, { categoryId: CAT_A });
    expect(picked.status).toBe(200);
    expect((picked.json as { categoryLockedByUser: boolean }).categoryLockedByUser).toBe(true);
    expect(await lockOf(id)).toEqual({ categoryId: CAT_A, locked: true });

    const cleared = await request("PATCH", `/transactions/${id}`, { categoryId: null });
    expect(cleared.status).toBe(200);
    expect(await lockOf(id)).toEqual({ categoryId: null, locked: false });
  });

  it("an edit that does not touch the category leaves the lock alone", async () => {
    const locked = await insertTxn({ categoryId: CAT_A, categoryLockedByUser: true });
    const unlocked = await insertTxn({ categoryId: CAT_B });
    for (const id of [locked, unlocked]) {
      const r = await request("PATCH", `/transactions/${id}`, { notes: "edited" });
      expect(r.status).toBe(200);
    }
    const r = await request("PATCH", `/transactions/${unlocked}`, { isTransfer: false });
    expect(r.status).toBe(200);
    expect(await lockOf(locked)).toEqual({ categoryId: CAT_A, locked: true });
    expect(await lockOf(unlocked)).toEqual({ categoryId: CAT_B, locked: false });
  });

  it("a client cannot write the flag directly", async () => {
    const id = await insertTxn({ categoryId: CAT_B });
    const r = await request("PATCH", `/transactions/${id}`, {
      notes: "trying",
      categoryLockedByUser: true,
    });
    expect(r.status).toBe(200);
    expect(await lockOf(id)).toEqual({ categoryId: CAT_B, locked: false });
  });
});

describe("POST /transactions/bulk-update", () => {
  it("a bulk category pick locks every row; a bulk clear unlocks them", async () => {
    const ids = [await insertTxn(), await insertTxn({ categoryId: CAT_B })];
    const picked = await request("POST", "/transactions/bulk-update", {
      ids,
      patch: { categoryId: CAT_A },
    });
    expect(picked.status).toBe(200);
    for (const id of ids) expect(await lockOf(id)).toEqual({ categoryId: CAT_A, locked: true });

    const cleared = await request("POST", "/transactions/bulk-update", {
      ids,
      patch: { categoryId: null },
    });
    expect(cleared.status).toBe(200);
    for (const id of ids) expect(await lockOf(id)).toEqual({ categoryId: null, locked: false });
  });

  it("a bulk patch without a category leaves the lock alone", async () => {
    const id = await insertTxn({ categoryId: CAT_A, categoryLockedByUser: true });
    const r = await request("POST", "/transactions/bulk-update", {
      ids: [id],
      patch: { reviewed: true },
    });
    expect(r.status).toBe(200);
    expect(await lockOf(id)).toEqual({ categoryId: CAT_A, locked: true });
  });
});

describe("POST /transactions/recategorize-by-pattern", () => {
  it("locks every row it re-files", async () => {
    const ids = [
      await insertTxn({ description: "LOCKTEST PATTERN STORE 1" }),
      await insertTxn({ description: "LOCKTEST PATTERN STORE 2" }),
    ];
    const r = await request("POST", "/transactions/recategorize-by-pattern", {
      pattern: "LOCKTEST PATTERN STORE",
      matchType: "contains",
      fromCategoryId: null,
      toCategoryId: CAT_A,
    });
    expect(r.status).toBe(200);
    expect((r.json as { updated: number }).updated).toBe(2);
    for (const id of ids) expect(await lockOf(id)).toEqual({ categoryId: CAT_A, locked: true });
  });
});

describe("POST /transactions/recategorize-by-pattern Undo", () => {
  it("returns which moved rows were locked, and an Undo with lockedIds restores each row's lock", async () => {
    const hand = await insertTxn({
      description: "LOCKTEST UNDO STORE 1",
      categoryId: CAT_B,
      categoryLockedByUser: true,
    });
    const ruled = await insertTxn({ description: "LOCKTEST UNDO STORE 2", categoryId: CAT_B });
    const forward = await request("POST", "/transactions/recategorize-by-pattern", {
      pattern: "LOCKTEST UNDO STORE",
      matchType: "contains",
      fromCategoryId: CAT_B,
      toCategoryId: CAT_A,
    });
    expect(forward.status).toBe(200);
    const res = forward.json as { affectedIds: string[]; lockedIds: string[] };
    expect([...res.affectedIds].sort()).toEqual([hand, ruled].sort());
    expect(res.lockedIds).toEqual([hand]);
    expect(await lockOf(ruled)).toEqual({ categoryId: CAT_A, locked: true });

    const undo = await request("POST", "/transactions/recategorize-by-pattern", {
      pattern: "LOCKTEST UNDO STORE",
      matchType: "contains",
      fromCategoryId: CAT_A,
      toCategoryId: CAT_B,
      ids: res.affectedIds,
      lockedIds: res.lockedIds,
    });
    expect(undo.status).toBe(200);
    expect(await lockOf(hand)).toEqual({ categoryId: CAT_B, locked: true });
    expect(await lockOf(ruled)).toEqual({ categoryId: CAT_B, locked: false });
  });

  it("an Undo with an empty lockedIds unlocks every row; ids it cannot move are ignored", async () => {
    const id = await insertTxn({ description: "LOCKTEST UNDO EMPTY", categoryId: CAT_A, categoryLockedByUser: true });
    const r = await request("POST", "/transactions/recategorize-by-pattern", {
      pattern: "LOCKTEST UNDO EMPTY",
      matchType: "contains",
      fromCategoryId: CAT_A,
      toCategoryId: CAT_B,
      ids: [id],
      lockedIds: ["not-a-uuid"],
    });
    expect(r.status).toBe(200);
    expect(await lockOf(id)).toEqual({ categoryId: CAT_B, locked: false });
  });
});

describe("POST /transactions/:id/clear-transfer-override (Reset to auto)", () => {
  it("unlocks the category along with the transfer override", async () => {
    const id = await insertTxn({
      categoryId: CAT_A,
      categoryLockedByUser: true,
      isTransferUserOverridden: true,
    });
    const r = await request("POST", `/transactions/${id}/clear-transfer-override`);
    expect(r.status).toBe(200);
    expect(await lockOf(id)).toEqual({ categoryId: CAT_A, locked: false });
  });
});

describe("POST /transactions/uncategorize-by-ids", () => {
  it("clears the category and the lock", async () => {
    const id = await insertTxn({ categoryId: CAT_A, categoryLockedByUser: true });
    const r = await request("POST", "/transactions/uncategorize-by-ids", {
      ids: [id],
      fromCategoryId: CAT_A,
    });
    expect(r.status).toBe(200);
    expect((r.json as { updated: number }).updated).toBe(1);
    expect(await lockOf(id)).toEqual({ categoryId: null, locked: false });
  });
});
