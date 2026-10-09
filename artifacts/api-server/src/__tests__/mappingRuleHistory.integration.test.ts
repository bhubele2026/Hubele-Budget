// (WP5b) The mapping-rule audit trail.
//
// Root cause 6 of the financial-consistency plan: the seeded payroll rule was
// most likely re-pointed to Dining by the old hand-filing flow, and nothing in
// the database could say when, by what, or from where — `mapping_rules` had no
// updated_at and no history. Every rule writer now records one
// `mapping_rule_history` row per rule it changed, in the SAME transaction as
// the write. This file drives each writer against a real Postgres:
//
//   routes/mapping.ts        POST · PATCH · DELETE · PUT /reorder · GET history
//   routes/transactions.ts   recategorize-by-pattern's `ruleId` re-point
//   routes/budget.ts         the seed loop (through prepareBudgetCategories)
//   lib/workbookImporter.ts  + lib/importSnapshot.ts (import, then restore)
//   lib/db upsertMappingRule (the recategorize script's path)
//
// "Same transaction" is proven by Postgres itself: `now()` is the transaction's
// start time, so a history row whose created_at equals the rule's created_at
// (POST) or updated_at (PATCH) was written by the same transaction.
//
// The legacy category merge in routes/budget.ts is recorded too, but cannot
// run today (a rule on the old category keeps that category in place), so it
// has no case here.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import { asc, eq, inArray, sql } from "drizzle-orm";
import * as XLSX from "xlsx";

let CURRENT_USER = "";
let CURRENT_HOUSEHOLD = "";

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
    req.userId = CURRENT_USER;
    req.actualUserId = CURRENT_USER;
    req.householdId = CURRENT_HOUSEHOLD;
    req.householdOwnerId = CURRENT_USER;
    next();
  },
}));

import {
  db,
  pool,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  debtsTable,
  householdMembersTable,
  importBatchesTable,
  importSnapshotsTable,
  mappingRuleHistoryTable,
  mappingRulesTable,
  monthlySnapshotsTable,
  recurringItemsTable,
  settingsTable,
  transactionsTable,
  upsertMappingRule,
} from "@workspace/db";
import mappingRouter from "../routes/mapping";
import transactionsRouter from "../routes/transactions";
import { prepareBudgetCategories } from "../routes/budget";
import { importWorkbook } from "../lib/workbookImporter";
import { restoreImportSnapshot } from "../lib/importSnapshot";
import {
  RULE_HISTORY_LIMIT,
  SEED_ACTOR,
  recordRuleChanges,
  type RuleChange,
} from "../lib/mappingRuleAudit";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";

const routes = express.Router();
routes.use(mappingRouter);
routes.use(transactionsRouter);
const { request } = createTestApp(routes);

const tag = () => `${process.pid}-${randomUUID().slice(0, 8)}`;
const USER_A = `rulehist-a-${tag()}`;
const USER_A2 = `rulehist-a2-${tag()}`; // a second member of household A
const USER_B = `rulehist-b-${tag()}`; // another household
const USER_SEED = `rulehist-seed-${tag()}`;
const USER_WB = `rulehist-wb-${tag()}`;
let HH_A: string;
let HH_B: string;
let HH_SEED: string;
let HH_WB: string;
let CAT_A: string;
let CAT_B: string;
let CAT_EXCLUDED: string;
let CAT_FOREIGN: string;

function as(user: string, household: string): void {
  CURRENT_USER = user;
  CURRENT_HOUSEHOLD = household;
}

type Snap = { pattern: string; matchType: string; categoryId: string | null; priority: number };
type Entry = {
  id: string;
  ruleId: string;
  action: string;
  actor: string;
  actorKind: string;
  byYou: boolean;
  previous: Snap | null;
  next: Snap | null;
  note: string | null;
  createdAt: string;
};
type RuleJson = Snap & { id: string; updatedAt: string | null };

async function historyRows(ruleId: string) {
  return db
    .select()
    .from(mappingRuleHistoryTable)
    .where(eq(mappingRuleHistoryTable.ruleId, ruleId))
    .orderBy(asc(mappingRuleHistoryTable.createdAt));
}

async function historyCount(householdId: string): Promise<number> {
  const rows = await db
    .select({ id: mappingRuleHistoryTable.id })
    .from(mappingRuleHistoryTable)
    .where(eq(mappingRuleHistoryTable.householdId, householdId));
  return rows.length;
}

async function ruleRow(id: string) {
  const [row] = await db.select().from(mappingRulesTable).where(eq(mappingRulesTable.id, id));
  return row;
}

/** A rule written straight to the table (no history), for the edit cases. */
async function insertRule(
  pattern: string,
  categoryId: string | null,
  priority: number,
  householdId = HH_A,
  userId = USER_A,
): Promise<string> {
  const [row] = await db
    .insert(mappingRulesTable)
    .values({ userId, householdId, pattern, matchType: "contains", categoryId, priority })
    .returning({ id: mappingRulesTable.id });
  return row!.id;
}

async function post(body: Record<string, unknown>): Promise<RuleJson> {
  const res = await request("POST", "/mapping-rules", body);
  expect(res.status).toBe(201);
  return res.json as RuleJson;
}

async function getHistory(ruleId: string) {
  return request("GET", `/mapping-rules/${ruleId}/history`) as Promise<{
    status: number;
    json: { ruleId: string; entries: Entry[]; truncated: boolean };
  }>;
}

/** True when the two timestamps are the same instant, compared by Postgres (µs). */
async function sameInstant(historyId: string, ruleId: string, column: "created_at" | "updated_at") {
  const { rows } = await pool.query<{ same: boolean }>(
    `SELECT h.created_at = r.${column} AS same
       FROM mapping_rule_history h, mapping_rules r
      WHERE h.id = $1 AND r.id = $2`,
    [historyId, ruleId],
  );
  return rows[0]?.same === true;
}

async function wipeUserData(user: string, household: string): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.householdId, household));
  await db.delete(mappingRulesTable).where(eq(mappingRulesTable.householdId, household));
  await db.delete(mappingRuleHistoryTable).where(eq(mappingRuleHistoryTable.householdId, household));
  await db.delete(budgetLinesTable).where(eq(budgetLinesTable.householdId, household));
  await db.delete(budgetMonthsTable).where(eq(budgetMonthsTable.householdId, household));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.householdId, household));
  await db.delete(monthlySnapshotsTable).where(eq(monthlySnapshotsTable.householdId, household));
  await db.delete(debtsTable).where(eq(debtsTable.householdId, household));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.householdId, household));
  await db.delete(importSnapshotsTable).where(eq(importSnapshotsTable.userId, user));
  await db.delete(importBatchesTable).where(eq(importBatchesTable.userId, user));
  await db.delete(settingsTable).where(eq(settingsTable.userId, user));
}

beforeAll(async () => {
  HH_A = (await createTestHousehold(USER_A)).householdId;
  HH_B = (await createTestHousehold(USER_B)).householdId;
  HH_SEED = (await createTestHousehold(USER_SEED)).householdId;
  HH_WB = (await createTestHousehold(USER_WB)).householdId;
  await db
    .insert(householdMembersTable)
    .values({ userId: USER_A2, householdId: HH_A, role: "member" })
    .onConflictDoNothing({ target: householdMembersTable.userId });
  const cats = await db
    .insert(budgetCategoriesTable)
    .values([
      { userId: USER_A, householdId: HH_A, name: `Paycheck ${tag()}`, kind: "income" },
      { userId: USER_A, householdId: HH_A, name: `Dining ${tag()}`, kind: "expense" },
      {
        userId: USER_A,
        householdId: HH_A,
        name: `Excluded ${tag()}`,
        kind: "expense",
        excludeFromBudget: true,
      },
      { userId: USER_B, householdId: HH_B, name: `Other household ${tag()}`, kind: "expense" },
    ])
    .returning({ id: budgetCategoriesTable.id });
  [CAT_A, CAT_B, CAT_EXCLUDED, CAT_FOREIGN] = cats.map((c) => c.id) as [string, string, string, string];
});

afterAll(async () => {
  for (const [u, h] of [
    [USER_A, HH_A],
    [USER_B, HH_B],
    [USER_SEED, HH_SEED],
    [USER_WB, HH_WB],
  ] as const) {
    await wipeUserData(u, h);
  }
  await db.delete(householdMembersTable).where(eq(householdMembersTable.userId, USER_A2));
});

beforeEach(async () => {
  as(USER_A, HH_A);
  for (const h of [HH_A, HH_B]) {
    await db.delete(transactionsTable).where(eq(transactionsTable.householdId, h));
    await db.delete(mappingRulesTable).where(eq(mappingRulesTable.householdId, h));
    await db.delete(mappingRuleHistoryTable).where(eq(mappingRuleHistoryTable.householdId, h));
  }
});

describe("POST /mapping-rules", () => {
  it("records 'created' with the rule's state, the actor and the trimmed note — in the rule's own transaction", async () => {
    const rule = await post({
      pattern: "BIGCO CAFE",
      matchType: "contains",
      categoryId: CAT_B,
      priority: 40,
      note: "  the office cafeteria  ",
    });
    // A new rule has not been edited.
    expect(rule.updatedAt).toBeNull();
    // The note is history, never a column on the rule.
    expect(rule).not.toHaveProperty("note");

    const rows = await historyRows(rule.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      householdId: HH_A,
      ruleId: rule.id,
      action: "created",
      actor: USER_A,
      previous: null,
      next: { pattern: "BIGCO CAFE", matchType: "contains", categoryId: CAT_B, priority: 40 },
      note: "the office cafeteria",
    });
    // SQL NULL, not a JSON null.
    const { rows: nulls } = await pool.query<{ prev_null: boolean }>(
      `SELECT previous IS NULL AS prev_null FROM mapping_rule_history WHERE id = $1`,
      [rows[0]!.id],
    );
    expect(nulls[0]!.prev_null).toBe(true);
    expect(await sameInstant(rows[0]!.id, rule.id, "created_at")).toBe(true);
  });

  it("a rejected rule (excluded category) records nothing", async () => {
    const res = await request("POST", "/mapping-rules", { pattern: "NOPE", categoryId: CAT_EXCLUDED });
    expect(res.status).toBe(400);
    expect(await historyCount(HH_A)).toBe(0);
  });

  it("a note over 500 characters is refused before anything is written", async () => {
    const res = await request("POST", "/mapping-rules", {
      pattern: "LONG NOTE",
      categoryId: CAT_A,
      note: "x".repeat(501),
    });
    expect(res.status).toBe(400);
    expect(await historyCount(HH_A)).toBe(0);
    const rules = await db.select().from(mappingRulesTable).where(eq(mappingRulesTable.householdId, HH_A));
    expect(rules).toEqual([]);
  });
});

describe("PATCH /mapping-rules/:id", () => {
  it("a real edit stamps updated_at and records previous → next with the note, in one transaction", async () => {
    // The seeded payroll rule, re-pointed to Dining (root cause 6) and put back.
    const id = await insertRule("EXACT SCIENCES", CAT_B, 50);
    const res = await request("PATCH", `/mapping-rules/${id}`, {
      pattern: "EXACT SCIENCES",
      matchType: "contains",
      categoryId: CAT_A,
      priority: 50,
      note: "Back to the paycheck; the old hand-filing flow had moved it.",
    });
    expect(res.status).toBe(200);
    const body = res.json as RuleJson;
    expect(body.categoryId).toBe(CAT_A);
    expect(body.updatedAt).not.toBeNull();

    const rows = await historyRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "updated",
      actor: USER_A,
      previous: { pattern: "EXACT SCIENCES", matchType: "contains", categoryId: CAT_B, priority: 50 },
      next: { pattern: "EXACT SCIENCES", matchType: "contains", categoryId: CAT_A, priority: 50 },
      note: "Back to the paycheck; the old hand-filing flow had moved it.",
    });
    expect(await sameInstant(rows[0]!.id, id, "updated_at")).toBe(true);
  });

  it("a PATCH that changes nothing writes nothing — no stamp, no row, note or not", async () => {
    const id = await insertRule("KROGER", CAT_B, 30);
    const res = await request("PATCH", `/mapping-rules/${id}`, {
      pattern: "KROGER",
      matchType: "contains",
      categoryId: CAT_B,
      priority: 30,
      note: "Just looking.",
    });
    expect(res.status).toBe(200);
    expect((res.json as RuleJson).updatedAt).toBeNull();
    expect((await ruleRow(id))!.updatedAt).toBeNull();
    expect(await historyRows(id)).toEqual([]);
  });

  it("an omitted field keeps its value; an explicit null category clears it (and is recorded)", async () => {
    const id = await insertRule("SHELL OIL", CAT_B, 20);
    // Only the pattern changes: category, match type and priority are kept.
    let res = await request("PATCH", `/mapping-rules/${id}`, { pattern: "SHELL OIL 57" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ pattern: "SHELL OIL 57", categoryId: CAT_B, matchType: "contains", priority: 20 });
    res = await request("PATCH", `/mapping-rules/${id}`, { pattern: "SHELL OIL 57", categoryId: null });
    expect(res.status).toBe(200);
    expect((res.json as RuleJson).categoryId).toBeNull();

    const rows = await historyRows(id);
    expect(rows.map((r) => r.action)).toEqual(["updated", "updated"]);
    expect(rows[0]!.previous).toMatchObject({ pattern: "SHELL OIL", categoryId: CAT_B });
    expect(rows[0]!.next).toMatchObject({ pattern: "SHELL OIL 57", categoryId: CAT_B });
    expect(rows[1]!.previous).toMatchObject({ pattern: "SHELL OIL 57", categoryId: CAT_B });
    expect(rows[1]!.next).toMatchObject({ pattern: "SHELL OIL 57", categoryId: null });
  });

  it("another household's rule: 404, unchanged, nothing recorded", async () => {
    const foreign = await insertRule("THEIR RULE", CAT_FOREIGN, 10, HH_B, USER_B);
    const res = await request("PATCH", `/mapping-rules/${foreign}`, { pattern: "MINE NOW", categoryId: CAT_A });
    expect(res.status).toBe(404);
    expect(await ruleRow(foreign)).toMatchObject({ pattern: "THEIR RULE", categoryId: CAT_FOREIGN, updatedAt: null });
    expect(await historyRows(foreign)).toEqual([]);
  });

  it("a rejected edit (excluded category) changes and records nothing", async () => {
    const id = await insertRule("ATM FEE", CAT_B, 10);
    const res = await request("PATCH", `/mapping-rules/${id}`, { pattern: "ATM FEE", categoryId: CAT_EXCLUDED });
    expect(res.status).toBe(400);
    expect((await ruleRow(id))!.categoryId).toBe(CAT_B);
    expect(await historyRows(id)).toEqual([]);
  });
});

describe("DELETE /mapping-rules/:id", () => {
  it("records 'deleted' with the rule as it was; the history outlives the rule and still reads back", async () => {
    const rule = await post({ pattern: "OLD GYM", categoryId: CAT_B, priority: 15 });
    const res = await request("DELETE", `/mapping-rules/${rule.id}`);
    expect(res.status).toBe(204);
    expect(await ruleRow(rule.id)).toBeUndefined();

    const rows = await historyRows(rule.id);
    expect(rows.map((r) => r.action)).toEqual(["created", "deleted"]);
    expect(rows[1]).toMatchObject({
      actor: USER_A,
      previous: { pattern: "OLD GYM", matchType: "contains", categoryId: CAT_B, priority: 15 },
      next: null,
    });

    const hist = await getHistory(rule.id);
    expect(hist.status).toBe(200);
    expect(hist.json.entries.map((e) => e.action)).toEqual(["deleted", "created"]);
  });

  it("deleting another household's rule (or no rule) records nothing", async () => {
    const foreign = await insertRule("THEIR GYM", CAT_FOREIGN, 10, HH_B, USER_B);
    expect((await request("DELETE", `/mapping-rules/${foreign}`)).status).toBe(204);
    expect((await request("DELETE", `/mapping-rules/${randomUUID()}`)).status).toBe(204);
    expect(await ruleRow(foreign)).toBeDefined();
    expect(await historyCount(HH_A)).toBe(0);
    expect(await historyCount(HH_B)).toBe(0);
  });
});

describe("PUT /mapping-rules/reorder", () => {
  it("records 'reordered' only for rules whose priority moved, and does not stamp updated_at", async () => {
    const a = await insertRule("ALPHA", CAT_A, 30);
    const b = await insertRule("BRAVO", CAT_A, 20);
    const c = await insertRule("CHARLIE", CAT_B, 10);
    const foreign = await insertRule("THEIRS", CAT_FOREIGN, 99, HH_B, USER_B);
    // base = 0 + 10 × (3 + 1) = 40 → CHARLIE 40, ALPHA 30, BRAVO 20: only CHARLIE moves.
    const res = await request("PUT", "/mapping-rules/reorder", { orderedIds: [c, a, foreign, b] });
    expect(res.status).toBe(200);
    expect((res.json as RuleJson[]).map((r) => [r.pattern, r.priority])).toEqual([
      ["CHARLIE", 40],
      ["ALPHA", 30],
      ["BRAVO", 20],
    ]);

    expect(await historyRows(a)).toEqual([]);
    expect(await historyRows(b)).toEqual([]);
    expect(await historyRows(foreign)).toEqual([]);
    const rows = await historyRows(c);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "reordered",
      actor: USER_A,
      previous: { pattern: "CHARLIE", matchType: "contains", categoryId: CAT_B, priority: 10 },
      next: { pattern: "CHARLIE", matchType: "contains", categoryId: CAT_B, priority: 40 },
    });
    // A reorder is not an edit: no rule shows "edited".
    for (const id of [a, b, c]) expect((await ruleRow(id))!.updatedAt).toBeNull();
    expect((await ruleRow(foreign))!.priority).toBe(99);

    // The same order again moves nothing and records nothing.
    expect((await request("PUT", "/mapping-rules/reorder", { orderedIds: [c, a, b] })).status).toBe(200);
    expect(await historyCount(HH_A)).toBe(1);
  });
});

describe("POST /transactions/recategorize-by-pattern with a ruleId (the Undo re-point)", () => {
  it("re-points the rule as an edit: stamps updated_at and records it with a note", async () => {
    const id = await insertRule("BIGCO PAYROLL", CAT_B, 50);
    const res = await request("POST", "/transactions/recategorize-by-pattern", {
      pattern: "BIGCO PAYROLL",
      matchType: "contains",
      fromCategoryId: CAT_B,
      toCategoryId: CAT_A,
      ruleId: id,
    });
    expect(res.status).toBe(200);
    const after = await ruleRow(id);
    expect(after!.categoryId).toBe(CAT_A);
    expect(after!.updatedAt).not.toBeNull();
    const rows = await historyRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "updated",
      actor: USER_A,
      previous: { categoryId: CAT_B },
      next: { categoryId: CAT_A },
      note: "Re-pointed together with a bulk move of past charges.",
    });
    expect(await sameInstant(rows[0]!.id, id, "updated_at")).toBe(true);
  });

  it("a rule already on the target, or another household's rule, is left alone and records nothing", async () => {
    const same = await insertRule("ALREADY THERE", CAT_A, 10);
    const foreign = await insertRule("THEIR PAYROLL", CAT_FOREIGN, 10, HH_B, USER_B);
    for (const ruleId of [same, foreign]) {
      const res = await request("POST", "/transactions/recategorize-by-pattern", {
        pattern: "NOTHING MATCHES THIS",
        matchType: "contains",
        fromCategoryId: CAT_B,
        toCategoryId: CAT_A,
        ruleId,
      });
      expect(res.status).toBe(200);
    }
    expect((await ruleRow(same))!.updatedAt).toBeNull();
    expect((await ruleRow(foreign))!.categoryId).toBe(CAT_FOREIGN);
    expect(await historyCount(HH_A)).toBe(0);
    expect(await historyCount(HH_B)).toBe(0);
  });
});

describe("GET /mapping-rules/:id/history", () => {
  it("lists the rule's changes newest first, says who made each, and is scoped to the household", async () => {
    const rule = await post({ pattern: "NETFLIX", categoryId: CAT_B, priority: 10, note: "streaming" });
    // A second member edits it.
    as(USER_A2, HH_A);
    expect(
      (await request("PATCH", `/mapping-rules/${rule.id}`, { pattern: "NETFLIX", categoryId: CAT_A })).status,
    ).toBe(200);

    // The first member reads it.
    as(USER_A, HH_A);
    let hist = await getHistory(rule.id);
    expect(hist.status).toBe(200);
    expect(hist.json.ruleId).toBe(rule.id);
    expect(hist.json.truncated).toBe(false);
    expect(hist.json.entries.map((e) => [e.action, e.actor, e.actorKind, e.byYou])).toEqual([
      ["updated", USER_A2, "person", false],
      ["created", USER_A, "person", true],
    ]);
    expect(hist.json.entries[1]).toMatchObject({ previous: null, note: "streaming" });
    expect(hist.json.entries[0]).toMatchObject({
      previous: { categoryId: CAT_B },
      next: { categoryId: CAT_A },
      note: null,
    });
    expect(Number.isNaN(Date.parse(hist.json.entries[0]!.createdAt))).toBe(false);

    // The second member sees the same history from their side.
    as(USER_A2, HH_A);
    hist = await getHistory(rule.id);
    expect(hist.json.entries.map((e) => e.byYou)).toEqual([true, false]);

    // Another household has no history for this id.
    as(USER_B, HH_B);
    hist = await getHistory(rule.id);
    expect(hist.status).toBe(200);
    expect(hist.json.entries).toEqual([]);
  });

  it("refuses an id that is not a uuid", async () => {
    expect((await request("GET", "/mapping-rules/not-a-uuid/history")).status).toBe(400);
  });

  it(`returns the newest ${RULE_HISTORY_LIMIT} and says when there were more`, async () => {
    const id = await insertRule("BUSY RULE", CAT_A, 10);
    const state = { pattern: "BUSY RULE", matchType: "contains", categoryId: CAT_A, priority: 10 };
    const changes: RuleChange[] = Array.from({ length: RULE_HISTORY_LIMIT + 1 }, (_, i) => ({
      householdId: HH_A,
      ruleId: id,
      action: "reordered",
      actor: USER_A,
      previous: { ...state, priority: i },
      next: { ...state, priority: i + 1 },
    }));
    await recordRuleChanges(db, changes);
    const hist = await getHistory(id);
    expect(hist.json.entries).toHaveLength(RULE_HISTORY_LIMIT);
    expect(hist.json.truncated).toBe(true);
  });
});

describe("the seed", () => {
  it("records every starter rule as 'seeded' by the seed, matching the rule it wrote", async () => {
    await wipeUserData(USER_SEED, HH_SEED);
    await prepareBudgetCategories(HH_SEED, USER_SEED, USER_SEED);
    const rules = await db.select().from(mappingRulesTable).where(eq(mappingRulesTable.householdId, HH_SEED));
    expect(rules.length).toBeGreaterThan(0);
    const rows = await db
      .select()
      .from(mappingRuleHistoryTable)
      .where(eq(mappingRuleHistoryTable.householdId, HH_SEED));
    expect(rows).toHaveLength(rules.length);
    const byRule = new Map(rows.map((r) => [r.ruleId, r]));
    for (const rule of rules) {
      expect(byRule.get(rule.id)).toMatchObject({
        action: "seeded",
        actor: SEED_ACTOR,
        previous: null,
        next: {
          pattern: rule.pattern,
          matchType: rule.matchType,
          categoryId: rule.categoryId,
          priority: rule.priority,
        },
      });
      // Seeding is not an edit.
      expect(rule.updatedAt).toBeNull();
    }
    expect(rules.map((r) => r.pattern)).toContain("EXACT SCIENCES");

    // A second pass seeds nothing and records nothing.
    await prepareBudgetCategories(HH_SEED, USER_SEED, USER_SEED);
    expect(await historyCount(HH_SEED)).toBe(rows.length);
  });
});

function buildWorkbook(): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const pad = (n: number, label: string): unknown[][] => Array.from({ length: n }, () => [label]);
  const add = (rows: unknown[][], name: string) =>
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  add(pad(4, "DT"), "Debt Tracker");
  add([...pad(5, "MB"), [1, "Coffee", 50, null, null, null, null]], "Monthly Budget");
  add(pad(5, "RI"), "Recurring Items");
  add([...pad(4, "MAP"), ["CAFE", "Coffee"]], "Mapping");
  add([...pad(5, "PAY"), [null, "2026-03-05", "CAFE CORNER 7", "Expense", null, 4.5, null, null]], "Payments");
  return wb;
}

describe("a workbook import, then its snapshot restore", () => {
  it("records the import's wipe and re-insert, and the restore as the difference it makes", async () => {
    await wipeUserData(USER_WB, HH_WB);
    as(USER_WB, HH_WB);
    const mine = await post({ pattern: "MY OWN RULE", priority: 5 });

    const [batch] = await db
      .insert(importBatchesTable)
      .values({ userId: USER_WB, householdId: HH_WB, filename: "rules.xlsx" })
      .returning();
    const result = await importWorkbook(USER_WB, HH_WB, buildWorkbook(), batch!.id);

    // The wipe: my rule is deleted by the import...
    let mineRows = await historyRows(mine.id);
    expect(mineRows.map((r) => [r.action, r.note])).toEqual([
      ["created", null],
      ["deleted", "Replaced by a workbook import."],
    ]);
    expect(mineRows[1]!.actor).toBe(USER_WB);

    // ...and the import's rules are created under new ids: the sheet's CAFE,
    // and my rule carried over.
    const imported = await db.select().from(mappingRulesTable).where(eq(mappingRulesTable.householdId, HH_WB));
    expect(imported.map((r) => r.pattern).sort()).toEqual(["CAFE", "MY OWN RULE"]);
    const importedRows = await db
      .select()
      .from(mappingRuleHistoryTable)
      .where(inArray(mappingRuleHistoryTable.ruleId, imported.map((r) => r.id)));
    expect(
      importedRows.map((r) => [imported.find((i) => i.id === r.ruleId)!.pattern, r.action, r.note]).sort(),
    ).toEqual([
      ["CAFE", "created", "From the workbook's Mapping sheet."],
      ["MY OWN RULE", "created", "Kept from before the workbook import."],
    ]);

    // The restore deletes the import's rules and brings mine back under its
    // original id, so that rule's history reads as one story.
    const restored = await restoreImportSnapshot(result.snapshotId!, USER_WB);
    expect(restored.ok).toBe(true);
    const after = await db.select().from(mappingRulesTable).where(eq(mappingRulesTable.householdId, HH_WB));
    expect(after.map((r) => r.id)).toEqual([mine.id]);
    mineRows = await historyRows(mine.id);
    expect(mineRows.map((r) => [r.action, r.note])).toEqual([
      ["created", null],
      ["deleted", "Replaced by a workbook import."],
      ["created", "Restored from the snapshot taken before a workbook import."],
    ]);
    expect(mineRows[2]!.next).toMatchObject({ pattern: "MY OWN RULE", priority: 5 });
    for (const r of imported) {
      const rows = await historyRows(r.id);
      expect(rows.map((x) => [x.action, x.note])).toEqual([
        ["created", expect.any(String)],
        ["deleted", "Restored from the snapshot taken before a workbook import."],
      ]);
    }
  });
});

describe("lib/db upsertMappingRule (the recategorize script's path)", () => {
  it("hands back the before/after for the caller to record, and stamps updated_at on an update only", async () => {
    const base = { userId: USER_A, householdId: HH_A, pattern: "UPSERT CO", matchType: "contains" as const };
    const ins = await upsertMappingRule(db, { ...base, categoryId: CAT_A, priority: 100 });
    expect(ins).toMatchObject({
      status: "inserted",
      previous: null,
      next: { pattern: "UPSERT CO", matchType: "contains", categoryId: CAT_A, priority: 100 },
    });
    expect((await ruleRow(ins.ruleId!))!.updatedAt).toBeNull();

    const noop = await upsertMappingRule(db, { ...base, categoryId: CAT_A, priority: 50 });
    expect(noop).toEqual({ status: "noop", ruleId: ins.ruleId, previous: null, next: null });
    expect((await ruleRow(ins.ruleId!))!.updatedAt).toBeNull();

    const upd = await upsertMappingRule(db, { ...base, categoryId: CAT_B, priority: 50 });
    expect(upd).toMatchObject({
      status: "updated",
      ruleId: ins.ruleId,
      previous: { categoryId: CAT_A, priority: 100 },
      next: { categoryId: CAT_B, priority: 100 },
    });
    expect((await ruleRow(ins.ruleId!))!.updatedAt).not.toBeNull();
  });
});

describe("the history refuses what does not fit", () => {
  it("recordRuleChanges throws on a change whose before/after does not fit its action, writing nothing", async () => {
    const s = { pattern: "X", matchType: "contains", categoryId: null, priority: 0 };
    const bad: RuleChange[] = [
      { householdId: HH_A, ruleId: randomUUID(), action: "created", actor: USER_A, previous: s, next: s },
      { householdId: HH_A, ruleId: randomUUID(), action: "seeded", actor: SEED_ACTOR, previous: null, next: null },
      { householdId: HH_A, ruleId: randomUUID(), action: "deleted", actor: USER_A, previous: s, next: s },
      { householdId: HH_A, ruleId: randomUUID(), action: "updated", actor: USER_A, previous: null, next: s },
      { householdId: HH_A, ruleId: randomUUID(), action: "reordered", actor: USER_A, previous: s, next: null },
      { householdId: HH_A, ruleId: randomUUID(), action: "updated", actor: "", previous: s, next: s },
    ];
    for (const change of bad) {
      await expect(recordRuleChanges(db, [change])).rejects.toThrow(/mapping rule history/);
    }
    expect(await historyCount(HH_A)).toBe(0);
  });

  it("the database accepts only the five actions", async () => {
    await expect(
      db.execute(sql`INSERT INTO mapping_rule_history (household_id, rule_id, action, actor)
                     VALUES (${HH_A}, ${randomUUID()}, 'renamed', 'x')`),
    ).rejects.toThrow();
    expect(await historyCount(HH_A)).toBe(0);
  });

  it("a history row needs a real household", async () => {
    await expect(
      recordRuleChanges(db, [
        {
          householdId: randomUUID(),
          ruleId: randomUUID(),
          action: "deleted",
          actor: USER_A,
          previous: { pattern: "X", matchType: "contains", categoryId: null, priority: 0 },
          next: null,
        },
      ]),
    ).rejects.toThrow();
  });
});

describe("GET /mapping-rules carries updatedAt", () => {
  it("null until an edit, then the edit's time", async () => {
    const id = await insertRule("SPOTIFY", CAT_B, 10);
    let list = (await request("GET", "/mapping-rules")).json as RuleJson[];
    expect(list.find((r) => r.id === id)!.updatedAt).toBeNull();
    await request("PATCH", `/mapping-rules/${id}`, { pattern: "SPOTIFY", categoryId: CAT_A });
    list = (await request("GET", "/mapping-rules")).json as RuleJson[];
    const edited = list.find((r) => r.id === id)!;
    expect(edited.updatedAt).not.toBeNull();
    const [h] = await historyRows(id);
    expect(new Date(edited.updatedAt!).getTime()).toBe(h!.createdAt.getTime());
  });
});
