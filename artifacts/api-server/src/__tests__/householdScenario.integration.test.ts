// ⭐ THE HOUSEHOLD SCENARIO — one controlled week, every number reconciled.
//
// Codex's work order (point 14) asked for a household scenario a reviewer can
// follow end to end without guessing which hidden rule produced a number. The
// contract is docs/reviews/2026-09-11-household-scenario.md; the expected table
// is ./_fixtures/householdScenario.ts.
//
// Each step pins the clock (Date only — the HTTP server's timers stay real),
// writes that step's events the way sync / the pages would, and reads the
// numbers back through the real /spine route.
//
// Asserted now: cash today, spent this week, review count — the three columns
// the app computed first — and (PR8r) remaining this week, from
// /forecast/cash-signal's `everyday` block. A column the app still gets wrong at a step is
// marked pending with the PR that fixes it, rather than pinning a wrong value.
// Every later column is an it.todo naming its PR; switching it on is part of
// that PR's definition of done. Never loosen an expectation to go green — if a
// rule legitimately changes, the document and the fixture change with it.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `household-scenario-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import spineRouter from "../routes/spine";
import forecastRouter from "../routes/forecast";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";
import {
  ACCOUNTS,
  ALLOWANCES,
  CONTRACT_COLUMNS,
  EXPECTED,
  SNAPSHOT,
  type StepId,
} from "./_fixtures/householdScenario";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(spineRouter);
app.use(forecastRouter);

let server: Server;
let baseUrl: string;

type Spine = {
  bank: { balance: string; asOfDate: string | null };
  spentWeek: number;
  reviewCount: number;
};

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

async function post(path: string, body: unknown): Promise<void> {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} -> ${r.status} ${await r.text()}`);
}

async function cleanup(): Promise<void> {
  await db.delete(settingsTable).where(eq(settingsTable.userId, TEST_USER));
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
    .delete(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

// Ids created during setup and carried across steps.
const cat: Record<string, string> = {};
const plan: Record<string, string> = {};
const txn: Record<string, string> = {};
let chaseItemRowId = "";

async function addTxn(row: {
  key: string;
  occurredOn: string;
  description: string;
  amount: string;
  category: string | null;
  accountId: string;
  source: string;
  pending?: boolean;
  forecastFlag?: boolean;
  isTransfer?: boolean;
  weeklyAllowance?: boolean;
  unplannedAllowance?: boolean;
  isTransferUserOverridden?: boolean;
}): Promise<void> {
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: row.occurredOn,
      description: row.description,
      amount: row.amount,
      categoryId: row.category ? cat[row.category]! : null,
      plaidAccountId: row.accountId,
      source: row.source,
      pending: row.pending ?? false,
      forecastFlag: row.forecastFlag ?? false,
      isTransfer: row.isTransfer ?? false,
      weeklyAllowance: row.weeklyAllowance ?? false,
      unplannedAllowance: row.unplannedAllowance ?? false,
      isTransferUserOverridden: row.isTransferUserOverridden ?? false,
      createdAt: createdAtStartOfHouseholdDay(row.occurredOn),
    })
    .returning({ id: transactionsTable.id });
  txn[row.key] = t!.id;
}

/** Assert the columns the app computes today for a step. */
async function expectToday(id: StepId): Promise<void> {
  const e = EXPECTED[id];
  vi.setSystemTime(e.when);
  const spine = await get<Spine>("/spine");
  expect(spine.bank.balance, `${id} cash today`).toBe(e.cash);
  expect(spine.reviewCount, `${id} review count`).toBe(e.reviewCount);
  if (e.notYet?.column === "spentWeek") {
    // Known-wrong today; pinned so the PR that fixes it notices the change.
    expect(spine.spentWeek, `${id} spent this week (today's value)`).toBeCloseTo(
      e.notYet.appReportsToday,
      2,
    );
  } else {
    expect(spine.spentWeek, `${id} spent this week`).toBeCloseTo(e.spentWeek, 2);
  }
  // (PR8r) Remaining this week: the Allowances weekly plan less weekly-tagged
  // everyday spend, from any account. Never on the spine.
  const signal = await get<{ everyday: { weekly: { remaining: string } } }>("/forecast/cash-signal?horizonDays=90");
  expect(signal.everyday.weekly.remaining, `${id} remaining this week`).toBe(e.remainingWeek);
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
  vi.setSystemTime(EXPECTED.S1.when);

  // ── Accounts: Chase checking + savings, Amex Platinum (weekly) + Blue (monthly).
  const [chaseItem] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-chase-${randomUUID()}`,
      accessToken: "test-token",
      institutionName: "Chase",
      institutionSlug: "chase",
    })
    .returning();
  chaseItemRowId = chaseItem!.id;
  const [amexItem] = await db
    .insert(plaidItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: `item-amex-${randomUUID()}`,
      accessToken: "test-token",
      institutionName: "American Express",
      institutionSlug: "amex",
    })
    .returning();
  const accountRows = await db
    .insert(plaidAccountsTable)
    .values([
      { itemId: chaseItem!.id, ...ACCOUNTS.chase, type: "depository", subtype: "checking" },
      { itemId: chaseItem!.id, ...ACCOUNTS.savings, type: "depository", subtype: "savings" },
      { itemId: amexItem!.id, ...ACCOUNTS.amexPlatinum, type: "credit", subtype: "credit card" },
      { itemId: amexItem!.id, ...ACCOUNTS.amexBlue, type: "credit", subtype: "credit card" },
    ].map((a) => ({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, ...a })))
    .returning();
  const chaseRow = accountRows.find((a) => a.accountId === ACCOUNTS.chase.accountId)!;

  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    daysAhead: 90,
    startingBalance: "0",
    cashBuffer: SNAPSHOT.cashBuffer,
    bankSnapshotBalance: SNAPSHOT.balance,
    bankSnapshotAt: SNAPSHOT.at,
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: chaseRow.id,
    bankSnapshotMask: ACCOUNTS.chase.mask,
  });

  // ── Categories.
  for (const [key, name, kind] of [
    ["groceries", "Groceries", "expense"],
    ["gas", "Gas", "expense"],
    ["home", "Home", "expense"],
    ["misc", "Misc / Buffer", "expense"],
    ["transfer", "Transfer", "expense"],
    ["paycheck", "Paycheck", "income"],
  ] as const) {
    const [c] = await db
      .insert(budgetCategoriesTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name,
        kind,
        groupName: "Scenario",
      })
      .returning();
    cat[key] = c!.id;
  }

  // ── Plans.
  for (const [key, name, kind, amount, frequency, anchorDate] of [
    ["paycheckA", "Paycheck A", "income", "2000", "biweekly", "2026-10-09"],
    ["paycheckB", "Paycheck B", "income", "1500", "monthly", "2026-10-15"],
    ["mortgage", "Mortgage", "bill", "1800", "monthly", "2026-10-12"],
    ["electric", "Electric", "bill", "140", "monthly", "2026-10-13"],
    ["phone", "Phone", "bill", "95", "monthly", "2026-10-08"],
    ["weeklySpend", "Weekly Spend", "bill", "300", "weekly", "2026-10-10"],
    ["monthlySpend", "Monthly Spend", "bill", "400", "monthly", "2026-10-28"],
  ] as const) {
    const [p] = await db
      .insert(recurringItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name,
        kind,
        amount,
        frequency,
        dayOfMonth: Number(anchorDate.slice(8, 10)),
        anchorDate,
        active: "true",
      })
      .returning();
    plan[key] = p!.id;
  }

  // (PR8r, owner decision 7) The Allowances settings own the everyday amounts;
  // Weekly Spend and Monthly Spend are linked as the Amex payoff hooks.
  await db.insert(settingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    weeklyAllowanceAmount: ALLOWANCES.weekly,
    monthlyAllowanceAmount: ALLOWANCES.monthly,
    preferences: { everydayHooks: { weeklyItemId: plan.weeklySpend, monthlyItemId: plan.monthlySpend } },
  });

  // ── Last week on Amex Platinum (Sun 9/27 – Sat 10/3): the $180 its payoff covers.
  await addTxn({
    key: "platLastWeek",
    occurredOn: "2026-09-29",
    description: "WHOLE FOODS MARKET",
    amount: "-180.00",
    category: "groceries",
    accountId: ACCOUNTS.amexPlatinum.accountId,
    source: "plaid:amex",
    weeklyAllowance: true,
  });

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
});

describe("household scenario — Sun 10/4 to Sat 10/10, 2026", () => {
  it(`S1 · ${EXPECTED.S1.event}`, async () => {
    await expectToday("S1");
  });

  it(`S2 · ${EXPECTED.S2.event}`, async () => {
    vi.setSystemTime(EXPECTED.S2.when);
    await addTxn({
      key: "groceries",
      occurredOn: "2026-10-05",
      description: "HEB GROCERY",
      amount: "-96.60",
      category: "groceries",
      accountId: ACCOUNTS.amexPlatinum.accountId,
      source: "plaid:amex",
      weeklyAllowance: true,
    });
    await addTxn({
      key: "amexGas",
      occurredOn: "2026-10-05",
      description: "QT FUEL",
      amount: "-45.00",
      category: "gas",
      accountId: ACCOUNTS.amexPlatinum.accountId,
      source: "plaid:amex",
      weeklyAllowance: true,
    });
    await expectToday("S2");
  });

  it(`S3 · ${EXPECTED.S3.event}`, async () => {
    vi.setSystemTime(EXPECTED.S3.when);
    await addTxn({
      key: "hardware",
      occurredOn: "2026-10-06",
      description: "HOME DEPOT",
      amount: "-85.00",
      category: "home",
      accountId: ACCOUNTS.amexPlatinum.accountId,
      source: "plaid:amex",
      unplannedAllowance: true,
    });
    // A user-flagged transfer: Plaid sync keeps its forecast flag off.
    await addTxn({
      key: "toSavings",
      occurredOn: "2026-10-06",
      description: "Online Transfer to SAV ...8801",
      amount: "-200.00",
      category: "transfer",
      accountId: ACCOUNTS.chase.accountId,
      source: "plaid:chase",
      isTransfer: true,
    });
    await addTxn({
      key: "savingsIn",
      occurredOn: "2026-10-06",
      description: "Online Transfer from CHK ...5526",
      amount: "200.00",
      category: "transfer",
      accountId: ACCOUNTS.savings.accountId,
      source: "plaid:chase",
      isTransfer: true,
    });
    await addTxn({
      key: "amexPayoff",
      occurredOn: "2026-10-06",
      description: "AMERICAN EXPRESS ACH PMT",
      amount: "-180.00",
      category: "misc",
      accountId: ACCOUNTS.chase.accountId,
      source: "plaid:chase",
      forecastFlag: true,
    });
    await expectToday("S3");
  });

  it(`S4 · ${EXPECTED.S4.event}`, async () => {
    vi.setSystemTime(EXPECTED.S4.when);
    await addTxn({
      key: "shell",
      occurredOn: "2026-10-07",
      description: "SHELL OIL 57442",
      amount: "-45.00",
      category: "gas",
      accountId: ACCOUNTS.chase.accountId,
      source: "plaid:chase",
      pending: true,
      forecastFlag: true,
      weeklyAllowance: true,
    });
    await expectToday("S4");
  });

  it(`S5 · ${EXPECTED.S5.event}`, async () => {
    vi.setSystemTime(EXPECTED.S5.when);
    // What sync does when the posted row links to the pending one.
    await db
      .update(transactionsTable)
      .set({ amount: "-47.40", pending: false, occurredOn: "2026-10-08" })
      .where(eq(transactionsTable.id, txn.shell!));
    await expectToday("S5");
  });

  it(`S6 · ${EXPECTED.S6.event}`, async () => {
    vi.setSystemTime(EXPECTED.S6.when);
    await post("/forecast/resolutions", {
      recurringItemId: plan.phone,
      occurrenceDate: "2026-10-08",
      status: "rescheduled",
      rescheduledTo: "2026-10-14",
    });
    await expectToday("S6");
  });

  it(`S7 · ${EXPECTED.S7.event}`, async () => {
    vi.setSystemTime(EXPECTED.S7.when);
    await db
      .update(recurringItemsTable)
      .set({ amount: "165" })
      .where(eq(recurringItemsTable.id, plan.electric!));
    await expectToday("S7");
  });

  it(`S8 · ${EXPECTED.S8.event}`, async () => {
    vi.setSystemTime(EXPECTED.S8.when);
    await db
      .update(plaidItemsTable)
      .set({
        lastSyncError: "the login details of this item have changed",
        lastSyncErrorCode: "ITEM_LOGIN_REQUIRED",
      })
      .where(eq(plaidItemsTable.id, chaseItemRowId));
    await expectToday("S8");
  });

  it(`S9 · ${EXPECTED.S9.event}`, async () => {
    vi.setSystemTime(EXPECTED.S9.when);
    await db
      .update(plaidItemsTable)
      .set({ lastSyncError: null, lastSyncErrorCode: null, lastSyncedAt: EXPECTED.S9.when })
      .where(eq(plaidItemsTable.id, chaseItemRowId));
    await addTxn({
      key: "payroll",
      occurredOn: "2026-10-09",
      description: "ACME PAYROLL DIRECT DEP",
      amount: "2000.00",
      category: "paycheck",
      accountId: ACCOUNTS.chase.accountId,
      source: "plaid:chase",
      forecastFlag: true,
    });
    await expectToday("S9");
  });

  it(`S10 · ${EXPECTED.S10.event}`, async () => {
    vi.setSystemTime(EXPECTED.S10.when);
    await addTxn({
      key: "capitalOne",
      occurredOn: "2026-10-10",
      description: "CAPITAL ONE CRCARDPMT 5KX9",
      amount: "-150.00",
      category: "misc",
      accountId: ACCOUNTS.chase.accountId,
      source: "plaid:chase",
      forecastFlag: true,
      // Filed under Misc / Buffer by hand, as the Chase page does: picking a
      // category sets this flag. Recognition must not depend on it (PR7 H1).
      isTransferUserOverridden: true,
    });
    await post("/forecast/resolutions", {
      recurringItemId: plan.paycheckA,
      occurrenceDate: "2026-10-09",
      status: "matched",
      matchedTxnId: txn.payroll,
    });
    await db
      .update(transactionsTable)
      .set({ reviewed: true })
      .where(eq(transactionsTable.plaidAccountId, ACCOUNTS.chase.accountId));
    await expectToday("S10");
  });

  for (const column of CONTRACT_COLUMNS) {
    const perStep = (Object.keys(EXPECTED) as StepId[])
      .map((id) => `${id} ${JSON.stringify(EXPECTED[id][column.key])}`)
      .join(" · ");
    it.todo(`${column.turnsOnIn}: ${column.label} — ${perStep}`);
  }
});
