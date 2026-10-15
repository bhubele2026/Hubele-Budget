// ⭐ (Q2) THE DIRECTION GUARD ON EVERY HAND WRITE — synthetic. Every name,
// amount and account number is made up.
//
// One employer pays the household AND runs the office cafeteria, so a payroll
// credit and small card purchases share one merchant name:
//   checking ••7701  ORIG CO NAME:MAPLEWORKS INC ... PAYROLL   +2,391.40   (money IN)
//   card     ••7702  MAPLEWORKS INC                           −8.50, −9.25 (money OUT)
//
// The review queue already refused to file money against its direction (F2).
// Q2 puts the same rule (`categoryDirectionConflict`, through
// `directionConflictsOf`) in front of the four other hand writes:
//   PATCH /transactions/:id · POST /transactions/bulk-update ·
//   POST /transactions/recategorize-by-pattern · an approved agent set_category.
// Each refuses the payroll credit → Dining with 409 `direction_conflict` and
// writes nothing; each still files the same-name card purchase to Dining.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, count, eq, inArray } from "drizzle-orm";

const tag = `${process.pid}-${randomUUID().slice(0, 8)}`;
const G = `dg-g-${tag}`;
const HH: Record<string, { householdId: string; ownerUserId: string }> = {};

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    const hh = HH[G]!;
    req.userId = hh.ownerUserId;
    req.actualUserId = hh.ownerUserId;
    req.householdId = hh.householdId;
    req.householdOwnerId = hh.ownerUserId;
    next();
  },
}));

import {
  db,
  agentActionsTable,
  agentRunsTable,
  budgetCategoriesTable,
  categoryDecisionsTable,
  mappingRulesTable,
  merchantMemoryTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
  type AgentProposal,
} from "@workspace/db";
import transactionsRouter from "../routes/transactions";
import { applyProposal } from "../lib/proposalApply";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(transactionsRouter);

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

const ids: Record<string, string> = {};
const cat: Record<string, string> = {};
const acct: Record<string, string> = {};
const hh = () => HH[G]!.householdId;

async function cleanup(): Promise<void> {
  const hhIds = Object.values(HH).map((h) => h.householdId);
  if (hhIds.length === 0) return;
  await db.delete(agentActionsTable).where(inArray(agentActionsTable.householdId, hhIds));
  await db.delete(agentRunsTable).where(inArray(agentRunsTable.householdId, hhIds));
  await db.delete(categoryDecisionsTable).where(inArray(categoryDecisionsTable.householdId, hhIds));
  await db.delete(merchantMemoryTable).where(inArray(merchantMemoryTable.householdId, hhIds));
  await db.delete(mappingRulesTable).where(inArray(mappingRulesTable.householdId, hhIds));
  await db.delete(transactionsTable).where(inArray(transactionsTable.householdId, hhIds));
  await db.delete(budgetCategoriesTable).where(inArray(budgetCategoriesTable.householdId, hhIds));
  await db.delete(plaidAccountsTable).where(inArray(plaidAccountsTable.householdId, hhIds));
  await db.delete(plaidItemsTable).where(inArray(plaidItemsTable.householdId, hhIds));
}

async function seedAccount(key: string, name: string, mask: string, type: string, subtype: string): Promise<void> {
  const owned = { userId: G, householdId: hh() };
  const [it] = await db
    .insert(plaidItemsTable)
    .values({ ...owned, itemId: `dg-item-${key}-${randomUUID()}`, accessToken: "t", institutionName: type === "credit" ? "American Express" : "Chase" })
    .returning();
  const ext = `dg-${key}-${randomUUID().slice(0, 8)}`;
  await db.insert(plaidAccountsTable).values({ ...owned, itemId: it!.id, accountId: ext, name, mask, type, subtype });
  acct[key] = ext;
}

async function seedTxn(key: string, on: string, desc: string, amount: string, account: "chase" | "amex"): Promise<void> {
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: G,
      householdId: hh(),
      occurredOn: on,
      description: desc,
      amount,
      plaidAccountId: acct[account]!,
      plaidTransactionId: `dg-${key}-${randomUUID().slice(0, 8)}`,
      source: account === "amex" ? "plaid:amex" : "plaid:chase",
    })
    .returning({ id: transactionsTable.id });
  ids[key] = t!.id;
}

const rowOf = async (key: string) => (await db.select().from(transactionsTable).where(eq(transactionsTable.id, ids[key]!)))[0]!;
const decisionsFor = async (key: string) =>
  (await db.select({ n: count() }).from(categoryDecisionsTable).where(eq(categoryDecisionsTable.transactionId, ids[key]!)))[0]!.n;
const memoryCount = async () =>
  (await db.select({ n: count() }).from(merchantMemoryTable).where(eq(merchantMemoryTable.householdId, hh())))[0]!.n;

const PAYROLL = "ORIG CO NAME:MAPLEWORKS INC CO ENTRY DESCR:PAYROLL SEC:PPD ORIG ID:7001";

beforeAll(async () => {
  HH[G] = await createTestHousehold(G);
  await cleanup();
  await seedAccount("chase", "Total Checking", "7701", "depository", "checking");
  await seedAccount("amex", "Gold Card", "7702", "credit", "credit card");
  for (const [key, name, kind] of [
    ["dining", "Dining & Coffee", "expense"],
    ["groceries", "Groceries", "expense"],
    ["paycheck", "Paycheck", "income"],
    ["transfer", "Transfer", "expense"],
  ] as const) {
    const [c] = await db.insert(budgetCategoriesTable).values({ userId: G, householdId: hh(), name, kind, groupName: "DG" }).returning();
    cat[key] = c!.id;
  }
  await seedTxn("payroll", "2026-09-25", PAYROLL, "2391.40", "chase");
  await seedTxn("payroll2", "2026-10-09", PAYROLL.replace("7001", "7002"), "2391.40", "chase");
  await seedTxn("cafe1", "2026-10-01", "MAPLEWORKS INC", "-8.50", "amex");
  await seedTxn("cafe2", "2026-10-08", "MAPLEWORKS INC", "-9.25", "amex");
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

const INFLOW = { error: "Money in, but this would file it under an expense category.", code: "direction_conflict", conflict: "inflow_into_expense" };

describe("PATCH /transactions/:id", () => {
  it("refuses a payroll credit → Dining: 409, the row, its decisions and memory untouched", async () => {
    const before = await rowOf("payroll");
    const r = await call("PATCH", `/transactions/${ids.payroll}`, { categoryId: cat.dining });
    expect(r).toEqual({ status: 409, body: INFLOW });
    expect(await rowOf("payroll")).toEqual(before);
    expect(await decisionsFor("payroll")).toBe(0);
    expect(await memoryCount()).toBe(0);
  });

  it("refuses a card purchase → Paycheck (money out under income)", async () => {
    const r = await call("PATCH", `/transactions/${ids.cafe1}`, { categoryId: cat.paycheck });
    expect(r).toMatchObject({ status: 409, body: { code: "direction_conflict", conflict: "outflow_into_income" } });
    expect((await rowOf("cafe1")).categoryId).toBeNull();
  });

  it("judges the row as the write leaves it: a stored transfer flag the pick clears is no excuse", async () => {
    await db.update(transactionsTable).set({ isTransfer: true }).where(eq(transactionsTable.id, ids.payroll2!));
    const r = await call("PATCH", `/transactions/${ids.payroll2}`, { categoryId: cat.dining });
    expect(r).toMatchObject({ status: 409, body: { conflict: "inflow_into_expense" } });
    expect(await rowOf("payroll2")).toMatchObject({ isTransfer: true, categoryId: null });
    await db.update(transactionsTable).set({ isTransfer: false }).where(eq(transactionsTable.id, ids.payroll2!));
  });

  it("still files the same-name card purchase to Dining, and the paycheck to Paycheck or Transfer", async () => {
    expect((await call("PATCH", `/transactions/${ids.cafe1}`, { categoryId: cat.dining })).status).toBe(200);
    expect(await rowOf("cafe1")).toMatchObject({ categoryId: cat.dining, categoryLockedByUser: true });
    expect((await call("PATCH", `/transactions/${ids.payroll}`, { categoryId: cat.paycheck })).status).toBe(200);
    expect((await rowOf("payroll")).categoryId).toBe(cat.paycheck);
    // Picking Transfer makes it a transfer — never a conflict.
    expect((await call("PATCH", `/transactions/${ids.payroll2}`, { categoryId: cat.transfer })).status).toBe(200);
    expect(await rowOf("payroll2")).toMatchObject({ categoryId: cat.transfer, isTransfer: true });
    // A PATCH that picks no category is not judged.
    expect((await call("PATCH", `/transactions/${ids.payroll2}`, { notes: "checked" })).status).toBe(200);
    // Put them back for the next blocks.
    await db
      .update(transactionsTable)
      .set({ categoryId: null, categoryLockedByUser: false, isTransfer: false })
      .where(inArray(transactionsTable.id, [ids.cafe1!, ids.payroll!, ids.payroll2!]));
  });
});

describe("POST /transactions/bulk-update", () => {
  it("one payroll credit in the selection refuses the whole Dining pick: 409 lists it, nothing written", async () => {
    const before = await Promise.all(["payroll", "cafe1", "cafe2"].map(rowOf));
    const decisions = await Promise.all(["payroll", "cafe1", "cafe2"].map(decisionsFor));
    const r = await call("POST", "/transactions/bulk-update", { ids: [ids.cafe1, ids.payroll, ids.cafe2], patch: { categoryId: cat.dining } });
    expect(r.status).toBe(409);
    // The DirectionRefusal schema: the first conflict in words, and every conflicting row.
    expect(r.body).toEqual({ ...INFLOW, conflicts: [{ id: ids.payroll, conflict: "inflow_into_expense" }] });
    expect(await Promise.all(["payroll", "cafe1", "cafe2"].map(rowOf))).toEqual(before);
    expect(await Promise.all(["payroll", "cafe1", "cafe2"].map(decisionsFor))).toEqual(decisions);
  });

  it("the card purchases alone file to Dining; a patch that marks them transfers is never judged against Paycheck", async () => {
    const r = await call("POST", "/transactions/bulk-update", { ids: [ids.cafe1, ids.cafe2], patch: { categoryId: cat.dining } });
    expect(r).toMatchObject({ status: 200, body: { updated: 2 } });
    expect((await rowOf("cafe2")).categoryId).toBe(cat.dining);
    const r2 = await call("POST", "/transactions/bulk-update", { ids: [ids.cafe1], patch: { categoryId: cat.paycheck, isTransfer: true } });
    expect(r2.status).toBe(200);
    await db
      .update(transactionsTable)
      .set({ categoryId: null, categoryLockedByUser: false, isTransfer: false, isTransferUserOverridden: false })
      .where(inArray(transactionsTable.id, [ids.cafe1!, ids.cafe2!]));
  });

  it("a bulk patch with no category pick is not judged", async () => {
    expect((await call("POST", "/transactions/bulk-update", { ids: [ids.payroll], patch: { reviewed: true } })).status).toBe(200);
  });
});

describe("POST /transactions/recategorize-by-pattern", () => {
  it("a pattern that matches the payroll credit and the cafeteria charges refuses Dining: 409, nothing moved, no rule re-pointed", async () => {
    const [rule] = await db
      .insert(mappingRulesTable)
      .values({ userId: G, householdId: hh(), pattern: "mapleworks", matchType: "contains", categoryId: cat.groceries })
      .returning();
    const before = await Promise.all(["payroll", "payroll2", "cafe1", "cafe2"].map(rowOf));
    const r = await call("POST", "/transactions/recategorize-by-pattern", {
      pattern: "mapleworks",
      matchType: "contains",
      fromCategoryId: null,
      toCategoryId: cat.dining,
      ruleId: rule!.id,
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("direction_conflict");
    expect(r.body.conflicts.map((c: Json) => c.id).sort()).toEqual([ids.payroll, ids.payroll2].sort());
    expect(await Promise.all(["payroll", "payroll2", "cafe1", "cafe2"].map(rowOf))).toEqual(before);
    const [after] = await db.select().from(mappingRulesTable).where(eq(mappingRulesTable.id, rule!.id));
    expect(after!.categoryId).toBe(cat.groceries);
    await db.delete(mappingRulesTable).where(eq(mappingRulesTable.id, rule!.id));
  });

  it("the cafeteria charges alone (the ids whitelist) move to Dining; their Undo is not judged", async () => {
    const r = await call("POST", "/transactions/recategorize-by-pattern", {
      pattern: "mapleworks",
      matchType: "contains",
      fromCategoryId: null,
      toCategoryId: cat.dining,
      ids: [ids.cafe1, ids.cafe2],
    });
    expect(r).toMatchObject({ status: 200, body: { updated: 2 } });
    expect((await rowOf("cafe1")).categoryId).toBe(cat.dining);
    // The payroll credit moved to Paycheck by hand, then a pattern pick of
    // Dining → Paycheck for it is fine; its Undo (lockedIds) restores Dining
    // exactly — an Undo is the row's own earlier filing, not a new pick.
    await db.update(transactionsTable).set({ categoryId: cat.dining }).where(eq(transactionsTable.id, ids.payroll!));
    const fwd = await call("POST", "/transactions/recategorize-by-pattern", {
      pattern: "mapleworks",
      matchType: "contains",
      fromCategoryId: cat.dining,
      toCategoryId: cat.paycheck,
      ids: [ids.payroll],
    });
    expect(fwd).toMatchObject({ status: 200, body: { updated: 1 } });
    const undo = await call("POST", "/transactions/recategorize-by-pattern", {
      pattern: "mapleworks",
      matchType: "contains",
      fromCategoryId: cat.paycheck,
      toCategoryId: cat.dining,
      ids: [ids.payroll],
      lockedIds: [],
    });
    expect(undo).toMatchObject({ status: 200, body: { updated: 1 } });
    await db
      .update(transactionsTable)
      .set({ categoryId: null, categoryLockedByUser: false, isTransferUserOverridden: false })
      .where(inArray(transactionsTable.id, [ids.cafe1!, ids.cafe2!, ids.payroll!]));
  });
});

describe("an approved agent set_category", () => {
  it("refuses the payroll credit → Dining (409 direction_conflict, nothing written); files the cafeteria charge", async () => {
    const [run] = await db.insert(agentRunsTable).values({ householdId: hh(), kind: "categorize", trigger: "user", status: "succeeded" }).returning();
    const who = { householdId: hh(), ownerUserId: G, actorUserId: G, isOwner: true };
    const proposal = (txnKey: string, categoryKey: string) =>
      ({ id: randomUUID(), householdId: hh(), runId: run!.id, kind: "set_category", payload: { txnId: ids[txnKey], categoryId: cat[categoryKey] } }) as unknown as AgentProposal;
    const before = await rowOf("payroll");
    expect(await applyProposal(proposal("payroll", "dining"), who)).toEqual({
      ok: false,
      status: 409,
      error: INFLOW.error,
      code: "direction_conflict",
    });
    expect(await rowOf("payroll")).toEqual(before);
    expect((await db.select({ n: count() }).from(agentActionsTable).where(eq(agentActionsTable.householdId, hh())))[0]!.n).toBe(0);
    const ok = await applyProposal(proposal("cafe1", "dining"), who);
    expect(ok).toMatchObject({ ok: true });
    expect(await rowOf("cafe1")).toMatchObject({ categoryId: cat.dining, categoryLockedByUser: true });
    const actions = await db.select().from(agentActionsTable).where(and(eq(agentActionsTable.householdId, hh())));
    expect(actions).toHaveLength(1);
  });
});
