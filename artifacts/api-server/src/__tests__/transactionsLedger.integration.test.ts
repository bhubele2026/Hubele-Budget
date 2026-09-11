// ⭐ PR13 — the paginated bank ledger (GET /transactions/ledger,
// GET /transactions/balances, POST /transactions/bulk-review-matching), mounted
// through routes/index.ts as production mounts it.
//
// One household carries the plan's fixture: 250 checking rows of −$1.00 and 10
// of +$100.00 (five rows on 05-10 have no institution time), 30 Amex rows the
// ledger must never show, and a bank snapshot of $5,000.00 read at 10:00 on
// 2026-05-15 in Chicago. Smaller households cover the rest: the review's history
// fixture (a replaced pending row, a logged payment beside its ACH, a held-ahead
// charge, a future row), mask twins and manual rows, a PR4c pair, no snapshot,
// 1,001 rows, a row that moves while bulk review waits for its lock, and the
// second review's fixture (stale pending rows, pending rows whose posted row is
// dated after today, a held posted row whose pending half was not held).
//
// Two main-fixture rows sit where the snapshot rule and the old day rule
// disagree, so today's balance proves which rule the ledger anchors on:
//   - +$100.00 dated the snapshot day that happened (19:07Z) and arrived
//     (19:10Z) after the read: the snapshot rule COUNTS it;
//   - −$1.00 Plaid charge dated 05-17 that was in the ledger before the read:
//     the snapshot rule HOLDS it.
// Today (05-20) = 5000 + 100 − 19 (the other rows dated 05-16..05-20) = 5081.00.
// The day rule would say 5000 − 20 = 4980.00.
//
// The clock is pinned: today is 2026-05-20 in Chicago.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";

const RUN = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const MAIN_USER = `ledger-main-${RUN}`;
const EDGE_USER = `ledger-edge-${RUN}`;
const NOSNAP_USER = `ledger-nosnap-${RUN}`;
const BIG_USER = `ledger-big-${RUN}`;
const REVIEW_USER = `ledger-review-${RUN}`;
const CONC_USER = `ledger-conc-${RUN}`;
const STALE_USER = `ledger-stale-${RUN}`;
const USERS = [MAIN_USER, EDGE_USER, NOSNAP_USER, BIG_USER, REVIEW_USER, CONC_USER, STALE_USER];
const householdOf = new Map<string, string>();
let actingUser = MAIN_USER;

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
    req.userId = actingUser;
    req.actualUserId = actingUser;
    req.householdId = householdOf.get(actingUser);
    req.householdOwnerId = actingUser;
    next();
  },
}));

import {
  db,
  budgetCategoriesTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import {
  BulkReviewMatchingTransactionsResponse,
  GetTransactionsBalancesResponse,
  GetTransactionsLedgerResponse,
} from "@workspace/api-zod";
import { classifyCashRows, isInSnapshot } from "@workspace/avalanche-core";
import { toCashRow } from "../lib/ledgerCashRows";
import apiRouter from "../routes/index";
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
const RANGE = "from=2026-04-01&to=2026-05-20";

type LedgerBody = ReturnType<typeof GetTransactionsLedgerResponse.parse>;
type Row = {
  id: string;
  occurredOn: string;
  occurredAt: string | null;
  amount: string;
  runningBalance: string | null;
  balanceAmount: string;
  countsInBalance: boolean;
  balanceReason: string;
  replacedPendingId: string | null;
  heldAhead: boolean;
  afterToday: boolean;
  stalePending: boolean;
  pending: boolean;
  plaidAccountId?: string | null;
  source: string;
  reviewed: boolean;
};
type Seed = {
  key: string;
  occurredOn: string;
  amount: string;
  occurredAt: string | null;
  createdAt: Date;
  description: string;
  categoryId?: string | null;
  pending?: boolean;
};
type Seeded = Seed & { id: string };

const cents = (s: string | null | undefined): number => {
  if (s === null || s === undefined) throw new Error("expected money, got null");
  return Math.round(Number(s) * 100);
};

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The ledger's order, computed independently: day desc, time desc (untimed last), id desc. */
function newestFirst(a: Seeded, b: Seeded): number {
  if (a.occurredOn !== b.occurredOn) return a.occurredOn < b.occurredOn ? 1 : -1;
  if (a.occurredAt !== b.occurredAt) {
    if (a.occurredAt === null) return 1;
    if (b.occurredAt === null) return -1;
    const diff = Date.parse(b.occurredAt) - Date.parse(a.occurredAt);
    if (diff !== 0) return diff;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

async function get(path: string): Promise<{ status: number; json: unknown }> {
  return request("GET", path);
}

async function walk(query: string, limit: number): Promise<LedgerBody[]> {
  const pages: LedgerBody[] = [];
  let cursor: string | null = null;
  do {
    const path = `/transactions/ledger?${query}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const { status, json } = await get(path);
    expect(status, JSON.stringify(json)).toBe(200);
    // The response matches the generated schema (parse throws otherwise); keep
    // the raw body so fields the schema strips stay visible.
    GetTransactionsLedgerResponse.parse(json);
    const page = json as LedgerBody;
    pages.push(page);
    cursor = page.nextCursor ?? null;
    if (pages.length > 100) throw new Error("the cursor never ran out");
  } while (cursor);
  return pages;
}

const rowsOf = (pages: LedgerBody[]) => pages.flatMap((p) => p.rows as unknown as Row[]);

/** Each dated-through-today row's balance is the next older row's plus what it moves the register by. */
function expectChain(rows: Row[]): void {
  const dated = rows.filter((r) => !r.afterToday);
  for (let k = 0; k < dated.length - 1; k++) {
    expect(cents(dated[k]!.runningBalance) - cents(dated[k]!.balanceAmount), `row ${k}`).toBe(
      cents(dated[k + 1]!.runningBalance),
    );
  }
}

async function spineBalance(): Promise<string> {
  const spine = await get("/spine");
  expect(spine.status, JSON.stringify(spine.json)).toBe(200);
  return (spine.json as { bank: { balance: string } }).bank.balance;
}

let CHK = "";
let AMX = "";
let CHK_ROW_ID = "";
let AMX_ROW_ID = "";
let CATEGORY_ID = "";
let checking: Seeded[] = [];
const byKey = new Map<string, Seeded>();

let EDGE_EXT1 = "";
let EDGE_EXT2 = "";
let EDGE_TWIN_ROW_ID = "";
let EDGE_CREDIT_ROW_ID = "";
const edgeIds = new Map<string, string>();

const reviewIds = new Map<string, string>();
let concIds: string[] = [];
const staleIds = new Map<string, string>();

async function cleanup(): Promise<void> {
  for (const u of USERS) {
    await db.delete(transactionsTable).where(eq(transactionsTable.userId, u));
    await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, u));
    await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, u));
    await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, u));
    await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, u));
  }
}

async function addAccount(
  userId: string,
  opts: { institutionName: string; mask: string; type: string; subtype: string },
): Promise<{ rowId: string; externalId: string }> {
  const householdId = householdOf.get(userId)!;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({
      userId,
      householdId,
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
      userId,
      householdId,
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

async function setSnapshot(userId: string, rowId: string, mask: string, balance: string): Promise<void> {
  await db.insert(forecastSettingsTable).values({
    userId,
    householdId: householdOf.get(userId)!,
    daysAhead: 90,
    cashBuffer: "0",
    bankSnapshotBalance: balance,
    bankSnapshotAt: SNAPSHOT_AT,
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: rowId,
    bankSnapshotMask: mask,
  });
}

function timeOn(day: string, n: number): string {
  // 16:MM:SSZ is late morning in Chicago, on the row's own household day, and
  // never a whole hour (whole hours are placeholder times to the snapshot rule).
  const mm = String(10 + (n % 50)).padStart(2, "0");
  const ss = String(1 + ((n * 7) % 58)).padStart(2, "0");
  return `${day}T16:${mm}:${ss}.000Z`;
}

async function seedMain(): Promise<void> {
  const householdId = householdOf.get(MAIN_USER)!;
  const chk = await addAccount(MAIN_USER, { institutionName: "Chase", mask: "5526", type: "depository", subtype: "checking" });
  const amx = await addAccount(MAIN_USER, { institutionName: "American Express", mask: "1001", type: "credit", subtype: "credit card" });
  CHK = chk.externalId;
  CHK_ROW_ID = chk.rowId;
  AMX = amx.externalId;
  AMX_ROW_ID = amx.rowId;
  await setSnapshot(MAIN_USER, CHK_ROW_ID, "5526", "5000.00");
  const [cat] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: MAIN_USER, householdId, name: "Weekend Getaway", kind: "expense", groupName: "Living" })
    .returning();
  CATEGORY_ID = cat!.id;

  const specs: Seed[] = [];
  let n = 0;
  const push = (occurredOn: string, amount: string, over: Partial<Seed> = {}) => {
    n += 1;
    specs.push({
      key: `c${n}`,
      occurredOn,
      amount,
      occurredAt: timeOn(occurredOn, n),
      createdAt: createdAtStartOfHouseholdDay(occurredOn),
      description: `CHASE ROW ${String(n).padStart(3, "0")}`,
      ...over,
    });
  };

  // 05-16..05-20: 20 Plaid charges after the snapshot day. One of them was in
  // the ledger before the read, so the snapshot holds it.
  for (const day of ["2026-05-20", "2026-05-19", "2026-05-18", "2026-05-17", "2026-05-16"]) {
    for (let k = 0; k < 4; k++) {
      if (day === "2026-05-17" && k === 0) {
        push(day, "-1.00", { key: "held", createdAt: new Date("2026-05-15T14:00:00Z") });
      } else if (day === TODAY && k === 0) {
        push(day, "-1.00", { key: "pending", pending: true });
      } else {
        push(day, "-1.00");
      }
    }
  }
  // The snapshot day: three rows the balance holds, one deposit after the read.
  for (let k = 0; k < 3; k++) {
    push("2026-05-15", "-1.00", { occurredAt: `2026-05-15T13:${20 + k}:11.000Z` });
  }
  push("2026-05-15", "100.00", {
    key: "counted",
    occurredAt: "2026-05-15T19:07:31.000Z",
    createdAt: new Date("2026-05-15T19:10:00Z"),
    description: "PAYROLL DEPOSIT AFTER THE READ",
  });
  // 71 rows so the first 100-row page ends inside the untimed group below.
  for (const [day, count] of [["2026-05-14", 18], ["2026-05-13", 18], ["2026-05-12", 18], ["2026-05-11", 17]] as const) {
    for (let k = 0; k < count; k++) push(day, "-1.00");
  }
  // 05-10 (rows 96–103 in ledger order): three timed rows, two of them at the
  // same instant so the id decides, then five with no institution time. One
  // untimed row is a +$100.00 deposit: a register that ordered the untimed rows
  // differently from the page could not pass the running-balance check.
  for (let k = 0; k < 3; k++) {
    push("2026-05-10", "-1.00", k < 2 ? { occurredAt: "2026-05-10T16:45:12.000Z" } : {});
  }
  for (let k = 0; k < 5; k++) {
    push("2026-05-10", k === 2 ? "100.00" : "-1.00", { key: `untimed${k}`, occurredAt: null });
  }
  push("2026-05-03", "-1.00", { key: "garage", description: "CITY PARKING GARAGE 0503" });
  // 156 more across 2026-04-01..2026-05-09, eight of them +$100.00.
  let deposits = 0;
  for (let i = 0; i < 156; i++) {
    const day = addDays("2026-04-01", i % 39);
    if (i % 17 === 5 && deposits < 8) {
      deposits += 1;
      push(day, "100.00");
    } else {
      push(day, "-1.00");
    }
  }
  specs[200]!.key = "categorized";
  specs[200]!.categoryId = CATEGORY_ID;
  expect(specs).toHaveLength(260);

  const inserted = await db
    .insert(transactionsTable)
    .values(
      specs.map((s) => ({
        userId: MAIN_USER,
        householdId,
        occurredOn: s.occurredOn,
        occurredAt: s.occurredAt,
        createdAt: s.createdAt,
        description: s.description,
        amount: s.amount,
        categoryId: s.categoryId ?? null,
        pending: s.pending ?? false,
        plaidAccountId: CHK,
        plaidTransactionId: `ptx-${RUN}-${s.key}-${s.description}`,
        source: "plaid",
      })),
    )
    .returning({ id: transactionsTable.id, description: transactionsTable.description });
  const idByDescription = new Map(inserted.map((r) => [r.description, r.id]));
  checking = specs.map((s) => ({ ...s, id: idByDescription.get(s.description)! }));
  for (const s of checking) byKey.set(s.key, s);

  // 30 Amex rows: half on the Amex Plaid account, half manual rows sourced "amex".
  const amex = [];
  for (let k = 0; k < 15; k++) {
    const day = addDays("2026-05-05", k);
    amex.push({
      userId: MAIN_USER,
      householdId,
      occurredOn: day,
      createdAt: createdAtStartOfHouseholdDay(day),
      description: k === 0 ? "CITY PARKING GARAGE AMEX" : `AMEX PLAID ROW ${k}`,
      amount: "-7.00",
      plaidAccountId: AMX,
      plaidTransactionId: `ptx-${RUN}-amex-${k}`,
      source: "plaid:amex",
    });
    amex.push({
      userId: MAIN_USER,
      householdId,
      occurredOn: day,
      createdAt: createdAtStartOfHouseholdDay(day),
      description: k === 0 ? "CITY PARKING GARAGE AMEX IMPORT" : `AMEX IMPORT ROW ${k}`,
      amount: "-9.00",
      source: "amex",
    });
  }
  await db.insert(transactionsTable).values(amex);
}

async function seedEdge(): Promise<void> {
  const householdId = householdOf.get(EDGE_USER)!;
  const main = await addAccount(EDGE_USER, { institutionName: "Chase", mask: "7777", type: "depository", subtype: "checking" });
  const twin = await addAccount(EDGE_USER, { institutionName: "CHASE", mask: "7777", type: "depository", subtype: "checking" });
  const credit = await addAccount(EDGE_USER, { institutionName: "Chase", mask: "7777", type: "credit", subtype: "credit card" });
  EDGE_EXT1 = main.externalId;
  EDGE_EXT2 = twin.externalId;
  EDGE_TWIN_ROW_ID = twin.rowId;
  EDGE_CREDIT_ROW_ID = credit.rowId;
  await setSnapshot(EDGE_USER, main.rowId, "7777", "1000.00");
  const rows: Array<{
    key: string;
    day: string;
    amount: string;
    plaidAccountId: string | null;
    source: string;
    pending?: boolean;
    description?: string;
  }> = [
    { key: "main", day: "2026-05-18", amount: "-10.00", plaidAccountId: EDGE_EXT1, source: "plaid" },
    { key: "twin", day: "2026-05-19", amount: "-20.00", plaidAccountId: EDGE_EXT2, source: "plaid" },
    { key: "manual", day: "2026-05-19", amount: "-30.00", plaidAccountId: null, source: "manual" },
    { key: "amexManual", day: "2026-05-19", amount: "-40.00", plaidAccountId: null, source: "amex" },
    { key: "plaidPrefixedManual", day: "2026-05-19", amount: "-50.00", plaidAccountId: null, source: "PLAID:amex" },
    { key: "sameMaskCredit", day: "2026-05-19", amount: "-60.00", plaidAccountId: credit.externalId, source: "plaid" },
    { key: "emptyPlaidId", day: "2026-05-18", amount: "-5.00", plaidAccountId: "", source: "manual" },
    // PR4c: a pending charge and the posted row that replaced it, both after the
    // read. The bank balance counts the charge once; the ledger lists both rows.
    {
      key: "pendingCoffee",
      day: "2026-05-18",
      amount: "-25.00",
      plaidAccountId: EDGE_EXT1,
      source: "plaid",
      pending: true,
      description: "BLUE BOTTLE COFFEE",
    },
    {
      key: "postedCoffee",
      day: "2026-05-19",
      amount: "-25.00",
      plaidAccountId: EDGE_EXT1,
      source: "plaid",
      description: "BLUE BOTTLE COFFEE 0519",
    },
  ];
  const descriptionOf = (r: (typeof rows)[number]) => r.description ?? `EDGE ${r.key}`;
  const keyByDescription = new Map(rows.map((r) => [descriptionOf(r), r.key]));
  const inserted = await db
    .insert(transactionsTable)
    .values(
      rows.map((r) => ({
        userId: EDGE_USER,
        householdId,
        occurredOn: r.day,
        createdAt: createdAtStartOfHouseholdDay(r.day),
        description: descriptionOf(r),
        amount: r.amount,
        pending: r.pending ?? false,
        plaidAccountId: r.plaidAccountId,
        source: r.source,
      })),
    )
    .returning({ id: transactionsTable.id, description: transactionsTable.description });
  for (const r of inserted) edgeIds.set(keyByDescription.get(r.description)!, r.id);
}

/**
 * The review's history fixture: a $1,000.00 snapshot read 05-15 10:00 in
 * Chicago, today 05-20, bank balance 990.00.
 */
async function seedReview(): Promise<void> {
  const householdId = householdOf.get(REVIEW_USER)!;
  const acct = await addAccount(REVIEW_USER, { institutionName: "Chase", mask: "2468", type: "depository", subtype: "checking" });
  await setSnapshot(REVIEW_USER, acct.rowId, "2468", "1000.00");
  const [groceries] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: REVIEW_USER, householdId, name: "Groceries", kind: "expense", groupName: "Living" })
    .returning();
  const rows: Array<{
    key: string;
    day: string;
    amount: string;
    plaid: boolean;
    description: string;
    pending?: boolean;
    categoryId?: string;
    createdAt?: Date;
  }> = [
    { key: "rent", day: "2026-04-10", amount: "-100.00", plaid: true, description: "RENT PAYMENT" },
    // A categorised leftover pending row beside the posted row that replaced it.
    { key: "leftoverPending", day: "2026-04-20", amount: "-40.00", plaid: true, pending: true, categoryId: groceries!.id, description: "WHOLE FOODS MARKET" },
    { key: "postedGroceries", day: "2026-04-21", amount: "-40.00", plaid: true, description: "WHOLE FOODS MARKET 0421" },
    // The bank's ACH for a card payment, and the manual row routes/debts.ts writes when it is logged.
    { key: "ach", day: "2026-04-25", amount: "-500.00", plaid: true, description: "AMEX EPAYMENT ACH PMT" },
    { key: "loggedPayment", day: "2026-04-25", amount: "-500.00", plaid: false, description: "Payment — Amex" },
    // In the ledger before the read, dated the next day: the snapshot holds it.
    { key: "heldAhead", day: "2026-05-16", amount: "-30.00", plaid: true, description: "SHELL OIL 0516", createdAt: new Date("2026-05-15T14:00:00Z") },
    { key: "recent", day: "2026-05-19", amount: "-10.00", plaid: true, description: "CORNER COFFEE" },
    // Typed today, dated five days ahead.
    { key: "future", day: "2026-05-25", amount: "-200.00", plaid: false, description: "Payment — Visa", createdAt: createdAtStartOfHouseholdDay(TODAY) },
  ];
  const inserted = await db
    .insert(transactionsTable)
    .values(
      rows.map((r) => ({
        userId: REVIEW_USER,
        householdId,
        occurredOn: r.day,
        createdAt: r.createdAt ?? createdAtStartOfHouseholdDay(r.day),
        description: r.description,
        amount: r.amount,
        pending: r.pending ?? false,
        categoryId: r.categoryId ?? null,
        plaidAccountId: r.plaid ? acct.externalId : null,
        plaidTransactionId: r.plaid ? `ptx-${RUN}-review-${r.key}` : null,
        source: r.plaid ? "plaid" : "manual",
      })),
    )
    .returning({ id: transactionsTable.id, description: transactionsTable.description });
  const keyByDescription = new Map(rows.map((r) => [r.description, r.key]));
  for (const r of inserted) reviewIds.set(keyByDescription.get(r.description)!, r.id);
}

/**
 * The second review's fixture: a $1,000.00 snapshot read 05-15 10:00 in Chicago,
 * today 05-20, bank balance 968.00 (1000 − the posted Target −20.00 − the
 * pending coffee −12.00; every other row is held, replaced, or after today).
 */
async function seedStale(): Promise<void> {
  const householdId = householdOf.get(STALE_USER)!;
  const acct = await addAccount(STALE_USER, { institutionName: "Chase", mask: "1357", type: "depository", subtype: "checking" });
  await setSnapshot(STALE_USER, acct.rowId, "1357", "1000.00");
  const [fuel] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: STALE_USER, householdId, name: "Fuel", kind: "expense", groupName: "Living" })
    .returning();
  const rows: Array<{
    key: string;
    day: string;
    amount: string;
    description: string;
    pending?: boolean;
    forecastFlag?: boolean;
    categoryId?: string;
    createdAt?: Date;
    occurredAt?: string;
  }> = [
    // R1: a gas hold that posted lower. Pairing needs the posting at or above the
    // hold, so both rows count; the hold was categorised, so no sweep deleted it.
    { key: "gasHold", day: "2026-04-20", amount: "-100.00", pending: true, categoryId: fuel!.id, description: "SHELL OIL 57442" },
    { key: "gasPosted", day: "2026-04-21", amount: "-45.00", description: "SHELL OIL 57442" },
    // R1: pending rows dated 15 and 14 days before today.
    { key: "pending15", day: "2026-05-05", amount: "-8.00", pending: true, description: "NEWSSTAND 0505" },
    { key: "pending14", day: "2026-05-06", amount: "-7.00", pending: true, description: "CORNER STORE 0506" },
    // R3: in the ledger before the read, dated the next day: held ahead.
    { key: "heldPlain", day: "2026-05-16", amount: "-30.00", description: "SHELL OIL 0516", createdAt: new Date("2026-05-15T14:00:00Z") },
    // R3: a posted row the snapshot rule holds on its own (its time is before the
    // read) that replaced a pending row the rule does not hold: not held ahead.
    { key: "targetPending", day: "2026-05-16", amount: "-20.00", pending: true, description: "TARGET STORE", createdAt: new Date("2026-05-16T16:00:00Z") },
    {
      key: "targetPosted",
      day: "2026-05-16",
      amount: "-20.00",
      description: "TARGET STORE 0516",
      createdAt: new Date("2026-05-16T18:00:00Z"),
      occurredAt: "2026-05-15T14:59:31.000Z",
    },
    // R2: a pending row whose posted row is dated after today and flagged for the
    // forecast. The bank balance reads that row, so the pending row counts 0 today.
    { key: "wfPending", day: "2026-05-19", amount: "-9.00", pending: true, description: "WHOLE FOODS MARKET" },
    { key: "wfPostedFlagged", day: "2026-05-22", amount: "-9.00", forecastFlag: true, description: "WHOLE FOODS MARKET 0522" },
    // R2, the review's repro: a pending row dated today whose posted row is dated
    // tomorrow and not flagged. The bank balance does not read that row, so the
    // pending −12.00 counts today.
    { key: "coffeePending", day: TODAY, amount: "-12.00", pending: true, description: "BLUE BOTTLE COFFEE" },
    { key: "coffeePosted", day: "2026-05-21", amount: "-12.00", description: "BLUE BOTTLE COFFEE 0521" },
  ];
  const inserted = await db
    .insert(transactionsTable)
    .values(
      rows.map((r) => ({
        userId: STALE_USER,
        householdId,
        occurredOn: r.day,
        occurredAt: r.occurredAt ?? null,
        createdAt: r.createdAt ?? createdAtStartOfHouseholdDay(r.day),
        description: r.description,
        amount: r.amount,
        pending: r.pending ?? false,
        forecastFlag: r.forecastFlag ?? false,
        categoryId: r.categoryId ?? null,
        plaidAccountId: acct.externalId,
        plaidTransactionId: `ptx-${RUN}-stale-${r.key}`,
        source: "plaid",
      })),
    )
    .returning({ id: transactionsTable.id, description: transactionsTable.description, occurredOn: transactionsTable.occurredOn });
  const keyOf = new Map(rows.map((r) => [`${r.day}|${r.description}`, r.key]));
  for (const r of inserted) staleIds.set(keyOf.get(`${r.occurredOn}|${r.description}`)!, r.id);
}

/**
 * `heldAhead` the way dd8c1bb computed it: a second `classifyCashRows` run over
 * the whole history, with the snapshot anchor, labelling a `held` row dated
 * after the snapshot day.
 */
async function heldAheadTheOldWay(page: LedgerBody, rows: Row[]): Promise<Map<string, boolean>> {
  const day = page.anchor.snapshotDay!;
  const dbRows = await db
    .select()
    .from(transactionsTable)
    .where(inArray(transactionsTable.id, rows.map((r) => r.id)));
  const byId = new Map(dbRows.map((r) => [r.id, r]));
  const oldestFirst = [...rows].reverse().map((r) => toCashRow(byId.get(r.id)!));
  const result = classifyCashRows(oldestFirst, {
    anchor: { at: new Date(page.anchor.snapshotAt!), day },
    accountExternalId: page.account.plaidAccountIds[0] ?? null,
    todayISO: page.anchor.today,
  });
  return new Map(result.rows.map((o) => [o.id, o.reason === "held" && o.occurredOn > day]));
}

async function waitForLockWait(): Promise<void> {
  for (let k = 0; k < 200; k++) {
    const res = await db.execute(
      sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    const n = Number((res as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0);
    if (n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("bulk review never waited for the row lock");
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
  for (const u of USERS) householdOf.set(u, (await createTestHousehold(u)).householdId);
  await cleanup();
  await seedMain();
  await seedEdge();
  await seedReview();
  await seedStale();
  await db.insert(transactionsTable).values({
    userId: NOSNAP_USER,
    householdId: householdOf.get(NOSNAP_USER)!,
    occurredOn: "2026-05-12",
    createdAt: createdAtStartOfHouseholdDay("2026-05-12"),
    description: "NO SNAPSHOT ROW",
    amount: "-12.00",
    source: "manual",
  });
  await db.insert(transactionsTable).values(
    Array.from({ length: 1001 }, (_, k) => ({
      userId: BIG_USER,
      householdId: householdOf.get(BIG_USER)!,
      occurredOn: "2026-05-12",
      createdAt: createdAtStartOfHouseholdDay("2026-05-12"),
      description: `BIG ROW ${k}`,
      amount: "-1.00",
      source: "manual",
    })),
  );
  concIds = (
    await db
      .insert(transactionsTable)
      .values(
        Array.from({ length: 5 }, (_, k) => ({
          userId: CONC_USER,
          householdId: householdOf.get(CONC_USER)!,
          occurredOn: "2026-05-12",
          createdAt: createdAtStartOfHouseholdDay("2026-05-12"),
          description: `CONCURRENT ROW ${k}`,
          amount: "-3.00",
          source: "manual",
        })),
      )
      .returning({ id: transactionsTable.id })
  ).map((r) => r.id);
});

afterAll(async () => {
  await cleanup();
  vi.useRealTimers();
});

describe("GET /transactions/ledger — paging", () => {
  it("pages of 100/100/60 return all 260 checking rows once, in ledger order, with the same totals and balances on every page", async () => {
    const pages = await walk(RANGE, 100);
    expect(pages.map((p) => p.rows.length)).toEqual([100, 100, 60]);
    expect(pages[2]!.nextCursor).toBeNull();

    const rows = rowsOf(pages);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(260);
    expect(ids).toEqual([...checking].sort(newestFirst).map((s) => s.id));

    // Page 1 ends inside the five untimed rows of 05-10, so page 2 starts from
    // an untimed cursor.
    expect(rows[99]!.occurredOn).toBe("2026-05-10");
    expect(rows[99]!.occurredAt).toBeNull();
    expect(rows[100]!.occurredAt).toBeNull();

    // No pair, no repeated id, no twin: every row moves the register by its amount.
    for (const r of rows) {
      expect(r.countsInBalance).toBe(true);
      expect(r.balanceReason).toBe("counted");
      expect(r.balanceAmount).toBe(r.amount);
      expect(r.afterToday).toBe(false);
    }
    // Only the charge the snapshot held ahead of its date is labelled.
    expect(rows.filter((r) => r.heldAhead).map((r) => r.id)).toEqual([byKey.get("held")!.id]);

    for (const p of pages) {
      expect(p.matchingCount).toBe(260);
      expect(p.totals).toEqual({ count: 260, moneyIn: "1000.00", moneyOut: "250.00", net: "750.00" });
      expect(p.review).toEqual({ reviewed: 0, unreviewed: 260 });
      expect(p.balanceStart).toBe("4331.00");
      expect(p.balanceEnd).toBe("5081.00");
      expect(p.balanceToday).toBe("5081.00");
      expect(p.anchor).toEqual({
        today: TODAY,
        todayBalance: "5081.00",
        snapshotBalance: "5000.00",
        snapshotAt: SNAPSHOT_AT.toISOString(),
        snapshotDay: "2026-05-15",
      });
      expect(p.account).toEqual({ via: "pointer", plaidAccountIds: [CHK] });
    }
  });

  it("walks the same-day untimed rows three at a time without skipping or repeating one", async () => {
    const pages = await walk("from=2026-05-10&to=2026-05-10", 3);
    expect(pages.map((p) => p.rows.length)).toEqual([3, 3, 2]);
    const rows = rowsOf(pages);
    const expected = checking.filter((s) => s.occurredOn === "2026-05-10").sort(newestFirst);
    expect(rows.map((r) => r.id)).toEqual(expected.map((s) => s.id));
    expect(rows.slice(0, 3).every((r) => r.occurredAt !== null)).toBe(true);
    expect(rows.slice(3).every((r) => r.occurredAt === null)).toBe(true);
    expect(pages.every((p) => p.matchingCount === 8)).toBe(true);
  });

  it("defaults to 50 rows and refuses a limit that is not plain digits from 1 to 100, or a bad cursor", async () => {
    const first = await get(`/transactions/ledger?${RANGE}`);
    expect(first.status).toBe(200);
    expect((first.json as LedgerBody).rows).toHaveLength(50);
    expect((first.json as LedgerBody).limit).toBe(50);

    for (const limit of ["101", "0", "1.5", "abc", "", "1e1", "0x10", "%2B5"]) {
      const r = await get(`/transactions/ledger?${RANGE}&limit=${limit}`);
      expect(r.status, `limit=${limit}`).toBe(400);
    }
    const forged = Buffer.from(JSON.stringify({ v: 1, d: "2026-05-10", t: null, i: "not-a-uuid" })).toString("base64url");
    for (const cursor of ["nonsense", forged, Buffer.from("[]").toString("base64url")]) {
      const r = await get(`/transactions/ledger?${RANGE}&cursor=${encodeURIComponent(cursor)}`);
      expect(r.status, `cursor=${cursor}`).toBe(400);
    }
  });
});

describe("GET /transactions/ledger — balances", () => {
  it("each running balance is the one before it plus its amount; the newest is today's bank balance and the oldest is the start plus its amount", async () => {
    const rows = rowsOf(await walk(RANGE, 100));
    expect(rows[0]!.runningBalance).toBe("5081.00");
    expectChain(rows);
    const oldest = rows[rows.length - 1]!;
    expect(oldest.occurredOn).toBe("2026-04-01");
    expect(cents(oldest.runningBalance)).toBe(cents("4331.00") + cents(oldest.amount));
  });

  it("a filtered page carries the unfiltered register's balances, and search reaches a row dated 2026-05-03 but no Amex row", async () => {
    const all = new Map(rowsOf(await walk(RANGE, 100)).map((r) => [r.id, r]));

    const garage = await get(`/transactions/ledger?${RANGE}&search=garage`);
    expect(garage.status).toBe(200);
    const g = garage.json as LedgerBody;
    expect(g.rows.map((r) => r.id)).toEqual([byKey.get("garage")!.id]);
    expect(g.rows[0]!.occurredOn).toBe("2026-05-03");
    expect(g.rows[0]!.runningBalance).toBe(all.get(byKey.get("garage")!.id)!.runningBalance);
    expect(g.matchingCount).toBe(1);
    expect(g.totals).toEqual({ count: 1, moneyIn: "0.00", moneyOut: "1.00", net: "-1.00" });
    expect(g.balanceStart).toBe("4331.00");
    expect(g.balanceEnd).toBe("5081.00");

    // The category name is searched too, and LIKE wildcards are literal.
    const getaway = await get(`/transactions/ledger?${RANGE}&search=GETAWAY`);
    expect((getaway.json as LedgerBody).rows.map((r) => r.id)).toEqual([byKey.get("categorized")!.id]);
    for (const wildcard of ["%25", "_"]) {
      const r = await get(`/transactions/ledger?${RANGE}&search=${wildcard}`);
      expect((r.json as LedgerBody).matchingCount, `search=${wildcard}`).toBe(0);
    }
    // A space is an ordinary character.
    const spaced = await get(`/transactions/ledger?${RANGE}&search=${encodeURIComponent("parking garage")}`);
    expect((spaced.json as LedgerBody).matchingCount).toBe(1);

    const pending = await get(`/transactions/ledger?pending=true`);
    const p = pending.json as LedgerBody;
    expect(p.rows.map((r) => r.id)).toEqual([byKey.get("pending")!.id]);
    expect(p.rows[0]!.runningBalance).toBe(all.get(byKey.get("pending")!.id)!.runningBalance);
  });

  it("Amex rows never appear, whichever filter asks", async () => {
    const rows = rowsOf(await walk("from=2026-01-01&to=2026-12-31", 100));
    expect(rows).toHaveLength(260);
    for (const r of rows) {
      expect(r.plaidAccountId).toBe(CHK);
      expect(r.source).toBe("plaid");
    }
    for (const q of ["source=amex", "source=plaid%3Aamex", "search=amex"]) {
      const r = await get(`/transactions/ledger?${q}`);
      expect((r.json as LedgerBody).matchingCount, q).toBe(0);
    }
  });

  it("refuses a bad filter or an account that is not the ledger's", async () => {
    for (const q of [
      "reviewed=yes",
      "pending=1",
      "from=2026-02-30",
      "from=2026-05-20&to=2026-05-01",
      "categoryId=not-a-uuid",
      `uncategorized=true&categoryId=${CATEGORY_ID}`,
      "account=not-a-uuid",
      `account=${AMX_ROW_ID}`,
    ]) {
      const r = await get(`/transactions/ledger?${q}`);
      expect(r.status, q).toBe(400);
    }
    const own = await get(`/transactions/ledger?account=${CHK_ROW_ID}&limit=1`);
    expect(own.status).toBe(200);
  });
});

describe("GET /transactions/balances", () => {
  it("today's balance is the spine's bank balance, set by the snapshot rule, and no day after today has one", async () => {
    const bank = await spineBalance();
    expect(bank).toBe("5081.00");

    const r = await get(
      `/transactions/balances?dates=${TODAY},2026-03-31,2026-05-03,2026-05-15,2026-05-21,2026-06-30,${TODAY}`,
    );
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const body = GetTransactionsBalancesResponse.parse(r.json);
    expect(body.anchor.todayBalance).toBe(bank);

    const rows = rowsOf(await walk(RANGE, 100));
    const endOf = (day: string) => rows.find((row) => row.occurredOn <= day)?.runningBalance ?? "4331.00";
    expect(body.balances).toEqual([
      { date: TODAY, balance: bank },
      { date: "2026-03-31", balance: "4331.00" },
      { date: "2026-05-03", balance: endOf("2026-05-03") },
      // The register, not `available` replayed: the held −1.00 dated 05-17 sits
      // on 05-17, so the end of the snapshot day reads 5000 + 100 + 1.
      { date: "2026-05-15", balance: "5101.00" },
      { date: "2026-05-21", balance: null },
      { date: "2026-06-30", balance: null },
      { date: TODAY, balance: bank },
    ]);
    expect(endOf("2026-05-15")).toBe("5101.00");
  });

  it("takes 1 to 120 real dates", async () => {
    const days120 = Array.from({ length: 120 }, (_, k) => addDays("2026-01-01", k));
    const ok = await get(`/transactions/balances?dates=${days120.join(",")}`);
    expect(ok.status).toBe(200);
    expect((ok.json as { balances: unknown[] }).balances).toHaveLength(120);
    const days121 = [...days120, "2026-06-01"];
    for (const dates of [days121.join(","), "", "2026-05-01,", "2026-02-30", "yesterday"]) {
      const r = await get(`/transactions/balances?dates=${dates}`);
      expect(r.status, `dates=${dates.slice(0, 30)}`).toBe(400);
    }
    const missing = await get("/transactions/balances");
    expect(missing.status).toBe(400);
  });
});

describe("inputs that passed validation but reached Postgres", () => {
  it("year 0000, an impossible cursor time and a NUL byte are 400s on every endpoint, and nothing is written", async () => {
    const uuid = randomUUID();
    const cursorOf = (o: unknown) => encodeURIComponent(Buffer.from(JSON.stringify(o)).toString("base64url"));
    for (const q of [
      "from=0000-01-01",
      "to=0000-12-31",
      "search=%00",
      "search=parking%00garage",
      "source=%00",
      "member=a%00b",
      "account=%00",
      `cursor=${cursorOf({ v: 1, d: "0000-01-01", t: null, i: uuid })}`,
      `cursor=${cursorOf({ v: 1, d: "2026-05-10", t: "2026-02-30T10:00:00.000000Z", i: uuid })}`,
      `cursor=${cursorOf({ v: 1, d: "2026-05-10", t: "0000-05-10T10:00:00.000000Z", i: uuid })}`,
    ]) {
      const r = await get(`/transactions/ledger?${q}`);
      expect(r.status, `${q} -> ${JSON.stringify(r.json)}`).toBe(400);
    }
    for (const dates of ["0000-01-01", "2026-05-01%00", `${TODAY},0999-12-31`]) {
      const r = await get(`/transactions/balances?dates=${dates}`);
      expect(r.status, `dates=${dates}`).toBe(400);
    }
    for (const filter of [
      { from: "0000-01-01" },
      { to: "0000-01-01" },
      { search: "a\u0000" },
      { source: "\u0000" },
      { member: "\u0000" },
      { account: "\u0000" },
    ]) {
      const r = await request("POST", "/transactions/bulk-review-matching", { filter, reviewed: true, expectedCount: 0 });
      expect(r.status, JSON.stringify(filter)).toBe(400);
    }
    const reviewed = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(and(eq(transactionsTable.userId, MAIN_USER), eq(transactionsTable.reviewed, true)));
    expect(reviewed).toHaveLength(0);
  });
});

describe("history and future rows (the review's fixture)", () => {
  it("a replaced pending row moves nothing, so every earlier balance and money out are right; the logged payment beside its ACH still counts", async () => {
    actingUser = REVIEW_USER;
    try {
      expect(await spineBalance()).toBe("990.00");
      const pages = await walk("", 100);
      const rows = rowsOf(pages);
      const page = pages[0]!;
      const row = (key: string) => rows.find((r) => r.id === reviewIds.get(key))!;
      expect(rows).toHaveLength(8);

      expect(page.balanceToday).toBe("990.00");
      expect(page.balanceEnd).toBe("990.00");
      // Every row dated through today, added back to today's balance, except
      // the replaced pending −40: 990 + 100 + 40 + 500 + 500 + 30 + 10.
      // 46ae246 read 2,210.00 (the pending −40 counted too). 1,670.00 would need
      // the logged payment not to count: that is Brad's decision, still open.
      expect(page.balanceStart).toBe("2170.00");
      // Money out on the same basis, the future row included: 100 + 40 + 500 +
      // 500 + 30 + 10 + 200. 46ae246 read 1,420.00; 880.00 with the open rule.
      expect(page.totals).toEqual({ count: 8, moneyIn: "0.00", moneyOut: "1380.00", net: "-1380.00" });

      expect(row("leftoverPending")).toMatchObject({
        countsInBalance: false,
        balanceReason: "superseded",
        balanceAmount: "0.00",
        runningBalance: "2070.00",
      });
      expect(row("postedGroceries")).toMatchObject({
        countsInBalance: true,
        balanceReason: "counted",
        replacedPendingId: reviewIds.get("leftoverPending"),
        runningBalance: "2030.00",
      });
      expect(row("rent").runningBalance).toBe("2070.00");
      expect(row("ach").balanceReason).toBe("counted");
      expect(row("loggedPayment")).toMatchObject({ countsInBalance: true, balanceReason: "counted", balanceAmount: "-500.00" });
      expect([row("ach").runningBalance, row("loggedPayment").runningBalance].sort()).toEqual(["1030.00", "1530.00"]);
      expect(row("heldAhead")).toMatchObject({ heldAhead: true, countsInBalance: true, runningBalance: "1000.00" });
      expect(row("recent")).toMatchObject({ heldAhead: false, runningBalance: "990.00" });
      expectChain(rows);

      const b = await get(
        "/transactions/balances?dates=2026-04-09,2026-04-20,2026-04-22,2026-04-25,2026-05-15,2026-05-16,2026-05-19",
      );
      expect((b.json as { balances: unknown }).balances).toEqual([
        { date: "2026-04-09", balance: "2170.00" },
        { date: "2026-04-20", balance: "2070.00" },
        // 04-21..24 still read 500.00 above the review's figure: the open logged payment.
        { date: "2026-04-22", balance: "2030.00" },
        { date: "2026-04-25", balance: "1030.00" },
        // The held-ahead −30 sits on 05-16, so the snapshot day reads 30.00 above
        // the 1,000.00 the bank showed (the row is labelled `heldAhead`).
        { date: "2026-05-15", balance: "1030.00" },
        { date: "2026-05-16", balance: "1000.00" },
        { date: "2026-05-19", balance: "990.00" },
      ]);
    } finally {
      actingUser = MAIN_USER;
    }
  });

  it("a row dated after today is listed and labelled but carries no balance; no end balance or date after today has one", async () => {
    actingUser = REVIEW_USER;
    try {
      const page = (await get("/transactions/ledger?limit=2")).json as LedgerBody;
      const [future, recent] = page.rows as unknown as Row[];
      expect(future).toMatchObject({ id: reviewIds.get("future"), afterToday: true, runningBalance: null, balanceAmount: "-200.00" });
      // The newest dated row, the end balance and today's balance are the spine's figure.
      expect(recent!.runningBalance).toBe("990.00");
      expect(page.balanceEnd).toBe("990.00");
      expect(page.balanceToday).toBe(await spineBalance());

      const toLater = (await get("/transactions/ledger?to=2026-06-30&limit=1")).json as LedgerBody;
      expect(toLater.balanceEnd).toBeNull();
      expect(toLater.balanceToday).toBe("990.00");
      expect(((await get("/transactions/ledger?from=2026-05-21&limit=1")).json as LedgerBody).balanceStart).toBe("990.00");
      expect(((await get("/transactions/ledger?from=2026-05-22&limit=1")).json as LedgerBody).balanceStart).toBeNull();

      const b = await get(`/transactions/balances?dates=${TODAY},2026-05-21,2026-05-25,2026-06-30`);
      expect((b.json as { balances: unknown }).balances).toEqual([
        { date: TODAY, balance: "990.00" },
        { date: "2026-05-21", balance: null },
        { date: "2026-05-25", balance: null },
        { date: "2026-06-30", balance: null },
      ]);
    } finally {
      actingUser = MAIN_USER;
    }
  });

  it("with source=plaid the manual rows are hidden from the page but not from the register: balances and start/end are the unfiltered ones", async () => {
    actingUser = REVIEW_USER;
    try {
      const all = new Map(rowsOf(await walk("", 100)).map((r) => [r.id, r]));
      const filtered = (await get("/transactions/ledger?source=plaid&limit=100")).json as LedgerBody;
      expect(filtered.matchingCount).toBe(6);
      expect(filtered.totals).toEqual({ count: 6, moneyIn: "0.00", moneyOut: "680.00", net: "-680.00" });
      for (const r of filtered.rows as unknown as Row[]) {
        expect(r.runningBalance).toBe(all.get(r.id)!.runningBalance);
      }
      expect(filtered.balanceStart).toBe("2170.00");
      expect(filtered.balanceEnd).toBe("990.00");
    } finally {
      actingUser = MAIN_USER;
    }
  });
});

describe("reviewing", () => {
  it("reviewing 20 rows moves matchingCount and the review counts, never the totals or balances", async () => {
    const before = rowsOf(await walk(RANGE, 100));
    const runningBefore = new Map(before.map((r) => [r.id, r.runningBalance]));
    const picked = before.filter((_, k) => k % 13 === 0).map((r) => r.id);
    expect(picked).toHaveLength(20);

    const review = await request("POST", "/transactions/bulk-update", { ids: picked, patch: { reviewed: true } });
    expect(review.status).toBe(200);

    const unreviewedPages = await walk(`${RANGE}&reviewed=false`, 100);
    for (const p of unreviewedPages) {
      expect(p.matchingCount).toBe(240);
      expect(p.totals).toEqual({ count: 260, moneyIn: "1000.00", moneyOut: "250.00", net: "750.00" });
      expect(p.review).toEqual({ reviewed: 20, unreviewed: 240 });
      expect(p.balanceStart).toBe("4331.00");
      expect(p.balanceEnd).toBe("5081.00");
    }
    const unreviewed = rowsOf(unreviewedPages);
    expect(unreviewed).toHaveLength(240);
    expect(unreviewed.some((r) => picked.includes(r.id))).toBe(false);
    for (const r of unreviewed) expect(r.runningBalance).toBe(runningBefore.get(r.id));

    const reviewedOnly = await get(`/transactions/ledger?${RANGE}&reviewed=true`);
    expect((reviewedOnly.json as LedgerBody).matchingCount).toBe(20);
  });

  it("bulk review by filter: a stale count is a 409 that changes nothing, a misspelt filter is a 400, and the right count reviews the 239 posted rows (the pending row stays unreviewed)", async () => {
    // (PR14 second review N1) Reviewing by filter must exclude pending rows.
    const filter = { from: "2026-04-01", to: TODAY, reviewed: false, pending: false };
    const reviewedInDb = async () =>
      (
        await db
          .select({ id: transactionsTable.id })
          .from(transactionsTable)
          .where(and(eq(transactionsTable.userId, MAIN_USER), eq(transactionsTable.reviewed, true)))
      ).length;
    expect(await reviewedInDb()).toBe(20);

    // (PR14 second review N1) Of the 240 unreviewed rows one is the pending row dated
    // today, which a review by filter leaves out: 239 match.
    const stale = await request("POST", "/transactions/bulk-review-matching", { filter, reviewed: true, expectedCount: 238 });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: "matching_count_changed", matchingCount: 239 });
    expect(await reviewedInDb()).toBe(20);

    const misspelt = await request("POST", "/transactions/bulk-review-matching", {
      filter: { from: "2026-04-01", to: TODAY, revieved: false },
      reviewed: true,
      expectedCount: 240,
    });
    expect(misspelt.status).toBe(400);
    const fractional = await request("POST", "/transactions/bulk-review-matching", { filter, reviewed: true, expectedCount: 240.5 });
    expect(fractional.status).toBe(400);
    expect(await reviewedInDb()).toBe(20);

    const ok = await request("POST", "/transactions/bulk-review-matching", { filter, reviewed: true, expectedCount: 239 });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const result = BulkReviewMatchingTransactionsResponse.parse(ok.json);
    expect(result.matched).toBe(239);
    expect(result.updated).toBe(239);
    expect(new Set(result.updatedIds).size).toBe(239);
    expect(await reviewedInDb()).toBe(259);
    const pendingRows = await db
      .select({ id: transactionsTable.id, reviewed: transactionsTable.reviewed })
      .from(transactionsTable)
      .where(and(eq(transactionsTable.userId, MAIN_USER), eq(transactionsTable.pending, true)));
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]!.reviewed).toBe(false);
    expect(result.updatedIds).not.toContain(pendingRows[0]!.id);

    // Amex rows are outside the ledger, so the filter never reached them.
    const amexReviewed = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, MAIN_USER),
          eq(transactionsTable.reviewed, true),
          inArray(transactionsTable.source, ["amex", "plaid:amex"]),
        ),
      );
    expect(amexReviewed).toHaveLength(0);

    const after = await get(`/transactions/ledger?${RANGE}&limit=1`);
    expect((after.json as LedgerBody).review).toEqual({ reviewed: 259, unreviewed: 1 });
    expect((after.json as LedgerBody).totals.net).toBe("750.00");

    // Rows already in the target state are matched but not updated.
    const again = await request("POST", "/transactions/bulk-review-matching", {
      filter: { from: "2026-04-01", to: TODAY, pending: false },
      reviewed: true,
      expectedCount: 259,
    });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ matched: 259, updated: 0, updatedIds: [] });
  });

  it("refuses more than 1,000 matching rows and changes none of them", async () => {
    actingUser = BIG_USER;
    try {
      const r = await request("POST", "/transactions/bulk-review-matching", { filter: { pending: false }, reviewed: true, expectedCount: 1001 });
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject({ code: "too_many_rows" });
      const reviewed = await db
        .select({ id: transactionsTable.id })
        .from(transactionsTable)
        .where(and(eq(transactionsTable.userId, BIG_USER), eq(transactionsTable.reviewed, true)));
      expect(reviewed).toHaveLength(0);
    } finally {
      actingUser = MAIN_USER;
    }
  });

  it("refuses when a matching row stops matching while the request waits for its lock, and reviews nothing", async () => {
    actingUser = CONC_USER;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let blocker: Promise<void> | null = null;
    try {
      let moved: () => void = () => {};
      const movedDone = new Promise<void>((r) => (moved = r));
      // Another request moves the first row out of the filter's range and holds
      // its row lock until released.
      blocker = db.transaction(async (tx) => {
        await tx
          .update(transactionsTable)
          .set({ occurredOn: "2026-01-01" })
          .where(eq(transactionsTable.id, concIds[0]!));
        moved();
        await gate;
      });
      await movedDone;
      // Counted before that change committed, five rows match.
      const bulk = request("POST", "/transactions/bulk-review-matching", {
        filter: { from: "2026-05-01", pending: false },
        reviewed: true,
        expectedCount: 5,
      });
      await waitForLockWait();
      release();
      await blocker;
      const r = await bulk;
      expect(r.status, JSON.stringify(r.json)).toBe(409);
      expect(r.json).toMatchObject({ code: "matching_rows_changed", matchingCount: 4 });
      const reviewed = await db
        .select({ id: transactionsTable.id })
        .from(transactionsTable)
        .where(and(eq(transactionsTable.userId, CONC_USER), eq(transactionsTable.reviewed, true)));
      expect(reviewed).toHaveLength(0);
    } finally {
      release();
      if (blocker) await blocker.catch(() => {});
      actingUser = MAIN_USER;
    }
  });
});

describe("scope edges", () => {
  it("mask twins and manual rows are listed; a twin row and a replaced pending row move nothing; Amex-sourced rows, a same-mask card and another household's account are out", async () => {
    actingUser = EDGE_USER;
    try {
      const r = await get("/transactions/ledger?limit=100");
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      const page = r.json as LedgerBody;
      const rows = page.rows as unknown as Row[];
      const row = (key: string) => rows.find((x) => x.id === edgeIds.get(key))!;
      expect(new Set(rows.map((x) => x.id))).toEqual(
        new Set(
          ["main", "twin", "manual", "emptyPlaidId", "pendingCoffee", "postedCoffee"].map((k) => edgeIds.get(k)!),
        ),
      );
      expect([...page.account.plaidAccountIds].sort()).toEqual([EDGE_EXT1, EDGE_EXT2].sort());

      // The bank balance: the main account and the manual rows, not the twin,
      // and the replaced pending coffee once: 1000 − 10 − 30 − 5 − 25 = 930.00.
      expect(await spineBalance()).toBe("930.00");
      expect(page.balanceToday).toBe("930.00");
      expect(rows[0]!.runningBalance).toBe("930.00");
      // Every row is dated after the snapshot and none was in it, so the balance
      // before them all is the snapshot's own 1,000.00.
      expect(page.balanceStart).toBe("1000.00");
      expect(page.totals).toEqual({ count: 6, moneyIn: "0.00", moneyOut: "70.00", net: "-70.00" });
      expect(row("twin")).toMatchObject({ countsInBalance: false, balanceReason: "not_bank", balanceAmount: "0.00" });
      expect(row("pendingCoffee")).toMatchObject({ countsInBalance: false, balanceReason: "superseded", balanceAmount: "0.00" });
      expect(row("postedCoffee")).toMatchObject({ countsInBalance: true, replacedPendingId: edgeIds.get("pendingCoffee") });
      expect(row("emptyPlaidId")).toMatchObject({ countsInBalance: true, balanceAmount: "-5.00" });
      expectChain(rows);

      const viaTwin = await get(`/transactions/ledger?account=${EDGE_TWIN_ROW_ID}&limit=1`);
      expect(viaTwin.status).toBe(200);
      const viaCard = await get(`/transactions/ledger?account=${EDGE_CREDIT_ROW_ID}&limit=1`);
      expect(viaCard.status).toBe(400);
      const otherHousehold = await get(`/transactions/ledger?account=${CHK_ROW_ID}&limit=1`);
      expect(otherHousehold.status).toBe(400);
      expect(otherHousehold.json).toMatchObject({ code: "account_not_ledger" });
      const otherHouseholdBulk = await request("POST", "/transactions/bulk-review-matching", {
        filter: { account: CHK_ROW_ID },
        reviewed: true,
        expectedCount: 0,
      });
      expect(otherHouseholdBulk.status).toBe(400);
    } finally {
      actingUser = MAIN_USER;
    }
  });

  it("without a bank snapshot the rows and totals still come back, and every balance is null", async () => {
    actingUser = NOSNAP_USER;
    try {
      const r = await get("/transactions/ledger");
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      const page = r.json as LedgerBody;
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]!.runningBalance).toBeNull();
      expect(page.balanceStart).toBeNull();
      expect(page.balanceEnd).toBeNull();
      expect(page.balanceToday).toBeNull();
      expect(page.anchor.todayBalance).toBeNull();
      expect(page.account).toEqual({ via: "unresolved", plaidAccountIds: [] });
      expect(page.totals).toEqual({ count: 1, moneyIn: "0.00", moneyOut: "12.00", net: "-12.00" });

      const b = await get(`/transactions/balances?dates=${TODAY}`);
      expect(b.status).toBe(200);
      expect((b.json as { balances: unknown }).balances).toEqual([{ date: TODAY, balance: null }]);
    } finally {
      actingUser = MAIN_USER;
    }
  });
});

describe("second review (R1–R3)", () => {
  it("R1: a pending row dated more than 14 days before today is labelled stalePending, and still moves the balance as before", async () => {
    actingUser = STALE_USER;
    try {
      const rows = rowsOf(await walk("", 100));
      expect(rows).toHaveLength(11);
      const row = (key: string) => rows.find((r) => r.id === staleIds.get(key))!;
      // The unmatched gas hold beside its lower posting: stale, and still counted
      // at its full amount (the open decision; nothing moves in this PR).
      expect(row("gasHold")).toMatchObject({ pending: true, stalePending: true, countsInBalance: true, balanceReason: "counted", balanceAmount: "-100.00" });
      expect(row("gasPosted")).toMatchObject({ pending: false, stalePending: false, balanceAmount: "-45.00" });
      // More than 14 days: 05-05 is stale, 05-06 (exactly 14) is not.
      expect(row("pending15")).toMatchObject({ stalePending: true, balanceAmount: "-8.00" });
      expect(row("pending14")).toMatchObject({ stalePending: false, balanceAmount: "-7.00" });
      expect(rows.filter((r) => r.stalePending).map((r) => r.id).sort()).toEqual(
        [staleIds.get("gasHold")!, staleIds.get("pending15")!].sort(),
      );

      // The label does not depend on why a row moves what it moves: the review
      // fixture's replaced pending row (04-20) is stale too, at 0.00.
      actingUser = REVIEW_USER;
      const review = rowsOf(await walk("", 100));
      expect(review.filter((r) => r.stalePending).map((r) => r.id)).toEqual([reviewIds.get("leftoverPending")]);
      expect(review.find((r) => r.id === reviewIds.get("leftoverPending"))).toMatchObject({ balanceReason: "superseded", balanceAmount: "0.00" });
    } finally {
      actingUser = MAIN_USER;
    }
  });

  it("R2: a pending row whose posted row is dated after today pairs only if the bank balance reads that row; today equals the spine and every earlier day is right", async () => {
    actingUser = STALE_USER;
    try {
      const bank = await spineBalance();
      expect(bank).toBe("968.00");
      const pages = await walk("", 100);
      const page = pages[0]!;
      const rows = rowsOf(pages);
      const row = (key: string) => rows.find((r) => r.id === staleIds.get(key))!;

      expect(page.balanceToday).toBe(bank);
      expect(page.balanceEnd).toBe(bank);
      expect(row("coffeePending").runningBalance).toBe(bank);
      expectChain(rows);

      // The repro: the posted coffee is dated tomorrow and not flagged, so the
      // bank balance never reads it and counts the pending −12.00 today. The
      // register pairs only what the bank balance reads, so it counts it too.
      expect(row("coffeePending")).toMatchObject({ countsInBalance: true, balanceReason: "counted", balanceAmount: "-12.00" });
      expect(row("coffeePosted")).toMatchObject({ afterToday: true, runningBalance: null, balanceAmount: "-12.00", replacedPendingId: null });
      // A flagged posted row after today IS read by the bank balance, which
      // pairs it: the pending −9.00 counts 0, on the register as in the spine.
      expect(row("wfPending")).toMatchObject({ countsInBalance: false, balanceReason: "superseded", balanceAmount: "0.00" });
      expect(row("wfPostedFlagged")).toMatchObject({ afterToday: true, runningBalance: null, replacedPendingId: staleIds.get("wfPending") });

      // Every row dated through today added back to 968.00, except the replaced
      // pending rows: 968 + 100 + 45 + 8 + 7 + 30 + 20 + 12. Pairing across today
      // gave 1,178.00 (the pending coffee at 0).
      expect(page.balanceStart).toBe("1190.00");
      const b = await get(`/transactions/balances?dates=2026-04-19,2026-05-15,2026-05-16,2026-05-18,2026-05-19,${TODAY},2026-05-21`);
      expect(b.status, JSON.stringify(b.json)).toBe(200);
      expect((b.json as { balances: unknown }).balances).toEqual([
        { date: "2026-04-19", balance: "1190.00" },
        // The snapshot's 1,000.00 plus the held-ahead −30.00, which sits on 05-16.
        { date: "2026-05-15", balance: "1030.00" },
        // 1,000.00 − the posted Target −20.00: what the bank held after 05-16.
        // Pairing only rows through today (without the flagged row) would read
        // 989.00 here: the pending −9.00 counted on 05-19.
        { date: "2026-05-16", balance: "980.00" },
        { date: "2026-05-18", balance: "980.00" },
        // The day before today. Pairing across today read 968.00: 12.00 low.
        { date: "2026-05-19", balance: "980.00" },
        { date: TODAY, balance: bank },
        { date: "2026-05-21", balance: null },
      ]);

      // Money out through today on balance amounts is the start less today.
      const throughToday = (await get(`/transactions/ledger?to=${TODAY}&limit=1`)).json as LedgerBody;
      expect(throughToday.totals).toEqual({ count: 9, moneyIn: "0.00", moneyOut: "222.00", net: "-222.00" });
      expect(cents(throughToday.balanceStart) - cents(throughToday.balanceToday)).toBe(cents("222.00"));
      // With no end date the rows after today are in the totals at their amounts,
      // so the coffee's −12.00 is in twice until its posted row's day arrives and
      // it pairs. Residual in the review note.
      expect(page.totals).toEqual({ count: 11, moneyIn: "0.00", moneyOut: "243.00", net: "-243.00" });
    } finally {
      actingUser = MAIN_USER;
    }
  });

  it("R3: heldAhead, now from isInSnapshot, is the anchored classifyCashRows run's label for every row of every fixture", async () => {
    try {
      for (const user of [MAIN_USER, REVIEW_USER, EDGE_USER, STALE_USER]) {
        actingUser = user;
        const pages = await walk("", 100);
        const rows = rowsOf(pages);
        const now = new Map(rows.map((r) => [r.id, r.heldAhead]));
        expect(now, user).toEqual(await heldAheadTheOldWay(pages[0]!, rows));
      }

      actingUser = STALE_USER;
      const rows = rowsOf(await walk("", 100));
      const row = (key: string) => rows.find((r) => r.id === staleIds.get(key))!;
      expect(row("heldPlain").heldAhead).toBe(true);
      // Not vacuous: the snapshot rule holds the posted Target row on its own,
      // but its pending half is not held, so it is not held ahead.
      const [posted] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, staleIds.get("targetPosted")!));
      expect(isInSnapshot(toCashRow(posted!), SNAPSHOT_AT, "2026-05-15")).toBe(true);
      expect(row("targetPosted")).toMatchObject({ heldAhead: false, replacedPendingId: staleIds.get("targetPending"), balanceAmount: "-20.00" });
    } finally {
      actingUser = MAIN_USER;
    }
  });
});

describe("(PR14 second review N1) review by filter never covers pending rows", () => {
  it("reviewed=true by filter needs pending=false: without it 400 pending_not_excluded and nothing written; with it the count leaves pending rows out and every pending row stays unreviewed; one pending row by id is still allowed", async () => {
    actingUser = STALE_USER;
    try {
      const t = transactionsTable;
      const reviewedIds = async () =>
        (
          await db
            .select({ id: t.id })
            .from(t)
            .where(and(eq(t.userId, STALE_USER), eq(t.reviewed, true)))
        )
          .map((r) => r.id)
          .sort();
      const pendingInRange = await db
        .select({ id: t.id, reviewed: t.reviewed })
        .from(t)
        .where(and(eq(t.userId, STALE_USER), eq(t.pending, true), sql`${t.occurredOn} >= '2026-04-01'`, sql`${t.occurredOn} <= ${TODAY}`));
      expect(pendingInRange.length).toBeGreaterThan(0);
      expect(pendingInRange.every((r) => !r.reviewed)).toBe(true);

      const range = `from=2026-04-01&to=${TODAY}&reviewed=false`;
      const allCount = ((await get(`/transactions/ledger?${range}&limit=1`)).json as LedgerBody).matchingCount;
      const postedCount = ((await get(`/transactions/ledger?${range}&pending=false&limit=1`)).json as LedgerBody).matchingCount;
      expect(allCount - postedCount).toBe(pendingInRange.length);
      const before = await reviewedIds();

      const base = { from: "2026-04-01", to: TODAY, reviewed: false };
      for (const filter of [base, { ...base, pending: true }]) {
        const refused = await request("POST", "/transactions/bulk-review-matching", { filter, reviewed: true, expectedCount: allCount });
        expect(refused.status, JSON.stringify(filter)).toBe(400);
        expect(refused.json).toMatchObject({ code: "pending_not_excluded" });
      }
      expect(await reviewedIds()).toEqual(before);

      // The count the client must hold is the posted count, not the list's.
      const wrong = await request("POST", "/transactions/bulk-review-matching", { filter: { ...base, pending: false }, reviewed: true, expectedCount: allCount });
      expect(wrong.status).toBe(409);
      expect(wrong.json).toMatchObject({ code: "matching_count_changed", matchingCount: postedCount });
      expect(await reviewedIds()).toEqual(before);

      const ok = await request("POST", "/transactions/bulk-review-matching", { filter: { ...base, pending: false }, reviewed: true, expectedCount: postedCount });
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      const result = BulkReviewMatchingTransactionsResponse.parse(ok.json);
      expect(result.matched).toBe(postedCount);
      const pendingAfter = await db
        .select({ reviewed: t.reviewed })
        .from(t)
        .where(inArray(t.id, pendingInRange.map((r) => r.id)));
      expect(pendingAfter.every((r) => !r.reviewed)).toBe(true);

      // One pending row, by id, as the page's per-row button does: allowed.
      const one = await request("POST", "/transactions/bulk-update", { ids: [pendingInRange[0]!.id], patch: { reviewed: true } });
      expect(one.status).toBe(200);
      const [onePending] = await db.select({ reviewed: t.reviewed }).from(t).where(eq(t.id, pendingInRange[0]!.id));
      expect(onePending!.reviewed).toBe(true);

      // Un-reviewing by filter is not restricted (it shields nothing); put the household back.
      const back = await request("POST", "/transactions/bulk-review-matching", {
        filter: { from: "2026-04-01", to: TODAY, reviewed: true },
        reviewed: false,
        expectedCount: result.updated + 1 + before.length,
      });
      expect(back.status, JSON.stringify(back.json)).toBe(200);
      await request("POST", "/transactions/bulk-update", { ids: before, patch: { reviewed: true } });
      expect(await reviewedIds()).toEqual(before);
    } finally {
      actingUser = MAIN_USER;
    }
  });
});
