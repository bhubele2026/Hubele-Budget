// (PR-A2) Categorization API polish for the Activity screen: ids on the hand
// filing, split count and provisional flag on ledger rows, a dry run for
// "apply to past charges", and the decision history of one charge.
// Synthetic data only.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { eq } from "drizzle-orm";

const OWNER = `pra2-owner-${process.pid}-${randomUUID().slice(0, 8)}`;
const OTHER = `pra2-other-${process.pid}-${randomUUID().slice(0, 8)}`;
const who = { userId: OWNER, householdId: "", ownerId: OWNER };

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = who.userId;
    req.actualUserId = who.userId;
    req.householdId = who.householdId;
    req.householdOwnerId = who.ownerId;
    next();
  },
}));

import {
  db,
  budgetCategoriesTable,
  categoryDecisionsTable,
  merchantMemoryTable,
  transactionsTable,
} from "@workspace/db";
import { GetTransactionsLedgerResponse } from "@workspace/api-zod";
import transactionsRouter from "../routes/transactions";
import ledgerRouter from "../routes/transactionsLedger";
import categorizationRouter from "../routes/categorization";
import learnedRulesRouter from "../routes/learnedRules";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";

const api = Router();
api.use((req, _res, next) => {
  (req as { log?: unknown }).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
api.use(ledgerRouter);
api.use(transactionsRouter);
api.use(categorizationRouter);
api.use(learnedRulesRouter);
const { request } = createTestApp(api);

let HH = "";
let HH_OTHER = "";
const cats: Record<string, string> = {};

async function makeCat(hh: string, user: string, name: string): Promise<string> {
  const [c] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: user, householdId: hh, name: `${name} ${randomUUID().slice(0, 6)}`, kind: "expense" })
    .returning({ id: budgetCategoriesTable.id });
  return c!.id;
}

let seq = 0;
async function txn(o: Partial<typeof transactionsTable.$inferInsert> = {}, hh = HH, user = OWNER): Promise<string> {
  seq += 1;
  const [r] = await db
    .insert(transactionsTable)
    .values({
      userId: user,
      householdId: hh,
      occurredOn: "2026-09-10",
      description: `PRA2 ROW ${seq}`,
      amount: "-10.00",
      source: "manual",
      ...o,
    })
    .returning({ id: transactionsTable.id });
  return r!.id;
}
const decisionsOf = (id: string) =>
  db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.transactionId, id));

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
  HH_OTHER = (await createTestHousehold(OTHER)).householdId;
  for (const n of ["Groceries", "Dining", "Coffee"]) cats[n] = await makeCat(HH, OWNER, n);
});

beforeEach(async () => {
  who.userId = OWNER;
  who.householdId = HH;
  who.ownerId = OWNER;
  for (const h of [HH, HH_OTHER]) {
    await db.delete(transactionsTable).where(eq(transactionsTable.householdId, h));
    await db.delete(merchantMemoryTable).where(eq(merchantMemoryTable.householdId, h));
  }
});

describe("PATCH /transactions/:id returns the ids", () => {
  it("returns decisionId and learnedRuleId when a category is set; null for both when none was", async () => {
    const id = await txn({ description: "PINE STREET BAKERY 0001" });
    const res = await request("PATCH", `/transactions/${id}`, { categoryId: cats.Coffee });
    expect(res.status).toBe(200);
    const body = res.json as { decisionId: string | null; learnedRuleId: string | null };
    const [decision] = await decisionsOf(id);
    expect(body.decisionId).toBe(decision!.id);
    const [mem] = await db.select().from(merchantMemoryTable).where(eq(merchantMemoryTable.householdId, HH));
    expect(body.learnedRuleId).toBe(mem!.id);

    // The same merchant filed again confirms the same rule.
    const id2 = await txn({ description: "PINE STREET BAKERY 0002" });
    const again = (await request("PATCH", `/transactions/${id2}`, { categoryId: cats.Coffee })).json as {
      decisionId: string;
      learnedRuleId: string;
    };
    expect(again.learnedRuleId).toBe(mem!.id);
    expect(again.decisionId).not.toBe(body.decisionId);

    // No category in the body: no decision, no rule.
    const plain = (await request("PATCH", `/transactions/${id}`, { reviewed: true })).json as Record<string, unknown>;
    expect(plain).not.toHaveProperty("decisionId");
    expect(plain).not.toHaveProperty("learnedRuleId");
    expect(await decisionsOf(id)).toHaveLength(1);
  });

  it("bulk-update returns decisionIds, one per updated row; none when no category was in the patch", async () => {
    const a = await txn();
    const b = await txn();
    const res = await request("POST", "/transactions/bulk-update", { ids: [a, b], patch: { categoryId: cats.Dining } });
    const body = res.json as { updated: number; decisionIds: string[] };
    expect(body.updated).toBe(2);
    const all = [...(await decisionsOf(a)), ...(await decisionsOf(b))].map((d) => d.id).sort();
    expect([...body.decisionIds].sort()).toEqual(all);
    const noCat = (await request("POST", "/transactions/bulk-update", { ids: [a, b], patch: { reviewed: true } })).json as {
      decisionIds: string[];
    };
    expect(noCat.decisionIds).toEqual([]);
  });
});

describe("GET /transactions/ledger rows", () => {
  it("carries splitCount (0 / 2), categoryProvisional and categoryLockedByUser", async () => {
    const plain = await txn({ description: "PLAIN ROW", amount: "-30.00", occurredOn: "2026-09-12" });
    const split = await txn({ description: "SPLIT ROW", amount: "-40.00", occurredOn: "2026-09-11" });
    const prov = await txn({
      description: "PROVISIONAL ROW",
      amount: "-5.00",
      occurredOn: "2026-09-10",
      categoryId: cats.Dining,
      categoryProvisional: true,
    });
    const saved = await request("POST", `/transactions/${split}/splits`, {
      splits: [
        { categoryId: cats.Groceries, amount: "-25.00" },
        { categoryId: cats.Dining, amount: "-15.00" },
      ],
    });
    expect(saved.status).toBe(200);
    const res = await request("GET", "/transactions/ledger");
    expect(res.status).toBe(200);
    const page = GetTransactionsLedgerResponse.parse(res.json);
    const by = new Map(page.rows.map((r) => [r.id, r]));
    expect(by.get(plain)).toMatchObject({ splitCount: 0, categoryProvisional: false });
    expect(by.get(split)).toMatchObject({ splitCount: 2, categoryLockedByUser: true });
    expect(by.get(prov)).toMatchObject({ splitCount: 0, categoryProvisional: true, categoryLockedByUser: false });
  });

  it("does not count another household's splits or rows", async () => {
    const mine = await txn({ description: "MINE" });
    const theirs = await txn({ description: "THEIRS" }, HH_OTHER, OTHER);
    const catOther = await makeCat(HH_OTHER, OTHER, "Theirs");
    who.userId = OTHER;
    who.householdId = HH_OTHER;
    who.ownerId = OTHER;
    expect(
      (await request("POST", `/transactions/${theirs}/splits`, {
        splits: [
          { categoryId: catOther, amount: "-4.00" },
          { categoryId: catOther, amount: "-6.00" },
        ],
      })).status,
    ).toBe(200);
    who.userId = OWNER;
    who.householdId = HH;
    who.ownerId = OWNER;
    const page = GetTransactionsLedgerResponse.parse((await request("GET", "/transactions/ledger")).json);
    expect(page.rows.map((r) => r.id)).toEqual([mine]);
    expect(page.rows[0]!.splitCount).toBe(0);
  });
});

describe("POST /learned-rules/:id/apply-retroactively dryRun", () => {
  it("writes nothing, reports the count and at most five rows, and matches the real run", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      ids.push(await txn({ description: `HARBOR TEA 100${i}`, amount: `-${6 + i}.00`, occurredOn: `2026-08-${10 + i}` }));
    }
    const taught = await txn({ description: "HARBOR TEA 0999", amount: "-5.00" });
    const patched = (await request("PATCH", `/transactions/${taught}`, { categoryId: cats.Coffee })).json as {
      learnedRuleId: string;
    };
    const url = `/learned-rules/${patched.learnedRuleId}/apply-retroactively`;
    const decisionsBefore = (await db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.householdId, HH))).length;

    const dry = await request("POST", `${url}?dryRun=true`);
    expect(dry.status).toBe(200);
    const d = dry.json as {
      updated: number;
      dryRun: boolean;
      count: number;
      sample: { transactionId: string; description: string; occurredOn: string; amount: string }[];
    };
    expect(d).toMatchObject({ updated: 0, dryRun: true, count: 7 });
    expect(d.sample).toHaveLength(5);
    for (const s of d.sample) {
      expect(ids).toContain(s.transactionId);
      expect(Object.keys(s).sort()).toEqual(["amount", "description", "occurredOn", "transactionId"]);
    }
    // Nothing moved, nothing recorded.
    for (const id of ids) {
      const [r] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, id));
      expect(r!.categoryId).toBeNull();
      expect(r!.categoryLockedByUser).toBe(false);
    }
    expect((await db.select().from(categoryDecisionsTable).where(eq(categoryDecisionsTable.householdId, HH))).length).toBe(decisionsBefore);
    expect((await request("POST", url, { dryRun: false })).json).toEqual({ updated: 7 });

    // The real write path is unchanged; a second dry run now finds nothing.
    for (const id of ids) {
      const [r] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, id));
      expect(r).toMatchObject({ categoryId: cats.Coffee, categoryLockedByUser: true });
    }
    expect((await request("POST", `${url}?dryRun=true`)).json).toMatchObject({ count: 0, sample: [] });
    // A raw caller may send it in the body instead.
    expect((await request("POST", url, { dryRun: true })).json).toMatchObject({ dryRun: true, count: 0 });
    // No body at all still works.
    expect((await request("POST", url)).json).toEqual({ updated: 0 });
  });

  it("answers 404 for another household's rule, and a bad body 400", async () => {
    const t = await txn({ description: "CEDAR GROCER 0001" });
    const { learnedRuleId } = (await request("PATCH", `/transactions/${t}`, { categoryId: cats.Groceries })).json as {
      learnedRuleId: string;
    };
    expect((await request("POST", `/learned-rules/${learnedRuleId}/apply-retroactively`, { dryRun: "yes" })).status).toBe(400);
    expect((await request("POST", `/learned-rules/${learnedRuleId}/apply-retroactively?dryRun=maybe`)).status).toBe(400);
    who.userId = OTHER;
    who.householdId = HH_OTHER;
    who.ownerId = OTHER;
    expect((await request("POST", `/learned-rules/${learnedRuleId}/apply-retroactively?dryRun=true`)).status).toBe(404);
  });
});

describe("GET /category-decisions?transactionId=", () => {
  it("lists one charge's decisions newest first, with the fields the sheet shows", async () => {
    const id = await txn({ description: "WILLOW CAFE 0001" });
    await request("PATCH", `/transactions/${id}`, { categoryId: cats.Coffee });
    await new Promise((r) => setTimeout(r, 15));
    await request("PATCH", `/transactions/${id}`, { categoryId: cats.Dining });
    const other = await txn({ description: "UNRELATED 1" });
    await request("PATCH", `/transactions/${other}`, { categoryId: cats.Groceries });

    const res = await request("GET", `/category-decisions?transactionId=${id}`);
    expect(res.status).toBe(200);
    const list = res.json as Record<string, unknown>[];
    expect(list).toHaveLength(2);
    expect(list.map((d) => d.categoryId)).toEqual([cats.Dining, cats.Coffee]);
    expect(list[0]).toMatchObject({
      transactionId: id,
      source: "user",
      previousCategoryId: cats.Coffee,
      confidence: 1,
      band: "auto",
      resolution: "corrected",
      undoneAt: null,
    });
    expect(typeof list[0]!.explanation).toBe("string");
    expect(typeof list[0]!.createdAt).toBe("string");
    expect(list.every((d) => d.transactionId === id)).toBe(true);
  });

  it("caps at 20, and a charge in another household is a 404", async () => {
    const id = await txn({ description: "MAPLE KIOSK 1" });
    const now = Date.now();
    await db.insert(categoryDecisionsTable).values(
      Array.from({ length: 23 }, (_, i) => ({
        householdId: HH,
        transactionId: id,
        source: "model",
        categoryId: cats.Dining!,
        previousCategoryId: null,
        confidence: "0.800",
        band: "provisional",
        explanation: `Try ${i}`,
        inputHash: `h-${i}-${randomUUID()}`,
        createdAt: new Date(now - i * 1000),
      })),
    );
    const list = (await request("GET", `/category-decisions?transactionId=${id}`)).json as { explanation: string }[];
    expect(list).toHaveLength(20);
    expect(list[0]!.explanation).toBe("Try 0");
    expect(list[19]!.explanation).toBe("Try 19");

    who.userId = OTHER;
    who.householdId = HH_OTHER;
    who.ownerId = OTHER;
    expect((await request("GET", `/category-decisions?transactionId=${id}`)).status).toBe(404);
    expect((await request("GET", "/category-decisions")).status).toBe(400);
    expect((await request("GET", "/category-decisions?transactionId=not-a-uuid")).status).toBe(400);
  });
});
