// (#766) Weekly Debrief — variance library + API integration tests.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  db,
  recurringItemsTable,
  transactionsTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  weeklyDebriefsTable,
  budgetCategoriesTable,
} from "@workspace/db";
import { createTestHousehold } from "./_helpers/testHousehold";
import {
  computeWeekVariance,
  weekStartFor,
  weekEndFor,
  txnWeekKey,
} from "../lib/weeklyDebrief";
import weeklyDebriefRouter from "../routes/weeklyDebrief";

const TEST_USER = `debrief-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

// Pin "now" to a known Saturday so the current week is 2026-05-24 to
// 2026-05-30 (Sun–Sat).
const PINNED_NOW = new Date("2026-05-30T18:00:00Z");
const CURRENT_WEEK = "2026-05-24"; // Sunday
const PRIOR_WEEK = "2026-05-17"; // Sunday

async function cleanup(): Promise<void> {
  await db
    .delete(weeklyDebriefsTable)
    .where(eq(weeklyDebriefsTable.householdId, TEST_HOUSEHOLD_ID));
  await db
    .delete(forecastResolutionsTable)
    .where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(recurringItemsTable)
    .where(eq(recurringItemsTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
  await db
    .delete(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, TEST_USER));
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
});
afterAll(async () => {
  await cleanup();
});
beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(PINNED_NOW);
  await cleanup();
});

// Build a small bank account so isBankRow recognizes our test rows.
async function setupCheckingAccount(): Promise<string> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: "test-access-token",
      institutionSlug: "test",
      cursor: "c0",
    })
    .returning();
  const externalAccountId = `acct-${randomUUID()}`;
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalAccountId,
      name: "Checking",
      type: "depository",
      subtype: "checking",
    })
    .returning();
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    bankSnapshotAccountId: acct!.id,
  });
  return externalAccountId;
}

describe("weeklyDebrief.helpers", () => {
  it("weekStartFor returns Sunday and weekEndFor returns Saturday", () => {
    expect(weekStartFor("2026-05-28")).toBe("2026-05-24"); // Thu → prev Sun
    expect(weekEndFor("2026-05-24")).toBe("2026-05-30");
    expect(weekStartFor("2026-05-24")).toBe("2026-05-24"); // Sun → itself
  });

  it("txnWeekKey buckets by occurredAt date when present, occurredOn otherwise", () => {
    // occurredAt is a Saturday → belongs to the week ending that day
    expect(txnWeekKey({ occurredAt: "2026-05-23T20:00:00Z", occurredOn: "2026-05-25" }))
      .toBe("2026-05-17");
    // No occurredAt → fall back to occurredOn
    expect(txnWeekKey({ occurredAt: null, occurredOn: "2026-05-25" }))
      .toBe("2026-05-24");
  });
});

describe("computeWeekVariance", () => {
  it("computes plans + unplanned txns with totals + open-items count", async () => {
    const externalAcct = await setupCheckingAccount();

    // 3 plans in the prior week: salary income, rent expense, internet expense.
    const [salary] = await db
      .insert(recurringItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Salary",
        kind: "income",
        amount: "2000",
        frequency: "weekly",
        anchorDate: PRIOR_WEEK, // Sunday
        active: "true",
      })
      .returning();
    const [rent] = await db
      .insert(recurringItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Rent",
        kind: "expense",
        amount: "1500",
        frequency: "monthly",
        dayOfMonth: 18,
        active: "true",
      })
      .returning();
    await db.insert(recurringItemsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Internet",
      kind: "expense",
      amount: "80",
      frequency: "monthly",
      dayOfMonth: 19,
      active: "true",
    });

    // Bank txns in the prior week:
    //   * Rent — matches the rent plan (we'll add a forecast_resolution).
    //   * Coffee — unplanned expense ($12).
    //   * Refund — unplanned income ($25).
    const [rentTxn] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-18",
        occurredAt: "2026-05-18T15:00:00Z",
        description: "Rent payment",
        amount: "-1500",
        plaidAccountId: externalAcct,
        source: "plaid",
      })
      .returning();
    await db.insert(transactionsTable).values([
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-19",
        occurredAt: "2026-05-19T08:00:00Z",
        description: "Coffee",
        amount: "-12.00",
        plaidAccountId: externalAcct,
        source: "plaid",
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-20",
        occurredAt: "2026-05-20T08:00:00Z",
        description: "Refund",
        amount: "25.00",
        plaidAccountId: externalAcct,
        source: "plaid",
      },
    ]);
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      recurringItemId: rent!.id,
      occurrenceDate: "2026-05-18",
      status: "matched",
      matchedTxnId: rentTxn!.id,
    });

    const snap = await computeWeekVariance(TEST_HOUSEHOLD_ID, PRIOR_WEEK);
    expect(snap.weekStart).toBe(PRIOR_WEEK);
    expect(snap.weekEnd).toBe("2026-05-23");
    // Plans: salary, rent, internet
    expect(snap.plans).toHaveLength(3);
    const rentPlan = snap.plans.find((p) => p.name === "Rent")!;
    expect(rentPlan.status).toBe("matched");
    expect(rentPlan.matchedTxnId).toBe(rentTxn!.id);
    const internetPlan = snap.plans.find((p) => p.name === "Internet")!;
    expect(internetPlan.status).toBe("unmatched");
    const salaryPlan = snap.plans.find((p) => p.name === "Salary")!;
    expect(salaryPlan.status).toBe("unmatched");
    expect(snap.unplannedTxns).toHaveLength(2);
    // Totals
    expect(snap.totals.plannedIncome).toBe("2000.00");
    expect(snap.totals.plannedExpenses).toBe("1580.00");
    expect(snap.totals.actualIncome).toBe("25.00");
    expect(snap.totals.actualExpenses).toBe("1512.00");
    // Open items = 2 unmatched plans + 2 unreviewed unplanned txns
    expect(snap.openItemsCount).toBe(4);
    // Reference unused recurring var so eslint is happy
    void salary;
  });

  it("income matched within ±7 days counts as matched_on_time with $0 variance", async () => {
    const externalAcct = await setupCheckingAccount();
    // Salary plan dated 2026-05-17 (PRIOR_WEEK Sunday) — paid Saturday 05-23
    const [salary] = await db
      .insert(recurringItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Salary",
        kind: "income",
        amount: "2000",
        frequency: "monthly",
        dayOfMonth: 17,
        active: "true",
      })
      .returning();
    // Txn occurredAt Saturday 05-23 (still in PRIOR_WEEK), occurredOn Monday 05-25
    const [paycheck] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-25",
        occurredAt: "2026-05-23T23:30:00Z",
        description: "ACME PAYROLL",
        amount: "2000.00",
        plaidAccountId: externalAcct,
        source: "plaid",
      })
      .returning();
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      recurringItemId: salary!.id,
      occurrenceDate: "2026-05-17",
      status: "matched",
      matchedTxnId: paycheck!.id,
    });

    const snap = await computeWeekVariance(TEST_HOUSEHOLD_ID, PRIOR_WEEK);
    const salaryPlan = snap.plans.find((p) => p.name === "Salary")!;
    expect(salaryPlan.status).toBe("matched");
    expect(salaryPlan.varianceAmount).toBe("0.00");
    expect(snap.totals.actualIncome).toBe("2000.00");
  });
});

// (#857) Amex spend in the by-category breakdown. Task #856 widened the
// byCategory accumulator (only) to include Amex charges so categorized
// Amex spend shows up in category actuals + drill-downs, while keeping
// the cash-flow top-line totals and open-items/lock gating strictly
// Chase-only. These tests lock that split in.
describe("computeWeekVariance — Amex in category breakdown (#857)", () => {
  async function makeCategory(name: string): Promise<string> {
    const [cat] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: `${name} ${randomUUID().slice(0, 6)}`,
        kind: "expense",
        groupName: "Other",
        sourceKind: "manual",
      })
      .returning();
    return cat!.id;
  }

  it("category actual + drill-down include the Amex charge alongside the Chase row", async () => {
    const externalAcct = await setupCheckingAccount();
    const groceriesId = await makeCategory("Groceries");

    // Chase checking grocery charge ($50) and an Amex grocery charge
    // ($30) in the SAME category, both in the current week.
    const [chaseTxn] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-26",
        occurredAt: "2026-05-26T15:00:00Z",
        description: "Roundys",
        amount: "-50.00",
        categoryId: groceriesId,
        plaidAccountId: externalAcct,
        source: "plaid",
      })
      .returning();
    const [amexTxn] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-27",
        occurredAt: "2026-05-27T18:00:00Z",
        description: "Roundys (Amex)",
        amount: "-30.00",
        categoryId: groceriesId,
        source: "amex",
      })
      .returning();

    const snap = await computeWeekVariance(TEST_HOUSEHOLD_ID, CURRENT_WEEK);
    const bucket = snap.byCategory.find((b) => b.categoryId === groceriesId)!;
    expect(bucket).toBeTruthy();
    // actual = abs(Chase 50) + abs(Amex 30) = 80
    expect(bucket.actualAmount).toBe("80.00");
    const drillIds = bucket.actualTxns.map((t) => t.txnId);
    expect(drillIds).toContain(chaseTxn!.id);
    expect(drillIds).toContain(amexTxn!.id);
  });

  it("top-line cash-flow totals stay Chase-only and exclude the Amex amount", async () => {
    const externalAcct = await setupCheckingAccount();
    const groceriesId = await makeCategory("Groceries");

    await db.insert(transactionsTable).values([
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-26",
        occurredAt: "2026-05-26T15:00:00Z",
        description: "Roundys",
        amount: "-50.00",
        categoryId: groceriesId,
        plaidAccountId: externalAcct,
        source: "plaid",
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-05-27",
        occurredAt: "2026-05-27T18:00:00Z",
        description: "Dunkin (Amex)",
        amount: "-30.00",
        categoryId: groceriesId,
        source: "amex",
      },
    ]);

    const snap = await computeWeekVariance(TEST_HOUSEHOLD_ID, CURRENT_WEEK);
    // Only the Chase $50 hits cash-flow expenses; the Amex $30 does not.
    expect(snap.totals.actualExpenses).toBe("50.00");
    expect(snap.totals.actualIncome).toBe("0.00");
    expect(snap.totals.actualNet).toBe("-50.00");
  });

  it("openItemsCount / lock gating are unaffected by an Amex row", async () => {
    const externalAcct = await setupCheckingAccount();
    const groceriesId = await makeCategory("Groceries");

    // Baseline: a single unplanned Chase charge → 1 open item.
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-19",
      occurredAt: "2026-05-19T15:00:00Z",
      description: "Roundys",
      amount: "-50.00",
      categoryId: groceriesId,
      plaidAccountId: externalAcct,
      source: "plaid",
    });
    const before = await computeWeekVariance(TEST_HOUSEHOLD_ID, PRIOR_WEEK);
    expect(before.openItemsCount).toBe(1);

    // Adding an Amex charge in the same week must NOT change open items.
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-20",
      occurredAt: "2026-05-20T18:00:00Z",
      description: "Dunkin (Amex)",
      amount: "-30.00",
      categoryId: groceriesId,
      source: "amex",
    });
    const after = await computeWeekVariance(TEST_HOUSEHOLD_ID, PRIOR_WEEK);
    expect(after.openItemsCount).toBe(1);
    // The Amex row still shows up in the category breakdown though.
    const bucket = after.byCategory.find((b) => b.categoryId === groceriesId)!;
    expect(bucket.actualAmount).toBe("80.00");
  });
});

// -- Route integration tests ---------------------------------------

async function startServer(): Promise<{ baseUrl: string; server: Server }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    type LogReq = typeof req & {
      log?: { warn: (...args: unknown[]) => void };
    };
    const r = req as LogReq;
    if (!r.log) {
      // The route only calls `req.log.warn(...)`; full pino Logger shape
      // isn't needed at runtime, so a minimal mock cast through unknown.
      r.log = { warn: () => {} } as unknown as LogReq["log"];
    }
    next();
  });
  app.use((req, _res, next) => {
    type AuthReq = typeof req & {
      userId?: string;
      actualUserId?: string;
      householdId?: string;
      householdOwnerId?: string;
    };
    const r = req as AuthReq;
    r.userId = TEST_USER;
    r.actualUserId = TEST_USER;
    r.householdId = TEST_HOUSEHOLD_ID;
    r.householdOwnerId = TEST_USER;
    next();
  });
  app.use(weeklyDebriefRouter);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${addr.port}`, server };
}

async function stopServer(server: Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((r) => server.close(() => r()));
}

async function req(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const r = await fetch(`${baseUrl}${path}`, init);
  let parsed: any = null;
  const text = await r.text();
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

// Provide a no-op requireAuth substitution for these tests.
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    _req: unknown,
    _res: unknown,
    next: () => void,
  ) => next(),
}));

describe("weeklyDebrief routes", () => {
  let server: Server | null = null;
  let baseUrl = "";
  beforeEach(async () => {
    const ctx = await startServer();
    server = ctx.server;
    baseUrl = ctx.baseUrl;
  });
  afterEach(async () => {
    await stopServer(server);
    server = null;
  });

  it("GET /debrief/weeks/:weekStart returns a snapshot for awaiting_review", async () => {
    await setupCheckingAccount();
    const res = await req(baseUrl, "GET", `/debrief/weeks/${PRIOR_WEEK}`);
    expect(res.status).toBe(200);
    expect(res.body.weekStart).toBe(PRIOR_WEEK);
    expect(res.body.weekEnd).toBe("2026-05-23");
    expect(res.body.status).toBe("awaiting_review");
    expect(res.body.varianceSnapshot).toBeTruthy();
    expect(res.body.postLockAdditions).toEqual([]);
  });

  it("GET /debrief/weeks/:weekStart for the current week returns in_progress", async () => {
    await setupCheckingAccount();
    const res = await req(baseUrl, "GET", `/debrief/weeks/${CURRENT_WEEK}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
  });

  it("GET /debrief/weeks/:weekStart rejects non-Sunday", async () => {
    const res = await req(baseUrl, "GET", `/debrief/weeks/2026-05-25`);
    expect(res.status).toBe(400);
  });

  it("POST /debrief/weeks/:weekStart/lock refuses with open items", async () => {
    await setupCheckingAccount();
    await db.insert(recurringItemsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Internet",
      kind: "expense",
      amount: "80",
      frequency: "monthly",
      dayOfMonth: 19,
      active: "true",
    });
    const res = await req(baseUrl, "POST", `/debrief/weeks/${PRIOR_WEEK}/lock`, {});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unresolved/i);
  });

  it("POST /debrief/weeks/:weekStart/lock succeeds with no open items and freezes snapshot", async () => {
    await setupCheckingAccount();
    const res = await req(baseUrl, "POST", `/debrief/weeks/${PRIOR_WEEK}/lock`, {});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("locked");
    expect(res.body.lockedAt).toBeTruthy();
    expect(res.body.varianceSnapshot).toBeTruthy();
    expect(res.body.actionsSummary).toBeTruthy();
    const cur = await req(baseUrl, "POST", `/debrief/weeks/${CURRENT_WEEK}/lock`, {});
    expect(cur.status).toBe(400);
  });

  it("(#857) POST lock still succeeds when only an Amex txn is in the week", async () => {
    await setupCheckingAccount();
    // An Amex charge (source="amex") is in the by-category breakdown but
    // is NOT a Chase/checking row, so it must not gate locking.
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: "2026-05-20",
      occurredAt: "2026-05-20T18:00:00Z",
      description: "Dunkin (Amex)",
      amount: "-30.00",
      source: "amex",
    });
    const res = await req(baseUrl, "POST", `/debrief/weeks/${PRIOR_WEEK}/lock`, {});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("locked");
    expect(res.body.lockedAt).toBeTruthy();
  });

  it("POST /debrief/weeks/:weekStart/unlock requires { confirm: true }", async () => {
    await setupCheckingAccount();
    await req(baseUrl, "POST", `/debrief/weeks/${PRIOR_WEEK}/lock`, {});
    const noConfirm = await req(baseUrl, "POST", `/debrief/weeks/${PRIOR_WEEK}/unlock`, {});
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.requiresConfirmation).toBe(true);
    const ok = await req(baseUrl, "POST", `/debrief/weeks/${PRIOR_WEEK}/unlock`, { confirm: true });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("awaiting_review");
    expect(ok.body.lockedAt).toBeNull();
    const [row] = await db
      .select()
      .from(weeklyDebriefsTable)
      .where(eq(weeklyDebriefsTable.householdId, TEST_HOUSEHOLD_ID));
    expect(row.varianceSnapshot).toBeNull();
  });

  it("GET /debrief/weeks lists a Sun–Sat range with statuses", async () => {
    await setupCheckingAccount();
    const res = await req(
      baseUrl,
      "GET",
      `/debrief/weeks?from=2026-05-10&to=${CURRENT_WEEK}`,
    );
    expect(res.status).toBe(200);
    const weeks: Array<{ weekStart: string; status: string }> = res.body.weeks;
    expect(weeks.map((w) => w.weekStart)).toEqual([
      "2026-05-10",
      "2026-05-17",
      "2026-05-24",
    ]);
    expect(weeks[weeks.length - 1].status).toBe("in_progress");
  });
});
