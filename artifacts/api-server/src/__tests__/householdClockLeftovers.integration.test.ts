// ⭐ THE EVENING TEST, PART TWO — the PR2 leftovers.
//
// PR2 moved the server's "today", week and month onto the household calendar
// (America/Chicago). Three routes still read the process clock, which on Render
// is UTC and so already tomorrow between 7pm and midnight Central:
//   - /reports/spending-facts with no from/to ended its 30 days on tomorrow;
//   - /dashboard's "this month" was next month on a month's last evening;
//   - /weekly-settlements accepted any date as a week key, not just a Sunday.
//
// This file runs the process in UTC (as Render does), pins the clock inside
// that evening window and reads the numbers back through the real routes. The
// comments give what the old code answered.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "UTC";

const TEST_USER = `clock-leftovers-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
  db,
  budgetCategoriesTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
  weeklySettlementsTable,
} from "@workspace/db";
import reportsRouter from "../routes/reports";
import dashboardRouter from "../routes/dashboard";
import weeklySettlementsRouter from "../routes/weeklySettlements";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(reportsRouter);
app.use(dashboardRouter);
app.use(weeklySettlementsRouter);

let server: Server;
let baseUrl: string;

/** Saturday 9/12, 8:30pm Central — 01:30 on Sunday in UTC. */
const SATURDAY_EVENING = new Date("2026-09-13T01:30:00Z");
/** Wednesday 9/30, 9:00pm Central — 02:00 on October 1st in UTC. */
const LAST_EVENING_OF_SEPTEMBER = new Date("2026-10-01T02:00:00Z");

const CHASE = { accountId: "hcl-chase-7731", mask: "7731" };

async function call(
  method: "GET" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}

async function get<T>(path: string): Promise<T> {
  const { status, json } = await call("GET", path);
  if (status !== 200) throw new Error(`GET ${path} -> ${status} ${JSON.stringify(json)}`);
  return json as T;
}

async function cleanup(): Promise<void> {
  await db
    .delete(weeklySettlementsTable)
    .where(eq(weeklySettlementsTable.userId, TEST_USER));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();

  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: "test-token",
      institutionSlug: "chase",
    })
    .returning();
  await db.insert(plaidAccountsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    itemId: item!.id,
    accountId: CHASE.accountId,
    name: "Chase Checking",
    mask: CHASE.mask,
    type: "depository",
    subtype: "checking",
  });
  const [groceries] = await db
    .insert(budgetCategoriesTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Groceries",
      kind: "expense",
      groupName: "Evening",
    })
    .returning();

  for (const [occurredOn, amount] of [
    ["2026-08-13", "-7.00"], // 30 days before Saturday 9/12: the window's first day
    ["2026-09-12", "-30.00"], // Saturday
    ["2026-09-13", "-40.00"], // Sunday — still ahead on Saturday evening
    ["2026-09-30", "-10.00"], // the last day of September
    ["2026-10-01", "-25.00"], // October — still ahead on September's last evening
  ] as const) {
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn,
      description: "NEIGHBORHOOD GROCERY",
      amount,
      categoryId: groceries!.id,
      plaidAccountId: CHASE.accountId,
      source: "plaid:chase",
      createdAt: createdAtStartOfHouseholdDay(occurredOn),
    });
  }

  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await db
    .delete(weeklySettlementsTable)
    .where(eq(weeklySettlementsTable.userId, TEST_USER));
});

afterAll(async () => {
  vi.useRealTimers();
  // Assigning undefined would set the literal string "undefined".
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
  await new Promise<void>((res) => server.close(() => res()));
  await cleanup();
});

type SpendingFacts = {
  range: { start: string; end: string };
  realSpend: { total: number };
};

describe("/reports/spending-facts with no range, Saturday 8:30pm Central on a UTC server", () => {
  it("covers the household's last 30 days, ending Saturday", async () => {
    vi.setSystemTime(SATURDAY_EVENING);
    const facts = await get<SpendingFacts>("/reports/spending-facts");
    // The old UTC clock: 2026-08-14 … 2026-09-13.
    expect(facts.range.start).toBe("2026-08-13");
    expect(facts.range.end).toBe("2026-09-12");
    // $7 + $30. Sunday's $40 hasn't happened yet. The old window dropped 8/13
    // and took Sunday: $30 + $40 = $70.
    expect(facts.realSpend.total).toBeCloseTo(37, 2);
  });
});

type Dashboard = {
  monthlySpend: string;
  transactionCount: number;
};

describe("/dashboard, the last evening of September on a UTC server", () => {
  it("still reports September as this month", async () => {
    vi.setSystemTime(LAST_EVENING_OF_SEPTEMBER);
    const dashboard = await get<Dashboard>("/dashboard");
    // $30 + $40 + $10 across September's three rows. The old UTC clock was
    // already in October: $25 across one row.
    expect(Number(dashboard.monthlySpend)).toBeCloseTo(80, 2);
    expect(dashboard.transactionCount).toBe(3);
  });
});

describe("/weekly-settlements takes only a Sunday", () => {
  const WEDNESDAY = "2026-09-09";
  const SUNDAY = "2026-09-06";

  it("PUT refuses a Wednesday and a date that does not exist, and closes a Sunday", async () => {
    vi.setSystemTime(SATURDAY_EVENING);
    // The old route stored a Wednesday key no screen can reach.
    const wed = await call("PUT", "/weekly-settlements", { weekStart: WEDNESDAY });
    expect(wed.status).toBe(400);
    expect(wed.json).toEqual({ error: "weekStart must be a Sunday" });
    // 2026 is not a leap year. The old route handed it to Postgres.
    const bogus = await call("PUT", "/weekly-settlements", { weekStart: "2026-02-29" });
    expect(bogus.status).toBe(400);

    const sun = await call("PUT", "/weekly-settlements", { weekStart: SUNDAY });
    expect(sun.status).toBe(200);
    expect((sun.json as { weekStart: string }).weekStart).toBe(SUNDAY);
  });

  it("GET refuses a Wednesday and finds a closed Sunday", async () => {
    vi.setSystemTime(SATURDAY_EVENING);
    expect((await call("PUT", "/weekly-settlements", { weekStart: SUNDAY })).status).toBe(200);

    // The old route answered 200 with an empty list.
    const wed = await call("GET", `/weekly-settlements?weekStart=${WEDNESDAY}`);
    expect(wed.status).toBe(400);
    expect(wed.json).toEqual({ error: "weekStart must be a Sunday" });

    const rows = await get<{ weekStart: string }[]>(`/weekly-settlements?weekStart=${SUNDAY}`);
    expect(rows.map((r) => r.weekStart)).toEqual([SUNDAY]);
  });

  it("DELETE refuses a Wednesday and reopens a Sunday", async () => {
    vi.setSystemTime(SATURDAY_EVENING);
    expect((await call("PUT", "/weekly-settlements", { weekStart: SUNDAY })).status).toBe(200);

    // The old route answered 204 and deleted nothing.
    const wed = await call("DELETE", `/weekly-settlements?weekStart=${WEDNESDAY}`);
    expect(wed.status).toBe(400);
    expect(wed.json).toEqual({ error: "weekStart must be a Sunday" });

    expect((await call("DELETE", `/weekly-settlements?weekStart=${SUNDAY}`)).status).toBe(204);
    expect(await get<unknown[]>(`/weekly-settlements?weekStart=${SUNDAY}`)).toEqual([]);
  });
});

type BudgetFacts = { range: { monthStart: string } };

describe("/reports/budget-facts with no monthStart, the last evening of September on a UTC server", () => {
  it("reports September", async () => {
    vi.setSystemTime(LAST_EVENING_OF_SEPTEMBER);
    const facts = await get<BudgetFacts>("/reports/budget-facts");
    // The old default read the UTC month, already October: 2026-10-01.
    expect(facts.range.monthStart).toBe("2026-09-01");
  });

  it("an explicit monthStart is still honoured as given", async () => {
    vi.setSystemTime(LAST_EVENING_OF_SEPTEMBER);
    const facts = await get<BudgetFacts>("/reports/budget-facts?monthStart=2026-08-15");
    expect(facts.range.monthStart).toBe("2026-08-01");
  });
});
