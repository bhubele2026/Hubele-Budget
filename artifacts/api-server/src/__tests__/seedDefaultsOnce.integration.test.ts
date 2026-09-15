import { describe, it, expect, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import { and, asc, eq, inArray } from "drizzle-orm";

/**
 * Owner decision 3, extended: repeated deployments must never delete user
 * categories, and must never re-create ones the household deleted.
 *
 * GET /budget/categories seeds the household's defaults once per process, so
 * once after every deploy. It used to seed whenever any seed category name was
 * missing, which re-inserted a deleted category, the bills matched by name, the
 * mapping rules and the May 2026 lines. It now seeds only a household that has
 * never been seeded and holds no data of its own, and records that in the
 * server-owned preference `defaultsSeededAt`.
 *
 * A deploy is simulated by clearing the in-process gates
 * (`_resetBudgetOneTimePassGatesForTests`). Everything goes through the real
 * budget, recurring-items and settings routers against a real Postgres.
 */

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
  avalancheSettingsTable,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  debtsTable,
  mappingRulesTable,
  recurringItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import budgetRouter, { _resetBudgetOneTimePassGatesForTests } from "../routes/budget";
import recurringRouter from "../routes/recurring";
import settingsRouter from "../routes/settings";
import { SEED_CATEGORIES, SEED_RECURRING_ITEMS } from "../lib/budgetSeed";
import { SEED_MAPPING_RULES } from "../lib/mappingSeed";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";

const routes = express.Router();
routes.use(budgetRouter);
routes.use(recurringRouter);
routes.use(settingsRouter);
const { request } = createTestApp(routes);

const OWNERS: string[] = [];
const MAY_2026 = "2026-05-01";
const SEPT_2026 = "2026-09-01";
const ANCHOR = { balance: 4321.09, asOf: "2026-09-10T15:04:05.000Z", lastAutoBalance: 4321.09 };
const OVERRIDES = { "2026-08-30": "150.00", "2026-09-06": "175.00" };
// The rows the ensure passes add on every first read, whatever the seed does.
const SYSTEM_NAMES = new Set(["Uncategorized", "Transfer", "Ignore"]);

async function newHousehold(label: string): Promise<void> {
  const user = `seed-once-${label}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const { householdId } = await createTestHousehold(user);
  OWNERS.push(user);
  CURRENT_USER = user;
  CURRENT_HOUSEHOLD = householdId;
}

/** What a deploy does to this router: every once-per-process gate is empty. */
function deploy(): void {
  _resetBudgetOneTimePassGatesForTests();
}

async function setPrefs(preferences: Record<string, unknown>): Promise<void> {
  await db
    .insert(settingsTable)
    .values({ userId: CURRENT_USER, householdId: CURRENT_HOUSEHOLD, preferences })
    .onConflictDoUpdate({ target: settingsTable.userId, set: { preferences } });
}

async function prefs(): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ preferences: settingsTable.preferences })
    .from(settingsTable)
    .where(eq(settingsTable.userId, CURRENT_USER));
  return (row?.preferences as Record<string, unknown> | null) ?? {};
}

type CategoryRow = { id: string; name: string; groupName: string; sortOrder: number };

async function getCategories(): Promise<CategoryRow[]> {
  const res = await request("GET", "/budget/categories");
  expect(res.status).toBe(200);
  return res.json as CategoryRow[];
}

type MonthLine = {
  categoryName: string;
  plannedAmount: string;
  planSource: string;
  plannedSource: { kind: string };
  pinned: boolean;
  sourceKind: string;
  kind: string;
};
type MonthBody = {
  monthPinned: boolean;
  lines: MonthLine[];
  groups: Array<{ groupName: string; plannedTotal: string; lines: MonthLine[] }>;
  summary: Record<string, { budget: string }>;
  planBySource: unknown;
};

async function getMonth(month: string): Promise<MonthBody> {
  const res = await request("GET", `/budget/months/${month}`);
  expect(res.status).toBe(200);
  return res.json as MonthBody;
}

function plannedOf(body: MonthBody, categoryName: string): string | undefined {
  return body.lines.find((l) => l.categoryName === categoryName)?.plannedAmount;
}

function groupOf(body: MonthBody, groupName: string) {
  return body.groups.find((g) => g.groupName === groupName)!;
}

async function insertCategory(
  name: string,
  opts: { groupName?: string; sourceKind?: "manual" | "auto_bills" } = {},
): Promise<string> {
  const [row] = await db
    .insert(budgetCategoriesTable)
    .values({
      userId: CURRENT_USER,
      householdId: CURRENT_HOUSEHOLD,
      name,
      groupName: opts.groupName ?? "Other",
      kind: "expense",
      sourceKind: opts.sourceKind ?? "manual",
      sortOrder: 0,
    })
    .returning({ id: budgetCategoriesTable.id });
  return row!.id;
}

async function insertLine(categoryId: string, monthStart: string, plannedAmount: string): Promise<void> {
  await db
    .insert(budgetMonthsTable)
    .values({ userId: CURRENT_USER, householdId: CURRENT_HOUSEHOLD, monthStart })
    .onConflictDoNothing();
  await db.insert(budgetLinesTable).values({
    userId: CURRENT_USER,
    householdId: CURRENT_HOUSEHOLD,
    monthStart,
    categoryId,
    plannedAmount,
  });
}

async function insertRule(categoryId: string | null, pattern: string): Promise<void> {
  await db.insert(mappingRulesTable).values({
    userId: CURRENT_USER,
    householdId: CURRENT_HOUSEHOLD,
    pattern,
    matchType: "contains",
    categoryId,
    priority: 100,
  });
}

/** Every row the seed could insert, in a stable order, ids included. */
async function householdState() {
  const hh = CURRENT_HOUSEHOLD;
  return {
    categories: await db
      .select({
        id: budgetCategoriesTable.id,
        name: budgetCategoriesTable.name,
        groupName: budgetCategoriesTable.groupName,
        sortOrder: budgetCategoriesTable.sortOrder,
        kind: budgetCategoriesTable.kind,
        sourceKind: budgetCategoriesTable.sourceKind,
      })
      .from(budgetCategoriesTable)
      .where(eq(budgetCategoriesTable.householdId, hh))
      .orderBy(asc(budgetCategoriesTable.id)),
    recurring: await db
      .select({
        id: recurringItemsTable.id,
        name: recurringItemsTable.name,
        categoryId: recurringItemsTable.categoryId,
      })
      .from(recurringItemsTable)
      .where(eq(recurringItemsTable.householdId, hh))
      .orderBy(asc(recurringItemsTable.id)),
    rules: await db
      .select({ id: mappingRulesTable.id, pattern: mappingRulesTable.pattern, categoryId: mappingRulesTable.categoryId })
      .from(mappingRulesTable)
      .where(eq(mappingRulesTable.householdId, hh))
      .orderBy(asc(mappingRulesTable.id)),
    lines: await db
      .select({
        id: budgetLinesTable.id,
        categoryId: budgetLinesTable.categoryId,
        monthStart: budgetLinesTable.monthStart,
        plannedAmount: budgetLinesTable.plannedAmount,
        note: budgetLinesTable.note,
        pinned: budgetLinesTable.pinned,
      })
      .from(budgetLinesTable)
      .where(eq(budgetLinesTable.householdId, hh))
      .orderBy(asc(budgetLinesTable.id)),
    months: await db
      .select({ monthStart: budgetMonthsTable.monthStart, pinned: budgetMonthsTable.pinned })
      .from(budgetMonthsTable)
      .where(eq(budgetMonthsTable.householdId, hh))
      .orderBy(asc(budgetMonthsTable.monthStart)),
  };
}

const byJson = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b));

/** The seeded household without ids or timestamps, for the base-seed snapshot. */
async function normalizedHousehold() {
  const hh = CURRENT_HOUSEHOLD;
  const cats = await db.select().from(budgetCategoriesTable).where(eq(budgetCategoriesTable.householdId, hh));
  const nameById = new Map(cats.map((c) => [c.id, c.name]));
  const name = (id: string | null) => (id ? (nameById.get(id) ?? "(missing)") : null);
  const recurring = await db.select().from(recurringItemsTable).where(eq(recurringItemsTable.householdId, hh));
  const rules = await db.select().from(mappingRulesTable).where(eq(mappingRulesTable.householdId, hh));
  const lines = await db.select().from(budgetLinesTable).where(eq(budgetLinesTable.householdId, hh));
  const months = await db.select().from(budgetMonthsTable).where(eq(budgetMonthsTable.householdId, hh));
  return {
    categories: cats
      .map((c) => ({
        name: c.name,
        kind: c.kind,
        groupName: c.groupName,
        sourceKind: c.sourceKind,
        sortOrder: c.sortOrder,
        excludeFromBudget: c.excludeFromBudget,
        debt: c.debtId !== null,
      }))
      .sort(byJson),
    recurring: recurring
      .map((r) => ({
        name: r.name,
        kind: r.kind,
        amount: r.amount,
        frequency: r.frequency,
        dayOfMonth: r.dayOfMonth,
        anchorDate: r.anchorDate,
        active: r.active,
        category: name(r.categoryId),
      }))
      .sort(byJson),
    rules: rules
      .map((r) => ({ pattern: r.pattern, matchType: r.matchType, priority: r.priority, category: name(r.categoryId) }))
      .sort(byJson),
    lines: lines
      .map((l) => ({
        monthStart: l.monthStart,
        category: name(l.categoryId),
        plannedAmount: l.plannedAmount,
        note: l.note,
        pinned: l.pinned,
      }))
      .sort(byJson),
    months: months.map((m) => ({ monthStart: m.monthStart, pinned: m.pinned, note: m.note })).sort(byJson),
  };
}

/** A month read's plan figures: group totals, lines, summary budgets, planBySource. */
function monthPlan(body: MonthBody) {
  return {
    monthPinned: body.monthPinned,
    summaryBudget: Object.fromEntries(Object.entries(body.summary).map(([k, v]) => [k, v.budget])),
    planBySource: body.planBySource,
    groups: body.groups.map((g) => ({
      groupName: g.groupName,
      plannedTotal: g.plannedTotal,
      lines: g.lines.map((l) => ({
        categoryName: l.categoryName,
        plannedAmount: l.plannedAmount,
        planSource: l.planSource,
        plannedSource: l.plannedSource.kind,
        pinned: l.pinned,
        sourceKind: l.sourceKind,
        kind: l.kind,
      })),
    })),
  };
}

/**
 * Hold an uncommitted server write of `amexAnchor` on the owner's settings row,
 * start `run`, wait until `run`'s backend is blocked on that row lock, commit,
 * and return `run`'s result. Waits on pg_stat_activity, not a sleep.
 */
async function whileAnchorWriteInFlight<T>(
  anchor: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let committed = false;
  let pending: Promise<T> | undefined;
  try {
    await client.query("BEGIN");
    await client.query(
      `update settings set preferences = jsonb_set(preferences, '{amexAnchor}', $1::jsonb) where user_id = $2`,
      [JSON.stringify(anchor), CURRENT_USER],
    );
    pending = run();
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const blockerPid = (await client.query<{ pid: number }>("select pg_backend_pid() as pid"))
      .rows[0]!.pid;
    const deadline = Date.now() + 15_000;
    let blocked = 0;
    while (Date.now() < deadline && !settled) {
      const { rows } = await pool.query<{ n: number }>(
        `select count(*)::int as n
           from pg_stat_activity
          where wait_event_type = 'Lock'
            and $1 = any(pg_blocking_pids(pid))`,
        [blockerPid],
      );
      blocked = rows[0]?.n ?? 0;
      if (blocked > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(settled, "the request finished while the settings write was uncommitted").toBe(false);
    expect(blocked, "the request never waited on the settings row lock").toBe(1);
    await client.query("COMMIT");
    committed = true;
  } finally {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
  return pending!;
}

afterAll(async () => {
  if (OWNERS.length === 0) return;
  await db.delete(transactionsTable).where(inArray(transactionsTable.userId, OWNERS));
  await db.delete(mappingRulesTable).where(inArray(mappingRulesTable.userId, OWNERS));
  await db.delete(recurringItemsTable).where(inArray(recurringItemsTable.userId, OWNERS));
  await db.delete(budgetLinesTable).where(inArray(budgetLinesTable.userId, OWNERS));
  await db.delete(budgetMonthsTable).where(inArray(budgetMonthsTable.userId, OWNERS));
  await db.delete(budgetCategoriesTable).where(inArray(budgetCategoriesTable.userId, OWNERS));
  await db.delete(debtsTable).where(inArray(debtsTable.userId, OWNERS));
  await db.delete(avalancheSettingsTable).where(inArray(avalancheSettingsTable.userId, OWNERS));
  await db.delete(settingsTable).where(inArray(settingsTable.userId, OWNERS));
});

describe("a deleted seed category or bill after a deploy", () => {
  it("Entertainment and the Weekly Spend bill stay deleted over two deploys; Misc / Buffer September stays 678.03", async () => {
    await newHousehold("deleted");
    await setPrefs({ amexAnchor: ANCHOR });

    // Seeded the way the app seeds: the first category read.
    expect((await getCategories()).map((c) => c.name)).toContain("Entertainment");
    expect(plannedOf(await getMonth(SEPT_2026), "Misc / Buffer")).toBe("2478.03");

    // The household deletes the Entertainment envelope and the Weekly Spend bill.
    const entertainment = (await getCategories()).find((c) => c.name === "Entertainment")!;
    expect((await request("DELETE", `/budget/categories/${entertainment.id}`)).status).toBe(204);
    const [weekly] = await db
      .select({ id: recurringItemsTable.id })
      .from(recurringItemsTable)
      .where(
        and(
          eq(recurringItemsTable.householdId, CURRENT_HOUSEHOLD),
          eq(recurringItemsTable.name, "Weekly Spend"),
        ),
      );
    expect((await request("DELETE", `/recurring-items/${weekly!.id}`)).status).toBe(204);
    expect(plannedOf(await getMonth(SEPT_2026), "Misc / Buffer")).toBe("678.03");
    const before = await householdState();

    for (const round of [1, 2]) {
      if (round === 1) {
        // Round 1: a household seeded before the marker existed.
        const { defaultsSeededAt: _dropped, ...rest } = await prefs();
        await setPrefs(rest);
      }
      deploy();
      const names = (await getCategories()).map((c) => c.name);
      expect(names, `round ${round}: categories`).not.toContain("Entertainment");
      const sept = await getMonth(SEPT_2026);
      expect(plannedOf(sept, "Misc / Buffer"), `round ${round}: Misc / Buffer September`).toBe("678.03");

      const after = await householdState();
      expect(after.recurring.map((r) => r.name), `round ${round}: bills`).not.toContain("Weekly Spend");
      expect(after, `round ${round}: household rows`).toEqual(before);

      const p = await prefs();
      expect(typeof p.defaultsSeededAt, `round ${round}: marker`).toBe("string");
      expect(p.amexAnchor).toEqual(ANCHOR);
    }
  });

  it("POST /budget/seed-bills is gone: it answers 404 and adds no deleted bill back (owner decision 2026-09-15)", async () => {
    await newHousehold("seed-bills-gone");
    // Seeded the way the app seeds: the first category read.
    await getCategories();
    const [weekly] = await db
      .select({ id: recurringItemsTable.id })
      .from(recurringItemsTable)
      .where(
        and(
          eq(recurringItemsTable.householdId, CURRENT_HOUSEHOLD),
          eq(recurringItemsTable.name, "Weekly Spend"),
        ),
      );
    expect((await request("DELETE", `/recurring-items/${weekly!.id}`)).status).toBe(204);
    const before = await householdState();

    expect((await request("POST", "/budget/seed-bills")).status).toBe(404);

    const after = await householdState();
    expect(after.recurring.map((r) => r.name)).not.toContain("Weekly Spend");
    expect(after).toEqual(before);
  });
});

describe("a household with its own data and no marker", () => {
  const cases: Array<[string, () => Promise<void>]> = [
    ["a category it made", async () => void (await insertCategory("Birthday gifts", { groupName: "My budget" }))],
    [
      "a recurring item",
      async () => {
        await db.insert(recurringItemsTable).values({
          userId: CURRENT_USER,
          householdId: CURRENT_HOUSEHOLD,
          name: "Gym",
          kind: "bill",
          amount: "40.00",
          frequency: "monthly",
          dayOfMonth: 12,
          anchorDate: null,
          active: "true",
          categoryId: null,
        });
      },
    ],
    ["a mapping rule", async () => insertRule(null, "COSTCO")],
  ];

  it.each(cases)("with only %s gets the marker and no seed row, from the category read and the web's seed call", async (label, setup) => {
    await newHousehold(label.replace(/\W+/g, "-"));
    await setPrefs({ amexAnchor: ANCHOR, weeklyAllowanceOverrides: OVERRIDES });
    await setup();
    const withoutSystem = (s: Awaited<ReturnType<typeof householdState>>) => ({
      ...s,
      categories: s.categories.filter((c) => !SYSTEM_NAMES.has(c.name)),
    });
    const before = withoutSystem(await householdState());

    deploy();
    await getCategories();
    expect(withoutSystem(await householdState())).toEqual(before);

    const p = await prefs();
    expect(typeof p.defaultsSeededAt).toBe("string");
    expect(p.amexAnchor).toEqual(ANCHOR);
    expect(p.weeklyAllowanceOverrides).toEqual(OVERRIDES);

    // The web calls POST /budget/seed-defaults when the list has no budget row.
    deploy();
    const seeded = await request("POST", "/budget/seed-defaults");
    expect(seeded.status).toBe(200);
    expect(seeded.json).toEqual({
      categoriesInserted: 0,
      linesInserted: 0,
      mappingRulesInserted: 0,
      alreadySeeded: true,
    });
    expect(withoutSystem(await householdState())).toEqual(before);
    expect((await prefs()).defaultsSeededAt).toBe(p.defaultsSeededAt);
  });

  it("the marker write waits for a settings write in flight and keeps its key", async () => {
    await newHousehold("lock");
    await setPrefs({ weeklyAllowanceOverrides: OVERRIDES, dismissedDetectedSubs: ["Hulu"] });
    await insertCategory("Birthday gifts", { groupName: "My budget" });

    const NEW_ANCHOR = { balance: 5000.5, asOf: "2026-09-11T18:00:00.000Z", lastAutoBalance: 5000.5 };
    deploy();
    const res = await whileAnchorWriteInFlight(NEW_ANCHOR, () => request("GET", "/budget/categories"));
    expect(res.status).toBe(200);

    const p = await prefs();
    expect(p.amexAnchor).toEqual(NEW_ANCHOR);
    expect(typeof p.defaultsSeededAt).toBe("string");
    expect(p.weeklyAllowanceOverrides).toEqual(OVERRIDES);
    expect(p.dismissedDetectedSubs).toEqual(["Hulu"]);
  });
});

describe("a brand-new empty household", () => {
  // The file snapshot was written on the base head 96773647 (before this
  // change) and is compared unchanged here: the seed result must not move.
  it("is seeded by the first category read exactly as on the base", async () => {
    await newHousehold("new-lazy");
    const categories = (await getCategories()).map((c) => ({ name: c.name, groupName: c.groupName, sortOrder: c.sortOrder }));
    const seeded = await normalizedHousehold();
    const may = monthPlan(await getMonth(MAY_2026));
    const sept = monthPlan(await getMonth(SEPT_2026));
    const afterReads = await normalizedHousehold();
    await expect(
      JSON.stringify({ categories, seeded, may, sept, afterReads }, null, 2) + "\n",
    ).toMatchFileSnapshot("./__snapshots__/seedDefaultsOnce.lazy-seed.base.json");
  });

  it("is seeded by POST /budget/seed-defaults exactly as on the base", async () => {
    await newHousehold("new-post");
    const res = await request("POST", "/budget/seed-defaults");
    expect(res.status).toBe(200);
    const seeded = await normalizedHousehold();
    const may = monthPlan(await getMonth(MAY_2026));
    const sept = monthPlan(await getMonth(SEPT_2026));
    const afterReads = await normalizedHousehold();
    await expect(
      JSON.stringify({ response: res.json, seeded, may, sept, afterReads }, null, 2) + "\n",
    ).toMatchFileSnapshot("./__snapshots__/seedDefaultsOnce.post-seed.base.json");
  });

  it("then has the marker, keeps its other preference keys, and a second deploy changes nothing", async () => {
    await newHousehold("new-marker");
    await setPrefs({ amexAnchor: ANCHOR, weeklyAllowanceOverrides: OVERRIDES });
    await getCategories();
    await getMonth(SEPT_2026);
    const p = await prefs();
    expect(typeof p.defaultsSeededAt).toBe("string");
    expect(Number.isNaN(Date.parse(p.defaultsSeededAt as string))).toBe(false);
    expect(p.amexAnchor).toEqual(ANCHOR);
    expect(p.weeklyAllowanceOverrides).toEqual(OVERRIDES);

    const before = await householdState();
    deploy();
    await getCategories();
    await getMonth(SEPT_2026);
    expect(await householdState()).toEqual(before);
    expect((await prefs()).defaultsSeededAt).toBe(p.defaultsSeededAt);
  });

  it("is still seeded in full when a month read ran first (system rows, Avalanche payment, a debt's row)", async () => {
    await newHousehold("new-month-first");
    await db.insert(debtsTable).values({
      userId: CURRENT_USER,
      householdId: CURRENT_HOUSEHOLD,
      name: "Visa test card",
      balance: "1000.00",
      apr: "0.2000",
      minPayment: "35.00",
      payment: "35.00",
    });
    deploy();
    await getMonth(SEPT_2026);
    const made = (await householdState()).categories.map((c) => c.name);
    expect(made).toEqual(expect.arrayContaining(["Avalanche payment", "Visa test card", "Uncategorized"]));

    await getCategories();
    const state = await householdState();
    const names = new Set(state.categories.map((c) => c.name));
    for (const seed of SEED_CATEGORIES) expect(names.has(seed.name), seed.name).toBe(true);
    expect(state.recurring).toHaveLength(SEED_RECURRING_ITEMS.length);
    expect(state.rules).toHaveLength(SEED_MAPPING_RULES.length);
    const mayLines = state.lines.filter((l) => l.monthStart === MAY_2026);
    expect(mayLines.length).toBeGreaterThanOrEqual(SEED_CATEGORIES.filter((c) => !c.excludeFromBudget).length);
    expect(typeof (await prefs()).defaultsSeededAt).toBe("string");
  });
});

describe("no V2 envelope beside a kept legacy category (PR-A reviewer R6, R7)", () => {
  // A pre-migration household. Its legacy Groceries has a mapping rule, so the
  // consolidation keeps it; Restaurants & Bars has only a May line, so it is
  // merged into Dining & Coffee. May Food: 1,840.25 + 300.75 = 2,141.00.
  async function legacyFoodHousehold(label: string): Promise<void> {
    await newHousehold(label);
    await setPrefs({ budgetMay2026AmountsV1: true });
    const groceries = await insertCategory("Groceries ($425/wk × 4.33 wks)", { groupName: "Food" });
    await insertLine(groceries, MAY_2026, "1840.25");
    await insertRule(groceries, "WOODMANS");
    const restaurants = await insertCategory("Restaurants & Bars", { groupName: "Food" });
    await insertLine(restaurants, MAY_2026, "300.75");
  }

  async function expectFood2141(label: string): Promise<void> {
    const may = await getMonth(MAY_2026);
    const food = groupOf(may, "Food");
    expect(food.plannedTotal, `${label}: May Food`).toBe("2141.00");
    expect(food.lines.map((l) => l.categoryName).sort(), `${label}: Food envelopes`).toEqual([
      "Dining & Coffee",
      "Groceries ($425/wk × 4.33 wks)",
    ]);
  }

  it("R6: the migration runs first, then the category read: May Food stays 2,141.00", async () => {
    await legacyFoodHousehold("r6");
    deploy();
    await getMonth(MAY_2026);
    await getCategories();
    await expectFood2141("after the first deploy");
    deploy();
    await getCategories();
    await expectFood2141("after a second deploy");
  });

  it("R7: the category read runs first, then the migration: May Food stays 2,141.00", async () => {
    await legacyFoodHousehold("r7");
    deploy();
    await getCategories();
    await getMonth(MAY_2026);
    await expectFood2141("after the first deploy");
    deploy();
    await getCategories();
    await expectFood2141("after a second deploy");
  });
});

describe("PUT /settings and the marker", () => {
  it("a web preferences save keeps the marker, cannot overwrite it, and the deleted category stays deleted", async () => {
    await newHousehold("settings");
    await getCategories();
    const marker = (await prefs()).defaultsSeededAt;
    expect(typeof marker).toBe("string");
    const entertainment = (await getCategories()).find((c) => c.name === "Entertainment")!;
    expect((await request("DELETE", `/budget/categories/${entertainment.id}`)).status).toBe(204);

    // The web's save: GET /settings, then PUT {...prev, ...patch}.
    const got = await request("GET", "/settings");
    expect(got.status).toBe(200);
    const prev = ((got.json as { preferences?: Record<string, unknown> | null }).preferences ?? {}) as Record<
      string,
      unknown
    >;
    expect(
      (await request("PUT", "/settings", { preferences: { ...prev, weeklyAllowanceOverrides: OVERRIDES } })).status,
    ).toBe(200);
    // A body that names the key cannot set it.
    expect(
      (await request("PUT", "/settings", { preferences: { defaultsSeededAt: "1999-01-01T00:00:00.000Z" } })).status,
    ).toBe(200);
    expect((await prefs()).defaultsSeededAt).toBe(marker);

    deploy();
    expect((await getCategories()).map((c) => c.name)).not.toContain("Entertainment");
  });
});
