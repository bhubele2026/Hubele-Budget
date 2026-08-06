// Badge-count endpoints (perf pass): the nav layout used to derive its two
// badge integers by pulling the full /forecast bundle and the /debrief/weeks
// N+1 on every route. These tests pin the cheap replacements:
//   GET /forecast/review-count   — unmatched current-month bank txns
//   GET /debrief/awaiting-count  — awaiting_review weeks from stored rows only
// plus the budget-health facts-hash cache (one Anthropic call per facts hash).

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `badge-counts-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

// Budget-health: stub the facts/trend layer to return stable values so the
// cache test is deterministic, and count LLM-summary generations.
const generateHealthSummaryMock = vi.fn(async () => ({
  headline: "steady",
  body: "all good",
  source: "ai" as const,
}));
vi.mock("../lib/healthAdvisorSummary", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/healthAdvisorSummary")
  >("../lib/healthAdvisorSummary");
  return {
    ...actual,
    generateHealthSummary: (...args: unknown[]) =>
      generateHealthSummaryMock(...(args as [])),
  };
});
let healthScore = 80;
vi.mock("../lib/healthSnapshot", () => ({
  upsertTodayHealth: async () => ({
    score: healthScore,
    status: "solid",
    grade: "B",
    dimensions: [],
    drivers: [],
    facts: { score: healthScore },
  }),
  getHealthTrend: async () => [],
  computeDeltas: () => ({ d7: null, d30: null }),
}));

import {
  db,
  forecastSettingsTable,
  forecastResolutionsTable,
  transactionsTable,
  plaidAccountsTable,
  plaidItemsTable,
  weeklyDebriefsTable,
} from "@workspace/db";
import forecastRouter from "../routes/forecast";
import weeklyDebriefRouter from "../routes/weeklyDebrief";
import budgetHealthRouter from "../routes/budgetHealth";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(forecastRouter);
app.use(weeklyDebriefRouter);
app.use(budgetHealthRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db
    .delete(forecastResolutionsTable)
    .where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
  if (TEST_HOUSEHOLD_ID) {
    await db
      .delete(weeklyDebriefsTable)
      .where(eq(weeklyDebriefsTable.householdId, TEST_HOUSEHOLD_ID));
  }
}

beforeAll(async () => {
  const h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = h.householdId;
  await cleanup();
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

beforeEach(async () => {
  await cleanup();
  generateHealthSummaryMock.mockClear();
});

function isoInCurrentMonth(day: number): string {
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const d = Math.min(day, last);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

async function seedChecking(): Promise<{ rowId: string; externalId: string }> {
  const externalId = `acct-${randomUUID()}`;
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
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalId,
      name: "Chase Checking",
    })
    .returning();
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    bankSnapshotAccountId: acct!.id,
  });
  return { rowId: acct!.id, externalId };
}

async function addTxn(opts: {
  occurredOn: string;
  amount: string;
  forecastFlag?: boolean;
  plaidAccountId?: string | null;
  source?: string;
}): Promise<string> {
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: opts.occurredOn,
      description: "row",
      amount: opts.amount,
      forecastFlag: opts.forecastFlag ?? true,
      plaidAccountId: opts.plaidAccountId ?? null,
      source: opts.source ?? "manual",
    })
    .returning({ id: transactionsTable.id });
  return t!.id;
}

describe("GET /forecast/review-count", () => {
  it("counts unmatched current-month bank txns, mirroring the inbox filter", async () => {
    const chase = await seedChecking();

    // Counted: checking txn + manual txn, both this month, unresolved.
    await addTxn({
      occurredOn: isoInCurrentMonth(3),
      amount: "-50",
      plaidAccountId: chase.externalId,
      source: "plaid:chase",
    });
    await addTxn({ occurredOn: isoInCurrentMonth(4), amount: "-20" });
    // Not counted: resolved (matched) txn.
    const resolvedId = await addTxn({
      occurredOn: isoInCurrentMonth(5),
      amount: "-30",
      plaidAccountId: chase.externalId,
      source: "plaid:chase",
    });
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      status: "matched",
      matchedTxnId: resolvedId,
    });
    // Not counted: amex-side, other plaid account, unflagged, last month.
    await addTxn({
      occurredOn: isoInCurrentMonth(6),
      amount: "-10",
      source: "amex",
    });
    await addTxn({
      occurredOn: isoInCurrentMonth(7),
      amount: "-10",
      plaidAccountId: "someone-else",
      source: "plaid:chase",
    });
    await addTxn({
      occurredOn: isoInCurrentMonth(8),
      amount: "-10",
      forecastFlag: false,
    });
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    await addTxn({
      occurredOn: `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, "0")}-15`,
      amount: "-10",
    });

    const r = await fetch(`${baseUrl}/forecast/review-count`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ count: 2 });
  });
});

describe("GET /debrief/awaiting-count", () => {
  it("counts past non-locked weeks in range from stored rows alone", async () => {
    // Window: last 5 completed weeks + current week. Lock one of them.
    const now = new Date();
    const day = now.getDay();
    const currentSunday = new Date(now);
    currentSunday.setDate(now.getDate() - day);
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const weeksAgo = (n: number) => {
      const d = new Date(currentSunday);
      d.setDate(d.getDate() - 7 * n);
      return d;
    };

    const lockedWs = fmt(weeksAgo(2));
    const lockedEnd = new Date(weeksAgo(2));
    lockedEnd.setDate(lockedEnd.getDate() + 6);
    await db.insert(weeklyDebriefsTable).values({
      householdId: TEST_HOUSEHOLD_ID,
      weekStart: lockedWs,
      weekEnd: fmt(lockedEnd),
      status: "locked",
      lockedAt: new Date(),
    });

    const from = fmt(weeksAgo(5));
    const to = fmt(currentSunday);
    const r = await fetch(
      `${baseUrl}/debrief/awaiting-count?from=${from}&to=${to}`,
    );
    expect(r.status).toBe(200);
    // Weeks -5..-1 are past (5), minus the locked one; the current week is
    // in_progress. (The 2026-05-03 floor is far behind this window.)
    expect(await r.json()).toEqual({ count: 4 });
  });

  it("returns 0 when the window ends before the debrief floor", async () => {
    const r = await fetch(
      `${baseUrl}/debrief/awaiting-count?from=2026-01-04&to=2026-02-01`,
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ count: 0 });
  });
});

describe("GET /budget-health — facts-hash summary cache", () => {
  it("only regenerates the LLM summary when the facts hash changes", async () => {
    const r1 = await fetch(`${baseUrl}/budget-health`);
    expect(r1.status).toBe(200);
    expect(generateHealthSummaryMock).toHaveBeenCalledTimes(1);

    // Same facts → cached summary, no new LLM call.
    const r2 = await fetch(`${baseUrl}/budget-health`);
    expect(r2.status).toBe(200);
    expect(generateHealthSummaryMock).toHaveBeenCalledTimes(1);

    // Changed facts → regenerate.
    healthScore = 55;
    const r3 = await fetch(`${baseUrl}/budget-health`);
    expect(r3.status).toBe(200);
    expect(generateHealthSummaryMock).toHaveBeenCalledTimes(2);

    // ?refresh=true forces a call even with unchanged facts.
    const r4 = await fetch(`${baseUrl}/budget-health?refresh=true`);
    expect(r4.status).toBe(200);
    expect(generateHealthSummaryMock).toHaveBeenCalledTimes(3);
  });
});
