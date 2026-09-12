import { describe, it, expect, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";

/**
 * Owner decision 3: repeated deployments must never delete user categories,
 * never trust a completed flag blindly, and the one-time passes must be safe to
 * rerun.
 *
 * GET /budget/months/:m runs three one-time passes once per process, i.e. once
 * after every deploy: the category consolidation (gate `budgetCategoriesV2`),
 * the legacy bill-category heal (no gate) and the May 2026 amounts reset (gate
 * `budgetMay2026AmountsV1`). A deploy is simulated by clearing the in-process
 * gates (`_resetBudgetOneTimePassGatesForTests`); a lost gate by rewriting the
 * settings row without it. Everything goes through the real budget router
 * against a real Postgres.
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
  mappingRulesTable,
  recurringItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import budgetRouter, { _resetBudgetOneTimePassGatesForTests } from "../routes/budget";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";

const { request } = createTestApp(budgetRouter);

const OWNERS: string[] = [];
const MAY_2026 = "2026-05-01";
const SEPT_2026 = "2026-09-01";
const ANCHOR = { balance: 4321.09, asOf: "2026-09-10T15:04:05.000Z", lastAutoBalance: 4321.09 };

async function newHousehold(label: string): Promise<void> {
  const user = `deploy-safe-${label}-${process.pid}-${randomUUID().slice(0, 8)}`;
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

async function getMonth(month: string): Promise<unknown> {
  const res = await request("GET", `/budget/months/${month}`);
  expect(res.status).toBe(200);
  return res.json;
}

async function insertCategory(
  name: string,
  opts: {
    groupName?: string;
    kind?: "income" | "expense";
    sourceKind?: "manual" | "auto_bills";
    sortOrder?: number;
  } = {},
): Promise<string> {
  const [row] = await db
    .insert(budgetCategoriesTable)
    .values({
      userId: CURRENT_USER,
      householdId: CURRENT_HOUSEHOLD,
      name,
      groupName: opts.groupName ?? "Other",
      kind: opts.kind ?? "expense",
      sourceKind: opts.sourceKind ?? "manual",
      sortOrder: opts.sortOrder ?? 0,
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

async function insertTransactions(categoryId: string, dates: string[], amount = "12.34"): Promise<string[]> {
  const rows = await db
    .insert(transactionsTable)
    .values(
      dates.map((occurredOn, i) => ({
        userId: CURRENT_USER,
        householdId: CURRENT_HOUSEHOLD,
        occurredOn,
        amount,
        description: `deploy-safe row ${i + 1}`,
        source: "manual",
        categoryId,
      })),
    )
    .returning({ id: transactionsTable.id });
  return rows.map((r) => r.id);
}

async function insertRule(categoryId: string, pattern: string): Promise<void> {
  await db.insert(mappingRulesTable).values({
    userId: CURRENT_USER,
    householdId: CURRENT_HOUSEHOLD,
    pattern,
    matchType: "contains",
    categoryId,
    priority: 100,
  });
}

async function categoriesByName(): Promise<Map<string, typeof budgetCategoriesTable.$inferSelect>> {
  const rows = await db
    .select()
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.householdId, CURRENT_HOUSEHOLD));
  return new Map(rows.map((c) => [c.name, c]));
}

/** Every row the category passes could touch, in a stable order. */
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
    transactions: await db
      .select({ id: transactionsTable.id, categoryId: transactionsTable.categoryId })
      .from(transactionsTable)
      .where(eq(transactionsTable.householdId, hh))
      .orderBy(asc(transactionsTable.id)),
    rules: await db
      .select({ id: mappingRulesTable.id, categoryId: mappingRulesTable.categoryId })
      .from(mappingRulesTable)
      .where(eq(mappingRulesTable.householdId, hh))
      .orderBy(asc(mappingRulesTable.id)),
    recurring: await db
      .select({ id: recurringItemsTable.id, categoryId: recurringItemsTable.categoryId })
      .from(recurringItemsTable)
      .where(eq(recurringItemsTable.householdId, hh))
      .orderBy(asc(recurringItemsTable.id)),
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

async function monthLines(monthStart: string) {
  return db
    .select({
      categoryId: budgetLinesTable.categoryId,
      plannedAmount: budgetLinesTable.plannedAmount,
      pinned: budgetLinesTable.pinned,
    })
    .from(budgetLinesTable)
    .where(
      and(
        eq(budgetLinesTable.householdId, CURRENT_HOUSEHOLD),
        eq(budgetLinesTable.monthStart, monthStart),
      ),
    );
}

async function monthPinned(monthStart: string): Promise<boolean | undefined> {
  const [m] = await db
    .select({ pinned: budgetMonthsTable.pinned })
    .from(budgetMonthsTable)
    .where(
      and(
        eq(budgetMonthsTable.householdId, CURRENT_HOUSEHOLD),
        eq(budgetMonthsTable.monthStart, monthStart),
      ),
    );
  return m?.pinned;
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

// Nothing shared: each test makes its own household.
afterAll(async () => {
  if (OWNERS.length === 0) return;
  await db.delete(transactionsTable).where(inArray(transactionsTable.userId, OWNERS));
  await db.delete(mappingRulesTable).where(inArray(mappingRulesTable.userId, OWNERS));
  await db.delete(recurringItemsTable).where(inArray(recurringItemsTable.userId, OWNERS));
  await db.delete(budgetLinesTable).where(inArray(budgetLinesTable.userId, OWNERS));
  await db.delete(budgetMonthsTable).where(inArray(budgetMonthsTable.userId, OWNERS));
  await db.delete(budgetCategoriesTable).where(inArray(budgetCategoriesTable.userId, OWNERS));
  await db.delete(avalancheSettingsTable).where(inArray(avalancheSettingsTable.userId, OWNERS));
  await db.delete(settingsTable).where(inArray(settingsTable.userId, OWNERS));
});

describe("category consolidation (budgetCategoriesV2) after a lost gate", () => {
  it("two deploys on a migrated household change no category, transaction, rule, bill link or line", async () => {
    await newHousehold("migrated");
    await setPrefs({ amexAnchor: ANCHOR, budgetCategoriesV2: true, budgetMay2026AmountsV1: true });
    expect((await request("POST", "/budget/seed-defaults")).status).toBe(200);

    // After the migration the household made its own "Gaming subs", a name on
    // the legacy map, and planned on it, spent on it and wrote a rule for it.
    const gaming = await insertCategory("Gaming subs", {
      groupName: "Lifestyle & Shopping",
      sortOrder: 5,
    });
    await insertLine(gaming, SEPT_2026, "50.00");
    await insertTransactions(gaming, ["2026-09-03"]);
    await insertRule(gaming, "PLAYSTATION");
    // …and moved Groceries up its group.
    const groceries = (await categoriesByName()).get("Groceries")!;
    await db
      .update(budgetCategoriesTable)
      .set({ sortOrder: 7 })
      .where(eq(budgetCategoriesTable.id, groceries.id));

    // Warm up with the gate set, so the live syncs have made their rows.
    deploy();
    await getMonth(SEPT_2026);
    const before = await householdState();
    expect(before.categories.find((c) => c.name === "Gaming subs")).toBeTruthy();

    for (const round of [1, 2]) {
      // The gate is lost (as a PUT /settings used to do), then a deploy.
      await setPrefs({ amexAnchor: ANCHOR, budgetMay2026AmountsV1: true });
      deploy();
      await getMonth(SEPT_2026);

      const after = await householdState();
      expect(after.categories, `round ${round}: categories`).toEqual(before.categories);
      expect(after.transactions, `round ${round}: transaction categories`).toEqual(before.transactions);
      expect(after.rules, `round ${round}: mapping rules`).toEqual(before.rules);
      expect(after.recurring, `round ${round}: bill links`).toEqual(before.recurring);
      expect(after.lines, `round ${round}: budget lines`).toEqual(before.lines);

      const p = await prefs();
      expect(p.budgetCategoriesV2).toBe(true);
      expect(p.amexAnchor).toEqual(ANCHOR);
      expect(p.budgetMay2026AmountsV1).toBe(true);
    }
  });

  it("a genuinely pre-migration household still migrates, but a legacy category planned on after May 2026 is left alone", async () => {
    await newHousehold("legacy");
    await setPrefs({ amexAnchor: ANCHOR, budgetMay2026AmountsV1: true });

    // Legacy seed rows. "Misc / Buffer" was in the legacy seed too, so it is no
    // sign of the V2 list.
    await insertCategory("Misc / Buffer");
    const gaming = await insertCategory("Gaming subs");
    await insertLine(gaming, MAY_2026, "18.98");
    const phone = await insertCategory("Phone (Verizon)");
    await insertLine(phone, MAY_2026, "342.00");
    const [phoneTxn] = await insertTransactions(phone, ["2026-05-16"], "342.00");
    const streaming = await insertCategory("Streaming (Netflix, Hulu, Spotify, Peacock)");
    await insertLine(streaming, "2026-07-01", "45.00");
    await insertRule(streaming, "NETFLIX");

    deploy();
    await getMonth(SEPT_2026);

    const cats = await categoriesByName();
    expect(cats.has("Gaming subs")).toBe(false);
    expect(cats.has("Phone (Verizon)")).toBe(false);
    const subscriptions = cats.get("Subscriptions")!;
    const utilities = cats.get("Utilities")!;
    expect(subscriptions).toBeTruthy();
    expect(utilities).toBeTruthy();
    const may = await monthLines(MAY_2026);
    expect(may.find((l) => l.categoryId === subscriptions.id)?.plannedAmount).toBe("18.98");
    expect(may.find((l) => l.categoryId === utilities.id)?.plannedAmount).toBe("342.00");
    const [txn] = await db
      .select({ categoryId: transactionsTable.categoryId })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, phoneTxn!));
    expect(txn!.categoryId).toBe(utilities.id);

    // Planned on in July 2026, after the V2 era began: kept with its line and rule.
    expect(cats.get("Streaming (Netflix, Hulu, Spotify, Peacock)")?.id).toBe(streaming);
    const july = await monthLines("2026-07-01");
    expect(july.find((l) => l.categoryId === streaming)?.plannedAmount).toBe("45.00");
    const [rule] = await db
      .select({ categoryId: mappingRulesTable.categoryId })
      .from(mappingRulesTable)
      .where(
        and(
          eq(mappingRulesTable.householdId, CURRENT_HOUSEHOLD),
          eq(mappingRulesTable.pattern, "NETFLIX"),
        ),
      );
    expect(rule!.categoryId).toBe(streaming);

    const p = await prefs();
    expect(p.budgetCategoriesV2).toBe(true);
    expect(p.amexAnchor).toEqual(ANCHOR);
  });

  it("with no V2-only name and the gate lost, a legacy-named category used since June 2026 or held by a rule is kept, not merged", async () => {
    await newHousehold("no-v2-names");
    await setPrefs({ amexAnchor: ANCHOR, budgetMay2026AmountsV1: true });

    // The reviewer's case: the user's "Gaming subs", 2 transactions Aug–Sept,
    // 1 mapping rule, no budget line.
    const gaming = await insertCategory("Gaming subs", { groupName: "Lifestyle & Shopping" });
    const gamingTxns = await insertTransactions(gaming, ["2026-08-14", "2026-09-02"], "18.98");
    await insertRule(gaming, "PLAYSTATION");
    // Each guard alone: a June 2026 transaction only; a mapping rule only.
    const coffee = await insertCategory("Coffee (Starbucks, Dunkin)");
    const coffeeTxns = await insertTransactions(coffee, ["2026-06-05"], "6.45");
    const menards = await insertCategory("Home & Menards");
    await insertRule(menards, "MENARDS");
    // A legacy category with May 2026 data only: still merged (full path).
    const phone = await insertCategory("Phone (Verizon)");
    await insertLine(phone, MAY_2026, "342.00");
    const [phoneTxn] = await insertTransactions(phone, ["2026-05-16"], "342.00");

    deploy();
    await getMonth(SEPT_2026);

    const cats = await categoriesByName();
    expect(cats.get("Gaming subs")?.id, "Gaming subs kept").toBe(gaming);
    expect(cats.get("Coffee (Starbucks, Dunkin)")?.id, "June transaction keeps it").toBe(coffee);
    expect(cats.get("Home & Menards")?.id, "a mapping rule keeps it").toBe(menards);
    expect(cats.has("Phone (Verizon)"), "May-only legacy category merged").toBe(false);
    const utilities = cats.get("Utilities")!;
    expect(utilities).toBeTruthy();

    const txns = await db
      .select({ id: transactionsTable.id, categoryId: transactionsTable.categoryId })
      .from(transactionsTable)
      .where(inArray(transactionsTable.id, [...gamingTxns, ...coffeeTxns, phoneTxn!]));
    const catOf = new Map(txns.map((t) => [t.id, t.categoryId]));
    for (const id of gamingTxns) expect(catOf.get(id), "Gaming subs transaction").toBe(gaming);
    for (const id of coffeeTxns) expect(catOf.get(id), "Coffee transaction").toBe(coffee);
    expect(catOf.get(phoneTxn!)).toBe(utilities.id);

    const rules = await db
      .select({ pattern: mappingRulesTable.pattern, categoryId: mappingRulesTable.categoryId })
      .from(mappingRulesTable)
      .where(eq(mappingRulesTable.householdId, CURRENT_HOUSEHOLD));
    expect(new Map(rules.map((r) => [r.pattern, r.categoryId]))).toEqual(
      new Map([
        ["PLAYSTATION", gaming],
        ["MENARDS", menards],
      ]),
    );
    const subscriptions = cats.get("Subscriptions");
    if (subscriptions) {
      const moved = await db
        .select({ id: transactionsTable.id })
        .from(transactionsTable)
        .where(eq(transactionsTable.categoryId, subscriptions.id));
      expect(moved, "nothing moved into Subscriptions").toEqual([]);
    }

    const p = await prefs();
    expect(p.budgetCategoriesV2).toBe(true);
    expect(p.amexAnchor).toEqual(ANCHOR);
  });

  it("the gate write waits for a settings write in flight and keeps its key", async () => {
    await newHousehold("lock-v2");
    await setPrefs({ budgetMay2026AmountsV1: true, dismissedDetectedSubs: ["Hulu"] });
    expect((await request("POST", "/budget/seed-defaults")).status).toBe(200);

    const NEW_ANCHOR = { balance: 5000.5, asOf: "2026-09-11T18:00:00.000Z", lastAutoBalance: 5000.5 };
    deploy();
    const res = await whileAnchorWriteInFlight(NEW_ANCHOR, () =>
      request("GET", `/budget/months/${SEPT_2026}`),
    );
    expect(res.status).toBe(200);

    const p = await prefs();
    expect(p.amexAnchor).toEqual(NEW_ANCHOR);
    expect(p.budgetCategoriesV2).toBe(true);
    expect(p.budgetMay2026AmountsV1).toBe(true);
    expect(p.dismissedDetectedSubs).toEqual(["Hulu"]);
  });
});

describe("legacy bill-category heal after a deploy", () => {
  it("keeps every unlinked auto_bills category that something still references; removes only an empty one", async () => {
    await newHousehold("heal");
    await setPrefs({ budgetCategoriesV2: true, budgetMay2026AmountsV1: true });
    expect((await request("POST", "/budget/seed-defaults")).status).toBe(200);

    const autoBill = { groupName: "Recurring Bills", sourceKind: "auto_bills" as const, sortOrder: 9000 };

    // A one-time bill whose date has passed (the heal treats it as archived),
    // with three categorized transactions.
    const gym = await insertCategory("Gym day pass (one-time)", autoBill);
    await db.insert(recurringItemsTable).values({
      userId: CURRENT_USER,
      householdId: CURRENT_HOUSEHOLD,
      name: "Gym day pass (one-time)",
      kind: "bill",
      amount: "25.00",
      frequency: "onetime",
      dayOfMonth: null,
      anchorDate: "2026-04-15",
      active: "true",
      categoryId: gym,
    });
    const gymTxns = await insertTransactions(gym, ["2026-04-15", "2026-04-16", "2026-04-17"], "25.00");

    // Old per-bill categories with no bill at all, each held by one reference.
    const withTxns = await insertCategory("Old per-bill row", autoBill);
    const oldTxns = await insertTransactions(withTxns, ["2026-06-01", "2026-06-02", "2026-06-03"]);
    const ruleOnly = await insertCategory("Rule-only bill row", autoBill);
    await insertRule(ruleOnly, "OLD BILL");
    const lineOnly = await insertCategory("Line-only bill row", autoBill);
    await insertLine(lineOnly, "2026-08-01", "40.00");
    const empty = await insertCategory("Empty bill row", autoBill);

    deploy();
    await getMonth(SEPT_2026);

    const ids = new Set([...(await categoriesByName()).values()].map((c) => c.id));
    expect(ids.has(gym), "expired one-time bill's category").toBe(true);
    expect(ids.has(withTxns), "category with transactions").toBe(true);
    expect(ids.has(ruleOnly), "category with a mapping rule").toBe(true);
    expect(ids.has(lineOnly), "category with a budget line").toBe(true);
    expect(ids.has(empty), "unreferenced category").toBe(false);

    const txns = await db
      .select({ id: transactionsTable.id, categoryId: transactionsTable.categoryId })
      .from(transactionsTable)
      .where(inArray(transactionsTable.id, [...gymTxns, ...oldTxns]));
    expect(txns).toHaveLength(6);
    for (const t of txns) {
      expect(t.categoryId, `transaction ${t.id}`).toBe(gymTxns.includes(t.id) ? gym : withTxns);
    }
    const [rule] = await db
      .select({ categoryId: mappingRulesTable.categoryId })
      .from(mappingRulesTable)
      .where(
        and(
          eq(mappingRulesTable.householdId, CURRENT_HOUSEHOLD),
          eq(mappingRulesTable.pattern, "OLD BILL"),
        ),
      );
    expect(rule!.categoryId).toBe(ruleOnly);
    const aug = await monthLines("2026-08-01");
    expect(aug.find((l) => l.categoryId === lineOnly)?.plannedAmount).toBe("40.00");
  });
});

describe("May 2026 amounts reset (budgetMay2026AmountsV1) after a lost gate", () => {
  it("leaves an edited May 2026 line and the month's pin alone, and keeps other preference keys", async () => {
    await newHousehold("may-edited");
    await setPrefs({ amexAnchor: ANCHOR, budgetCategoriesV2: true });
    expect((await request("POST", "/budget/seed-defaults")).status).toBe(200);

    const cats = await categoriesByName();
    const misc = cats.get("Misc / Buffer")!.id;
    const groceries = cats.get("Groceries")!.id;
    await db
      .update(budgetLinesTable)
      .set({ plannedAmount: "999.00" })
      .where(and(eq(budgetLinesTable.categoryId, misc), eq(budgetLinesTable.monthStart, MAY_2026)));
    await db
      .update(budgetLinesTable)
      .set({ plannedAmount: "512.34" })
      .where(and(eq(budgetLinesTable.categoryId, groceries), eq(budgetLinesTable.monthStart, MAY_2026)));
    const byCat = (rows: Awaited<ReturnType<typeof monthLines>>) =>
      [...rows].sort((a, b) => a.categoryId.localeCompare(b.categoryId));
    const before = byCat(await monthLines(MAY_2026));
    expect(await monthPinned(MAY_2026)).toBe(false);

    for (const round of [1, 2]) {
      deploy();
      const body = (await getMonth(MAY_2026)) as {
        lines: Array<{ categoryId: string; plannedAmount: string }>;
      };
      const after = byCat(await monthLines(MAY_2026)).filter((l) =>
        before.some((b) => b.categoryId === l.categoryId),
      );
      expect(after, `round ${round}: May lines`).toEqual(before);
      expect(after.some((l) => l.pinned), `round ${round}: a May line was pinned`).toBe(false);
      expect(await monthPinned(MAY_2026), `round ${round}: May pinned`).toBe(false);
      expect(body.lines.find((l) => l.categoryId === groceries)?.plannedAmount).toBe("512.34");

      const p = await prefs();
      expect(p.budgetMay2026AmountsV1).toBe(true);
      expect(p.amexAnchor).toEqual(ANCHOR);
      expect(p.budgetCategoriesV2).toBe(true);
      // Lose the gate again for round 2.
      await setPrefs({ amexAnchor: ANCHOR, budgetCategoriesV2: true });
    }
  });

  it("stores no May 2026 line at all: a Sept-only Groceries line is not seeded into May, nor carried into July as $460", async () => {
    await newHousehold("may-sept-only");
    await setPrefs({ budgetCategoriesV2: true });
    // The reviewer's case: Groceries holds only a Sept 2026 $300 line. Health
    // has no line anywhere (an empty envelope).
    const groceries = await insertCategory("Groceries");
    const health = await insertCategory("Health");
    await insertLine(groceries, SEPT_2026, "300.00");

    deploy();
    await getMonth(MAY_2026);

    const may = await monthLines(MAY_2026);
    expect(may.find((l) => l.categoryId === groceries), "no May Groceries line").toBeUndefined();
    expect(may.find((l) => l.categoryId === health), "no May Health line").toBeUndefined();
    expect(may.some((l) => l.pinned)).toBe(false);
    expect(await monthPinned(MAY_2026)).not.toBe(true);
    expect((await prefs()).budgetMay2026AmountsV1).toBe(true);

    // July has no earlier line to carry forward, so no Groceries plan appears.
    await getMonth("2026-07-01");
    const july = await monthLines("2026-07-01");
    expect(july.find((l) => l.categoryId === groceries), "no July Groceries line").toBeUndefined();
    const sept = await monthLines(SEPT_2026);
    expect(sept.find((l) => l.categoryId === groceries)?.plannedAmount).toBe("300.00");
  });

  it("a household with an April 2026 line gets only the gate; May carries April forward", async () => {
    await newHousehold("may-april");
    await setPrefs({ budgetCategoriesV2: true });
    const groceries = await insertCategory("Groceries");
    await insertLine(groceries, "2026-04-01", "300.00");

    deploy();
    await getMonth(MAY_2026);

    const may = await monthLines(MAY_2026);
    expect(may.find((l) => l.categoryId === groceries)?.plannedAmount).toBe("300.00");
    expect(may.some((l) => l.pinned)).toBe(false);
    expect(await monthPinned(MAY_2026)).toBe(false);
    expect((await prefs()).budgetMay2026AmountsV1).toBe(true);
  });

  it("the gate write waits for a settings write in flight and keeps its key", async () => {
    await newHousehold("lock-may");
    await setPrefs({ budgetCategoriesV2: true, dismissedDetectedSubs: ["Hulu"] });
    expect((await request("POST", "/budget/seed-defaults")).status).toBe(200);

    const NEW_ANCHOR = { balance: 6000.25, asOf: "2026-09-11T19:00:00.000Z", lastAutoBalance: 6000.25 };
    deploy();
    const res = await whileAnchorWriteInFlight(NEW_ANCHOR, () =>
      request("GET", `/budget/months/${MAY_2026}`),
    );
    expect(res.status).toBe(200);

    const p = await prefs();
    expect(p.amexAnchor).toEqual(NEW_ANCHOR);
    expect(p.budgetMay2026AmountsV1).toBe(true);
    expect(p.budgetCategoriesV2).toBe(true);
    expect(p.dismissedDetectedSubs).toEqual(["Hulu"]);
  });
});
