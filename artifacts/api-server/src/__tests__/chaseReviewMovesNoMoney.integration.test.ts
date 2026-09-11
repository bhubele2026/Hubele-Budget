// ⭐ PR14 — the Chase review inbox. Reviewing rows is bookkeeping: it moves no
// money. Every figure the app shows for the household is read before any row
// is reviewed, then read again after reviewing 20 rows one page at a time
// (POST /transactions/bulk-update, the web's per-row/page path), after
// reviewing the rest by filter (POST /transactions/bulk-review-matching), and
// after two stale bulk requests. Every read must be identical to the cent:
// toEqual/toBe on the served strings and numbers, never closeTo.
//
// One household, mounted through routes/index.ts as production mounts it:
//   - a Chase checking account with a $3,000.00 snapshot read 2026-05-15 at
//     10:00 in Chicago, and 60 checking rows across April and May (categorized
//     and uncategorized purchases, two paychecks, a pending row, rows after the
//     read);
//   - an Amex card with six rows (three Plaid, three imported) the ledger never
//     shows and bulk review must never touch;
//   - one monthly bill, so the forecast's daily series steps inside its window.
//
// The clock is pinned: today is 2026-05-20 (a Wednesday) in Chicago.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";

const RUN = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const USER = `chase-review-${RUN}`;
let HOUSEHOLD_ID = "";

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
    req.userId = USER;
    req.actualUserId = USER;
    req.householdId = HOUSEHOLD_ID;
    req.householdOwnerId = USER;
    next();
  },
}));

import {
  db,
  budgetCategoriesTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  householdMembersTable,
  householdsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import { BulkReviewMatchingTransactionsResponse, GetTransactionsLedgerResponse } from "@workspace/api-zod";
import apiRouter from "../routes/index";
import { weekEndFor, weekStartFor } from "../lib/cashSignal";
import { householdTodayDate } from "../lib/householdClock";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

// Production: app.use("/api", router) after the JSON parser. The paths below
// drop the "/api" prefix; the router and its order are production's.
const routes = Router();
routes.use((req, _res, next) => {
  (req as { log?: unknown }).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
routes.use(apiRouter);
const { request } = createTestApp(routes);

const PINNED_NOW = new Date("2026-05-20T17:00:00Z"); // noon in Chicago
const TODAY = "2026-05-20";
const SNAPSHOT_AT = new Date("2026-05-15T15:00:00Z"); // 10:00 in Chicago
const FROM = "2026-04-01";
const RANGE = `from=${FROM}&to=${TODAY}`;
const CHECKING_ROWS = 60;
const PICKED = 20;

type LedgerBody = ReturnType<typeof GetTransactionsLedgerResponse.parse>;
type LedgerRow = { id: string; runningBalance: string | null; reviewed: boolean; pending: boolean; amount: string };

let CHK = "";
let AMX = "";
const checkingIds: string[] = [];
const amexIds: string[] = [];
const keyed = new Map<string, string>();

async function get(path: string): Promise<unknown> {
  const r = await request("GET", path);
  expect(r.status, `${path} -> ${JSON.stringify(r.json)}`).toBe(200);
  return r.json;
}

async function walk(query: string): Promise<LedgerBody[]> {
  const pages: LedgerBody[] = [];
  let cursor: string | null = null;
  do {
    const path = `/transactions/ledger?${query}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const json = await get(path);
    GetTransactionsLedgerResponse.parse(json);
    const page = json as LedgerBody;
    pages.push(page);
    cursor = page.nextCursor ?? null;
    if (pages.length > 50) throw new Error("the cursor never ran out");
  } while (cursor);
  return pages;
}

const rowsOf = (pages: LedgerBody[]) => pages.flatMap((p) => p.rows as unknown as LedgerRow[]);

type Figures = {
  spine: Record<string, unknown>;
  bank: unknown;
  spentMonth: number;
  spentWeek: number;
  reviewCount: number;
  forecastReviewCount: number;
  cashSignal: Record<string, unknown>;
  bankToday: string;
  daily: Array<{ date: string; balance: string }>;
  factsMonth: unknown;
  factsWeek: unknown;
  ledger: {
    totals: LedgerBody["totals"];
    matchingCount: number;
    balanceStart: string | null;
    balanceEnd: string | null;
    balanceToday: string | null;
    anchor: LedgerBody["anchor"];
    ids: string[];
    running: Record<string, string | null>;
  };
};

/** Every figure the household sees, read through the API. */
async function readFigures(): Promise<Figures> {
  const spineJson = (await get("/spine")) as Record<string, unknown> & {
    bank: { balance: string };
    spentMonth: number;
    spentWeek: number;
    reviewCount: number;
  };
  const { asOf: _asOf, ...spine } = spineJson;
  void _asOf;
  const cashSignal = (await get("/forecast/cash-signal?horizonDays=90")) as Record<string, unknown> & {
    bankToday: string;
    daily: Array<{ date: string; balance: string }>;
  };
  const forecastReviewCount = ((await get("/forecast/review-count")) as { count: number }).count;
  const factsMonth = await get(`/reports/spending-facts?from=2026-05-01&to=${TODAY}`);
  const today = householdTodayDate(PINNED_NOW);
  const factsWeek = await get(`/reports/spending-facts?from=${weekStartFor(today)}&to=${weekEndFor(today)}`);

  const pages = await walk(RANGE);
  const rows = rowsOf(pages);
  const first = pages[0]!;
  for (const p of pages) {
    // Every page of one walk carries the same totals and balances.
    expect(p.totals).toEqual(first.totals);
    expect(p.matchingCount).toBe(first.matchingCount);
    expect([p.balanceStart, p.balanceEnd, p.balanceToday]).toEqual([first.balanceStart, first.balanceEnd, first.balanceToday]);
  }
  return {
    spine,
    bank: spineJson.bank,
    spentMonth: spineJson.spentMonth,
    spentWeek: spineJson.spentWeek,
    reviewCount: spineJson.reviewCount,
    forecastReviewCount,
    cashSignal,
    bankToday: cashSignal.bankToday,
    daily: cashSignal.daily.map((d) => ({ date: d.date, balance: d.balance })),
    factsMonth,
    factsWeek,
    ledger: {
      totals: first.totals,
      matchingCount: first.matchingCount,
      balanceStart: first.balanceStart ?? null,
      balanceEnd: first.balanceEnd ?? null,
      balanceToday: first.balanceToday ?? null,
      anchor: first.anchor,
      ids: rows.map((r) => r.id),
      running: Object.fromEntries(rows.map((r) => [r.id, r.runningBalance])),
    },
  };
}

function expectSameMoney(after: Figures, before: Figures): void {
  expect(after.bank).toEqual(before.bank);
  expect(after.spentMonth).toBe(before.spentMonth);
  expect(after.spentWeek).toBe(before.spentWeek);
  expect(after.reviewCount).toBe(before.reviewCount);
  expect(after.forecastReviewCount).toBe(before.forecastReviewCount);
  expect(after.spine).toEqual(before.spine);
  expect(after.bankToday).toBe(before.bankToday);
  expect(after.daily).toEqual(before.daily);
  expect(after.cashSignal).toEqual(before.cashSignal);
  expect(after.factsMonth).toEqual(before.factsMonth);
  expect(after.factsWeek).toEqual(before.factsWeek);
  expect(after.ledger).toEqual(before.ledger);
}

async function reviewedInDb(): Promise<{ checking: number; amex: number }> {
  const rows = await db
    .select({ id: transactionsTable.id })
    .from(transactionsTable)
    .where(and(eq(transactionsTable.userId, USER), eq(transactionsTable.reviewed, true)));
  const ids = new Set(rows.map((r) => r.id));
  return {
    checking: checkingIds.filter((id) => ids.has(id)).length,
    amex: amexIds.filter((id) => ids.has(id)).length,
  };
}

async function cleanup(): Promise<void> {
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.userId, USER));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, USER));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, USER));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, USER));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, USER));
}

async function addAccount(opts: {
  institutionName: string;
  mask: string;
  type: string;
  subtype: string;
}): Promise<{ rowId: string; externalId: string }> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId: USER,
      householdId: HOUSEHOLD_ID,
      itemId: `item-${randomUUID()}`,
      accessToken: "test-token",
      institutionName: opts.institutionName,
      institutionSlug: opts.institutionName.toLowerCase().replace(/\s+/g, "-"),
    })
    .returning();
  const externalId = `acct-${randomUUID()}`;
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: USER,
      householdId: HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalId,
      name: opts.institutionName,
      mask: opts.mask,
      type: opts.type,
      subtype: opts.subtype,
    })
    .returning();
  return { rowId: acct!.id, externalId };
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** An amount with cents that differ row to row, so a rounding slip shows. */
function purchase(n: number): string {
  const cents = 500 + ((n * 1297) % 8000);
  return `-${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function timeOn(day: string, n: number): string {
  // Late morning in Chicago on the row's own day, never a whole hour.
  const mm = String(10 + (n % 50)).padStart(2, "0");
  const ss = String(1 + ((n * 7) % 58)).padStart(2, "0");
  return `${day}T16:${mm}:${ss}.000Z`;
}

async function seed(): Promise<void> {
  const chk = await addAccount({ institutionName: "Chase", mask: "4321", type: "depository", subtype: "checking" });
  const amx = await addAccount({ institutionName: "American Express", mask: "1009", type: "credit", subtype: "credit card" });
  CHK = chk.externalId;
  AMX = amx.externalId;
  await db.insert(forecastSettingsTable).values({
    userId: USER,
    householdId: HOUSEHOLD_ID,
    daysAhead: 90,
    cashBuffer: "500.00",
    bankSnapshotBalance: "3000.00",
    bankSnapshotAt: SNAPSHOT_AT,
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: chk.rowId,
    bankSnapshotMask: "4321",
  });
  const [groceries, dining, pay] = await db
    .insert(budgetCategoriesTable)
    .values([
      { userId: USER, householdId: HOUSEHOLD_ID, name: "Groceries", kind: "expense", groupName: "Living" },
      { userId: USER, householdId: HOUSEHOLD_ID, name: "Dining Out", kind: "expense", groupName: "Living" },
      { userId: USER, householdId: HOUSEHOLD_ID, name: "Paycheck", kind: "income", groupName: "Income" },
    ])
    .returning();
  await db.insert(recurringItemsTable).values({
    userId: USER,
    householdId: HOUSEHOLD_ID,
    name: "Internet",
    kind: "bill",
    amount: "89.99",
    frequency: "monthly",
    dayOfMonth: 25,
    anchorDate: "2026-05-25",
    active: "true",
  });

  type Spec = {
    key: string;
    day: string;
    amount: string;
    occurredAt: string | null;
    createdAt: Date;
    categoryId: string | null;
    pending: boolean;
  };
  const specs: Spec[] = [];
  let n = 0;
  const push = (day: string, over: Partial<Spec> = {}) => {
    n += 1;
    specs.push({
      key: `c${n}`,
      day,
      amount: purchase(n),
      occurredAt: timeOn(day, n),
      createdAt: createdAtStartOfHouseholdDay(day),
      // Two in three purchases are categorized; the rest are uncategorized.
      categoryId: n % 3 === 0 ? null : n % 3 === 1 ? groceries!.id : dining!.id,
      pending: false,
      ...over,
    });
  };

  // April: 24 rows, a paycheck on the 15th.
  for (let i = 0; i < 24; i++) {
    const day = addDays("2026-04-01", Math.floor((i * 30) / 24));
    if (i === 11) push("2026-04-15", { key: "payApril", amount: "1850.00", categoryId: pay!.id });
    else push(day);
  }
  // 2026-05-01..05-14: 24 rows, a paycheck on the 1st.
  for (let i = 0; i < 24; i++) {
    const day = addDays("2026-05-01", Math.floor((i * 14) / 24));
    if (i === 0) push("2026-05-01", { key: "payMay", amount: "1850.00", categoryId: pay!.id });
    else push(day);
  }
  // The snapshot day: two rows before the read (in the snapshot), one after.
  push("2026-05-15", { occurredAt: "2026-05-15T13:21:11.000Z" });
  push("2026-05-15", { occurredAt: "2026-05-15T13:42:37.000Z" });
  push("2026-05-15", {
    key: "afterRead",
    occurredAt: "2026-05-15T19:07:31.000Z",
    createdAt: new Date("2026-05-15T19:10:00Z"),
  });
  // 05-16..05-20: nine rows after the snapshot; five inside today's Sun–Sat week.
  for (const day of ["2026-05-16", "2026-05-16", "2026-05-17", "2026-05-18", "2026-05-18", "2026-05-19", "2026-05-19", "2026-05-20"]) {
    push(day);
  }
  push(TODAY, { key: "pending", pending: true, categoryId: groceries!.id });
  expect(specs).toHaveLength(CHECKING_ROWS);

  const inserted = await db
    .insert(transactionsTable)
    .values(
      specs.map((s) => ({
        userId: USER,
        householdId: HOUSEHOLD_ID,
        occurredOn: s.day,
        occurredAt: s.occurredAt,
        createdAt: s.createdAt,
        description: `MARKET ROW ${s.key.toUpperCase()}`,
        amount: s.amount,
        categoryId: s.categoryId,
        pending: s.pending,
        plaidAccountId: CHK,
        plaidTransactionId: `ptx-${RUN}-${s.key}`,
        source: "plaid",
      })),
    )
    .returning({ id: transactionsTable.id, description: transactionsTable.description });
  for (const r of inserted) {
    checkingIds.push(r.id);
    keyed.set(r.description.replace("MARKET ROW ", "").toLowerCase(), r.id);
  }

  // Amex: three Plaid charges (negative) and three imported charges (positive).
  const amex = [];
  for (let k = 0; k < 3; k++) {
    const day = addDays("2026-05-12", k * 3);
    amex.push({
      userId: USER,
      householdId: HOUSEHOLD_ID,
      occurredOn: day,
      createdAt: createdAtStartOfHouseholdDay(day),
      description: `DINER ${k} AMEX`,
      amount: `-${23 + k}.45`,
      categoryId: dining!.id,
      plaidAccountId: AMX,
      plaidTransactionId: `ptx-${RUN}-amex-${k}`,
      source: "plaid:amex",
    });
    amex.push({
      userId: USER,
      householdId: HOUSEHOLD_ID,
      occurredOn: day,
      createdAt: createdAtStartOfHouseholdDay(day),
      description: `BOOKSHOP ${k} AMEX IMPORT`,
      amount: `${31 + k}.10`,
      categoryId: k === 0 ? null : groceries!.id,
      source: "amex",
    });
  }
  const amexRows = await db.insert(transactionsTable).values(amex).returning({ id: transactionsTable.id });
  for (const r of amexRows) amexIds.push(r.id);
}

let BEFORE: Figures;
let picked: string[] = [];

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
  HOUSEHOLD_ID = (await createTestHousehold(USER)).householdId;
  await cleanup();
  await seed();
});

afterAll(async () => {
  await cleanup();
  await db.delete(householdMembersTable).where(eq(householdMembersTable.userId, USER));
  await db.delete(householdsTable).where(eq(householdsTable.ownerUserId, USER));
  vi.useRealTimers();
});

describe("(PR14) reviewing Chase rows moves no money", () => {
  it("reads every figure before any row is reviewed, and none of them is empty", async () => {
    BEFORE = await readFigures();

    // The windows the spine and the week read are the ones this file names.
    const today = householdTodayDate(PINNED_NOW);
    expect([weekStartFor(today), weekEndFor(today)]).toEqual(["2026-05-17", "2026-05-23"]);

    // Not vacuous: a real bank balance rolled forward off the snapshot.
    expect((BEFORE.bank as { balance: string | null }).balance).not.toBeNull();
    expect(BEFORE.bankToday).toBe((BEFORE.bank as { balance: string }).balance);
    expect(BEFORE.bankToday).not.toBe("3000.00");
    expect(BEFORE.ledger.balanceToday).toBe(BEFORE.bankToday);
    expect(BEFORE.ledger.anchor.snapshotBalance).toBe("3000.00");
    // The daily series steps (the bill on the 25th), so equality means something.
    expect(BEFORE.daily.length).toBeGreaterThan(80);
    expect(new Set(BEFORE.daily.map((d) => d.balance)).size).toBeGreaterThan(1);

    // Spending is non-zero in both windows, categorized and uncategorized.
    type Facts = { householdSpend: { total: number }; realSpend: { total: number }; uncategorized: { total: number }; realIncome: { total: number } };
    const month = BEFORE.factsMonth as Facts;
    const week = BEFORE.factsWeek as Facts;
    expect(month.realSpend.total).toBeGreaterThan(0);
    expect(month.uncategorized.total).toBeGreaterThan(0);
    expect(month.realIncome.total).toBeGreaterThan(0);
    expect(week.householdSpend.total).toBeGreaterThan(0);
    expect(BEFORE.spentMonth).toBe(month.householdSpend.total);
    expect(BEFORE.spentWeek).toBe(week.householdSpend.total);
    expect(BEFORE.spentMonth).toBeGreaterThan(BEFORE.spentWeek);

    // The forecast Review count is non-zero and the spine agrees with its badge.
    expect(BEFORE.reviewCount).toBeGreaterThan(0);
    expect(BEFORE.reviewCount).toBe(BEFORE.forecastReviewCount);

    // The ledger holds all 60 checking rows, no Amex row, none reviewed yet.
    expect(BEFORE.ledger.matchingCount).toBe(CHECKING_ROWS);
    expect(BEFORE.ledger.totals.count).toBe(CHECKING_ROWS);
    expect(new Set(BEFORE.ledger.ids)).toEqual(new Set(checkingIds));
    expect(Object.values(BEFORE.ledger.running).every((v) => v !== null)).toBe(true);
    expect(BEFORE.ledger.balanceStart).not.toBeNull();
    const first = (await get(`/transactions/ledger?${RANGE}&limit=1`)) as LedgerBody;
    expect(first.review).toEqual({ reviewed: 0, unreviewed: CHECKING_ROWS });
    expect(await reviewedInDb()).toEqual({ checking: 0, amex: 0 });
  });

  it("reviewing 20 rows by id changes the review counts and nothing else", async () => {
    // The pending row, both paychecks and the row after the read, then every
    // third row of the register until there are 20.
    const must = ["pending", "payapril", "paymay", "afterread"].map((k) => keyed.get(k)!);
    const rest = BEFORE.ledger.ids.filter((id, k) => k % 3 === 0 && !must.includes(id));
    picked = [...must, ...rest].slice(0, PICKED);
    expect(new Set(picked).size).toBe(PICKED);

    const r = await request("POST", "/transactions/bulk-update", { ids: picked, patch: { reviewed: true } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((r.json as { updated: number }).updated).toBe(PICKED);
    expect(await reviewedInDb()).toEqual({ checking: PICKED, amex: 0 });

    expectSameMoney(await readFigures(), BEFORE);

    const unreviewedPages = await walk(`${RANGE}&reviewed=false`);
    for (const p of unreviewedPages) {
      expect(p.matchingCount).toBe(CHECKING_ROWS - PICKED);
      expect(p.review).toEqual({ reviewed: PICKED, unreviewed: CHECKING_ROWS - PICKED });
      expect(p.totals).toEqual(BEFORE.ledger.totals);
      expect(p.balanceStart).toBe(BEFORE.ledger.balanceStart);
      expect(p.balanceEnd).toBe(BEFORE.ledger.balanceEnd);
      expect(p.balanceToday).toBe(BEFORE.ledger.balanceToday);
    }
    const unreviewed = rowsOf(unreviewedPages);
    expect(unreviewed).toHaveLength(CHECKING_ROWS - PICKED);
    expect(unreviewed.filter((row) => picked.includes(row.id))).toEqual([]);
    for (const row of unreviewed) {
      expect(row.reviewed).toBe(false);
      expect(row.runningBalance).toBe(BEFORE.ledger.running[row.id]);
    }
  });

  it("a stale expectedCount is a 409 and reviews nothing", async () => {
    const filter = { from: FROM, to: TODAY, reviewed: false, pending: false };
    for (const expectedCount of [CHECKING_ROWS - PICKED - 1, CHECKING_ROWS - PICKED + 1]) {
      const r = await request("POST", "/transactions/bulk-review-matching", { filter, reviewed: true, expectedCount });
      expect(r.status, JSON.stringify(r.json)).toBe(409);
      expect(r.json).toMatchObject({ code: "matching_count_changed", matchingCount: CHECKING_ROWS - PICKED });
      expect(await reviewedInDb()).toEqual({ checking: PICKED, amex: 0 });
    }
    expectSameMoney(await readFigures(), BEFORE);
  });

  it("reviewing the rest by filter reviews exactly the other 40, and nothing moves", async () => {
    const r = await request("POST", "/transactions/bulk-review-matching", {
      filter: { from: FROM, to: TODAY, reviewed: false, pending: false },
      reviewed: true,
      expectedCount: CHECKING_ROWS - PICKED,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const result = BulkReviewMatchingTransactionsResponse.parse(r.json);
    expect(result.matched).toBe(CHECKING_ROWS - PICKED);
    expect(result.updated).toBe(CHECKING_ROWS - PICKED);
    expect(new Set(result.updatedIds)).toEqual(new Set(checkingIds.filter((id) => !picked.includes(id))));
    // Every checking row is reviewed; the Amex rows are outside the ledger and untouched.
    expect(await reviewedInDb()).toEqual({ checking: CHECKING_ROWS, amex: 0 });

    expectSameMoney(await readFigures(), BEFORE);

    const unreviewed = (await get(`/transactions/ledger?${RANGE}&reviewed=false&limit=100`)) as LedgerBody;
    expect(unreviewed.rows).toEqual([]);
    expect(unreviewed.matchingCount).toBe(0);
    expect(unreviewed.nextCursor ?? null).toBeNull();
    expect(unreviewed.review).toEqual({ reviewed: CHECKING_ROWS, unreviewed: 0 });
    expect(unreviewed.totals).toEqual(BEFORE.ledger.totals);
    expect(unreviewed.balanceStart).toBe(BEFORE.ledger.balanceStart);
    expect(unreviewed.balanceEnd).toBe(BEFORE.ledger.balanceEnd);
    expect(unreviewed.balanceToday).toBe(BEFORE.ledger.balanceToday);
  });

  it("a stale count on the way back (un-review by filter) is a 409 that changes nothing", async () => {
    const filter = { from: FROM, to: TODAY, reviewed: true };
    const r = await request("POST", "/transactions/bulk-review-matching", {
      filter,
      reviewed: false,
      expectedCount: CHECKING_ROWS - 1,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(r.json).toMatchObject({ code: "matching_count_changed", matchingCount: CHECKING_ROWS });
    expect(await reviewedInDb()).toEqual({ checking: CHECKING_ROWS, amex: 0 });

    expectSameMoney(await readFigures(), BEFORE);
    const amexStill = await db
      .select({ reviewed: transactionsTable.reviewed })
      .from(transactionsTable)
      .where(inArray(transactionsTable.id, amexIds));
    expect(amexStill.map((a) => a.reviewed)).toEqual(amexIds.map(() => false));
  });
});
