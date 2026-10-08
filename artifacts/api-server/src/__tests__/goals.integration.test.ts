// ⭐ (PR-C) GOALS AND RESERVES — the endpoints, the reserve in the money
// position, the goals line of the suggested weekly cap, goal_behind from the
// real facts, the metrics fields, and the SQL twin of the drizzle table.
//
// Pinned now: Wed 2026-10-07 12:00 Central. All figures are synthetic.
//
// Household A
//   Checking snapshot $3,000.00 (typed in, Sun 10/4 08:00), cash buffer $500,
//   no rows since. A savings account whose balance snapshot is $1,250.00.
//   Plans: Paycheck +2,000 biweekly from Fri 10/9 · Rent −1,200 monthly on the 12th.
//   No weekly cap, so safe-to-spend is the cash figure.
//   Curve through payday: 3,000.00 every day (10/9 read before its paycheck)
//   → available 3,000.00 − 500 = 2,500.00.
//   Suggested weekly: take-home 2,000 × 26/12 = 4,333.33; committed 1,200.00;
//   discretionary 3,133.33 → × 12/52 = 723.07 → $720.
//
// Household B — another owner with a savings account of its own.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { eq, inArray } from "drizzle-orm";

const A_OWNER = `goals-a-${process.pid}-${randomUUID().slice(0, 8)}`;
const A_MEMBER = `goals-am-${process.pid}-${randomUUID().slice(0, 8)}`;
const B_OWNER = `goals-b-${process.pid}-${randomUUID().slice(0, 8)}`;
const HH: Record<string, { householdId: string; ownerUserId: string }> = {};

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: {
      headers: Record<string, string | string[] | undefined>;
      userId?: string;
      actualUserId?: string;
      householdId?: string;
      householdOwnerId?: string;
    },
    _res: unknown,
    next: () => void,
  ) => {
    const who = String(req.headers["x-test-user"] ?? A_OWNER);
    const hh = HH[who]!;
    req.userId = who;
    req.actualUserId = who;
    req.householdId = hh.householdId;
    req.householdOwnerId = hh.ownerUserId;
    next();
  },
}));

import {
  db,
  pool,
  forecastSettingsTable,
  goalsTable,
  householdMembersTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
} from "@workspace/db";
import moneyRouter from "../routes/money";
import goalsRouter from "../routes/goals";
import { createTestHousehold } from "./_helpers/testHousehold";
import { reservesHeld } from "../lib/goals";
import { loadMonitorFacts } from "../monitor/facts";
import { runDetectors } from "../monitor/detectors";
import { computeMetricsForDay } from "../lib/metricsSnapshot";

const NOW = new Date("2026-10-07T12:00:00-05:00");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_FILE = path.resolve(HERE, "../../../../lib/db/migrations/0080_goals.sql");

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(moneyRouter);
app.use(goalsRouter);

let server: Server;
let baseUrl: string;
let checkingId = "";
let savingsId = "";
let bSavingsId = "";
const ids: Record<string, string> = {};

async function call(method: "GET" | "POST" | "PATCH" | "DELETE", p: string, body?: unknown, as: string = A_OWNER) {
  const r = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { "x-test-user": as, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const position = async (): Promise<any> => (await call("GET", "/money/position")).body;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const create = async (g: Record<string, unknown>): Promise<any> => {
  const r = await call("POST", "/goals", g);
  expect(r.status).toBe(201);
  return r.body;
};

async function cleanup(): Promise<void> {
  const hhIds = Object.values(HH).map((h) => h.householdId);
  if (hhIds.length) await db.delete(goalsTable).where(inArray(goalsTable.householdId, hhIds));
  for (const u of [A_OWNER, B_OWNER]) {
    await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, u));
    await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, u));
    await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, u));
    await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, u));
  }
}

beforeAll(async () => {
  vi.setSystemTime(NOW);
  HH[A_OWNER] = await createTestHousehold(A_OWNER);
  HH[B_OWNER] = await createTestHousehold(B_OWNER);
  await db
    .insert(householdMembersTable)
    .values({ userId: A_MEMBER, householdId: HH[A_OWNER]!.householdId, role: "member" })
    .onConflictDoNothing();
  HH[A_MEMBER] = { householdId: HH[A_OWNER]!.householdId, ownerUserId: A_OWNER };
  await cleanup();

  const accounts = async (owner: string) => {
    const base = { userId: owner, householdId: HH[owner]!.householdId };
    const [item] = await db
      .insert(plaidItemsTable)
      .values({ ...base, itemId: `item-${randomUUID()}`, accessToken: "test-token", institutionSlug: "chase" })
      .returning();
    const [checking, savings] = await db
      .insert(plaidAccountsTable)
      .values([
        { ...base, itemId: item!.id, accountId: `acct-chk-${randomUUID()}`, name: "Checking", type: "depository", subtype: "checking" },
        { ...base, itemId: item!.id, accountId: `acct-sav-${randomUUID()}`, name: "Savings", type: "depository", subtype: "savings" },
      ])
      .returning();
    return { base, checking: checking!, savings: savings! };
  };
  const a = await accounts(A_OWNER);
  const b = await accounts(B_OWNER);
  checkingId = a.checking.id;
  savingsId = a.savings.id;
  bSavingsId = b.savings.id;
  await db.insert(forecastSettingsTable).values({
    ...a.base,
    daysAhead: 90,
    cashBuffer: "500.00",
    bankSnapshotBalance: "3000.00",
    bankSnapshotAt: new Date("2026-10-04T08:00:00-05:00"),
    bankSnapshotSource: "manual",
    bankSnapshotAccountId: checkingId,
    accountSnapshots: {
      [savingsId]: { balance: "1250.00", at: "2026-10-06T08:00:00.000Z", source: "plaid", name: "Savings", mask: "0001" },
    },
  });
  await db.insert(forecastSettingsTable).values({
    ...b.base,
    accountSnapshots: {
      [bSavingsId]: { balance: "9999.00", at: "2026-10-06T08:00:00.000Z", source: "plaid", name: "Savings", mask: "0002" },
    },
  });
  const plan = (name: string, kind: string, amount: string, frequency: string, anchorDate: string) => ({
    ...a.base,
    name,
    kind,
    amount,
    frequency,
    dayOfMonth: Number(anchorDate.slice(8, 10)),
    anchorDate,
    active: "true",
    amountKind: "fixed",
  });
  await db.insert(recurringItemsTable).values([
    plan("Paycheck", "income", "2000", "biweekly", "2026-10-09"),
    plan("Rent", "bill", "1200", "monthly", "2026-10-12"),
  ]);

  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  vi.useRealTimers();
  await new Promise<void>((res) => server.close(() => res()));
  await cleanup();
  await db.delete(householdMembersTable).where(eq(householdMembersTable.userId, A_MEMBER));
});

describe("goals and reserves — household A, in order", () => {
  it("baseline: no goals, no reserve, the suggestion's goals line is 0", async () => {
    const p = await position();
    expect(p).toMatchObject({
      reservesHeld: "0.00",
      cashBuffer: "500.00",
      lowestUntilPayday: "3000.00",
      availableUntilPayday: "2500.00",
      weekCap: null,
      safeToSpendNow: "2500.00",
    });
    const plans = await call("GET", "/allowance-plans");
    expect(plans.body.suggested).toEqual({
      weekly: "720.00",
      derivation: {
        takeHomeMonthly: "4333.33",
        committedMonthly: "1200.00",
        debtMinimumsMonthly: "0.00",
        extraMonthly: "0.00",
        goalsMonthly: "0.00",
        discretionaryMonthly: "3133.33",
      },
    });
    expect((await call("GET", "/goals")).body).toEqual({ goals: [], reservesHeld: "0.00", goalsMonthly: "0.00", cashBuffer: "500.00" });
  });

  it("POST creates a typed-amount goal with its progress (a range, never a date)", async () => {
    const g = await create({
      name: " Vacation ",
      kind: "savings",
      targetAmount: "1000.00",
      manualCurrentAmount: "250.00",
      monthlyContribution: "100.00",
      targetDate: "2027-10-07",
    });
    ids.vacation = g.id;
    expect(g).toMatchObject({
      name: "Vacation",
      kind: "savings",
      status: "active",
      currentAmount: "250.00",
      currentSource: "manual",
      percent: 25,
      remaining: "750.00",
      monthsToTargetLow: 7, // 750 at 100 a month: 8 contributions
      monthsToTargetHigh: 8,
      requiredMonthly: "62.50", // 750 over 12 months
      onTrack: true,
      reserveHeld: "0.00",
      cashBuffer: null,
      reservedInChecking: false,
      plaidAccountId: null,
      priority: 0,
    });
    const [row] = await db.select().from(goalsTable).where(eq(goalsTable.id, g.id));
    expect(row!.createdBy).toBe(A_OWNER);
    expect((await call("POST", "/goals", { name: "x", kind: "rainy" })).status).toBe(400);
    expect((await call("POST", "/goals", { name: "x", kind: "savings", monthlyContribution: "1.234" })).status).toBe(400);
    expect((await call("POST", "/goals", { name: "x", kind: "savings", targetDate: "2027-02-30" })).status).toBe(400);
  });

  it("two goals reserved in checking take exactly $123.45 off available and safe-to-spend", async () => {
    ids.car = (await create({ name: "Car repair", kind: "sinking", manualCurrentAmount: "100.10", reservedInChecking: true })).id;
    ids.gifts = (await create({ name: "Gifts", kind: "sinking", manualCurrentAmount: "23.35", reservedInChecking: true, monthlyContribution: "25.00" })).id;
    const p = await position();
    expect(p).toMatchObject({
      reservesHeld: "123.45",
      lowestUntilPayday: "3000.00",
      cashBuffer: "500.00",
      availableUntilPayday: "2376.55", // 2,500.00 − 123.45
      safeToSpendNow: "2376.55",
    });
    expect(await reservesHeld(HH[A_OWNER]!.householdId)).toBe("123.45");
  });

  it("a goal backed by a savings account reads its balance and never enters the reserve", async () => {
    const g = await create({
      name: "Emergency",
      kind: "savings",
      plaidAccountId: savingsId,
      reservedInChecking: true, // ignored: the money is in savings
      manualCurrentAmount: "999.99",
      targetAmount: "5000.00",
      monthlyContribution: "150.00",
    });
    ids.emergency = g.id;
    expect(g).toMatchObject({ currentAmount: "1250.00", currentSource: "account", percent: 25, reserveHeld: "0.00", onTrack: null });
    const p = await position();
    expect(p).toMatchObject({ reservesHeld: "123.45", availableUntilPayday: "2376.55", safeToSpendNow: "2376.55" });
  });

  it("a backing account is this household's savings — never checking, never another household's", async () => {
    for (const plaidAccountId of [checkingId, bSavingsId, randomUUID(), "not-a-uuid"]) {
      expect((await call("POST", "/goals", { name: "x", kind: "savings", plaidAccountId })).status).toBe(400);
    }
    expect((await call("PATCH", `/goals/${ids.vacation}`, { plaidAccountId: checkingId })).status).toBe(400);
  });

  it("a buffer goal sits beside the cash buffer and never moves it", async () => {
    const g = await create({ name: "Cushion", kind: "buffer", targetAmount: "2000.00" });
    ids.cushion = g.id;
    expect(g.cashBuffer).toBe("500.00");
    const p = await position();
    expect(p).toMatchObject({ cashBuffer: "500.00", reservesHeld: "123.45", availableUntilPayday: "2376.55" });
  });

  it("pausing a reserved goal releases its reserve and takes its contribution off the goals line", async () => {
    ids.paused = (await create({ name: "Later", kind: "sinking", manualCurrentAmount: "40.00", reservedInChecking: true, monthlyContribution: "75.00" })).id;
    expect((await position()).reservesHeld).toBe("163.45");
    const r = await call("PATCH", `/goals/${ids.paused}`, { status: "paused" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "paused", reserveHeld: "0.00" });
    expect((await position()).reservesHeld).toBe("123.45");
  });

  it("the suggested weekly cap moves by the active contributions: $720 → $655", async () => {
    // goals line 100 (Vacation) + 25 (Gifts) + 150 (Emergency); the paused 75 is out → 275.00.
    // 3,133.33 − 275.00 = 2,858.33 → × 12/52 = 659.61 → $655.
    const plans = await call("GET", "/allowance-plans");
    expect(plans.body.suggested.derivation).toMatchObject({ goalsMonthly: "275.00", discretionaryMonthly: "2858.33" });
    expect(plans.body.suggested.weekly).toBe("655.00");
    const list = (await call("GET", "/goals")).body;
    expect(list).toMatchObject({ reservesHeld: "123.45", goalsMonthly: "275.00", cashBuffer: "500.00" });
    expect(list.goals).toHaveLength(6);
  });

  it("PATCH edits within the household only; other households see nothing", async () => {
    const r = await call("PATCH", `/goals/${ids.vacation}`, { name: "Beach trip", priority: 5 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: "Beach trip", priority: 5 });
    expect((await call("PATCH", `/goals/${randomUUID()}`, { name: "x" })).status).toBe(404);
    expect((await call("PATCH", "/goals/nope", { name: "x" })).status).toBe(404);
    expect((await call("PATCH", `/goals/${ids.vacation}`, { targetDate: "2027-02-30" })).status).toBe(400);
    expect((await call("PATCH", `/goals/${ids.vacation}`, { manualCurrentAmount: "-1" })).status).toBe(400);
    expect((await call("PATCH", `/goals/${ids.vacation}`, { priority: 1.5 })).status).toBe(400);
    expect((await call("PATCH", `/goals/${ids.vacation}`, { name: "theirs" }, B_OWNER)).status).toBe(404);
    expect((await call("DELETE", `/goals/${ids.vacation}`, undefined, B_OWNER)).status).toBe(404);
    expect((await call("GET", "/goals", undefined, B_OWNER)).body).toEqual({ goals: [], reservesHeld: "0.00", goalsMonthly: "0.00", cashBuffer: "500.00" });
    const member = (await call("GET", "/goals", undefined, A_MEMBER)).body;
    expect(member.goals.map((g: { id: string }) => g.id).sort()).toEqual(Object.values(ids).sort());
    expect(member.goals[0].name).toBe("Beach trip"); // priority 5 first
  });

  it("DELETE archives a goal holding a reserve and deletes one that holds none", async () => {
    const r = await call("DELETE", `/goals/${ids.car}`);
    expect(r).toEqual({ status: 200, body: { id: ids.car, outcome: "archived" } });
    const [car] = await db.select().from(goalsTable).where(eq(goalsTable.id, ids.car!));
    expect(car!.status).toBe("archived");
    expect(await position()).toMatchObject({ reservesHeld: "23.35", availableUntilPayday: "2476.65" }); // 2,500.00 − 23.35
    expect((await call("GET", "/goals")).body.goals.map((g: { id: string }) => g.id)).not.toContain(ids.car);
    expect((await call("GET", "/goals?include=archived")).body.goals.map((g: { id: string }) => g.id)).toContain(ids.car);

    expect((await call("DELETE", `/goals/${ids.cushion}`)).body).toEqual({ id: ids.cushion, outcome: "deleted" });
    expect(await db.select().from(goalsTable).where(eq(goalsTable.id, ids.cushion!))).toEqual([]);
    expect((await call("DELETE", `/goals/${ids.cushion}`)).status).toBe(404);
  });

  it("goal_behind fires from the real facts for the goal that is behind, and only it", async () => {
    // 1,440.01 to go in 12 months at $100: 120.01 a month > 120.00.
    ids.laptop = (await create({ name: "Laptop", kind: "sinking", targetAmount: "1440.01", monthlyContribution: "100.00", targetDate: "2027-10-07" })).id;
    const facts = await loadMonitorFacts(HH[A_OWNER]!.householdId, A_OWNER, "2026-10-07", NOW);
    expect(facts.goals?.map((g) => g.goalId).sort()).toEqual([ids.vacation, ids.gifts, ids.emergency, ids.paused, ids.laptop].sort());
    expect(facts.goals?.find((g) => g.goalId === ids.emergency)?.current).toBe("1250.00");
    const found = runDetectors(facts).filter((f) => f.kind === "goal_behind");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      dedupeKey: `goal_behind:${ids.laptop}:2026-10`,
      severity: "watch",
      confidence: "estimate",
      payload: { goalId: ids.laptop, requiredMonthly: 120.01, monthlyContribution: 100 },
    });
  });

  it("the day's metrics carry the reserve and the goals on track", async () => {
    const m = await computeMetricsForDay(HH[A_OWNER]!.householdId, A_OWNER, "2026-10-07");
    expect(m.goalsReservedTotal).toBe(23.35); // Gifts: the one active goal holding money in checking
    expect(Number((await position()).reservesHeld)).toBe(m.goalsReservedTotal);
    expect(m.goalsOnTrackCount).toBe(1); // Beach trip on track; Laptop behind; the rest have no target date
  });
});

describe("0080_goals.sql", () => {
  const SCRATCH = `prc_sql_check_${process.pid}`;
  const TABLES = ["goals"];
  async function describeSchema(client: { query: typeof pool.query }, schema: string) {
    const cols = await client.query(
      `select table_name, column_name, data_type, is_nullable, column_default
         from information_schema.columns where table_schema = $1 and table_name = any($2)
        order by table_name, column_name`,
      [schema, TABLES],
    );
    const idx = await client.query(
      `select regexp_replace(indexdef, ' ON [a-z0-9_]+\\.', ' ON ') as def
         from pg_indexes where schemaname = $1 and tablename = any($2) order by indexname`,
      [schema, TABLES],
    );
    const cons = await client.query(
      `select c.conname, c.contype, pg_get_constraintdef(c.oid) as def
         from pg_constraint c join pg_namespace n on n.oid = c.connamespace
        where n.nspname = $1 and c.conrelid::regclass::text = any($2) and c.contype in ('c', 'f', 'u')
        order by 1`,
      [schema, TABLES.flatMap((t) => [t, `${schema}.${t}`])],
    );
    return {
      cols: cols.rows,
      idx: idx.rows.map((r) => r.def),
      cons: cons.rows.map((r) => `${r.conname} ${r.contype} ${String(r.def).replace(`${schema}.`, "")}`),
    };
  }
  afterAll(async () => {
    await pool.query(`drop schema if exists ${SCRATCH} cascade`);
  });
  it("is idempotent and matches the drizzle schema column for column", async () => {
    const sqlText = readFileSync(SQL_FILE, "utf8");
    const client = await pool.connect();
    try {
      await client.query(`drop schema if exists ${SCRATCH} cascade`);
      await client.query(`create schema ${SCRATCH}`);
      await client.query(`set search_path to ${SCRATCH}`);
      await client.query("create table households (id uuid primary key default gen_random_uuid())");
      await client.query("create table plaid_accounts (id uuid primary key default gen_random_uuid())");
      await client.query(sqlText);
      await client.query(sqlText); // second run: no error, no change
      const scratch = await describeSchema(client, SCRATCH);
      await client.query("set search_path to public");
      const pub = await describeSchema(client, "public");
      expect(scratch.cols.length).toBe(15);
      expect(scratch.cols).toEqual(pub.cols);
      expect(scratch.idx).toEqual(pub.idx);
      expect(scratch.cons).toEqual(pub.cons);
      expect(scratch.cons).toHaveLength(4);
    } finally {
      await client.query("reset search_path");
      client.release();
    }
  });
});
