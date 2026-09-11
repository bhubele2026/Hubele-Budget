// ⭐ PR13 — the paginated bank ledger (GET /transactions/ledger,
// GET /transactions/balances, POST /transactions/bulk-review-matching).
//
// One household carries the plan's fixture: 250 checking rows of −$1.00 and 10
// of +$100.00 (five rows on 05-10 have no institution time), 30 Amex rows the
// ledger must never show, and a bank snapshot of $5,000.00 read at 10:00 on
// 2026-05-15 in Chicago. Smaller households cover the scope edges: mask twins,
// manual rows, a PR4c pending/posted pair, no snapshot, and 1,001 rows.
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
import { and, eq, inArray } from "drizzle-orm";

const RUN = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const MAIN_USER = `ledger-main-${RUN}`;
const EDGE_USER = `ledger-edge-${RUN}`;
const NOSNAP_USER = `ledger-nosnap-${RUN}`;
const BIG_USER = `ledger-big-${RUN}`;
const USERS = [MAIN_USER, EDGE_USER, NOSNAP_USER, BIG_USER];
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
import transactionsLedgerRouter from "../routes/transactionsLedger";
import transactionsRouter from "../routes/transactions";
import spineRouter from "../routes/spine";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const routes = Router();
routes.use((req, _res, next) => {
  (req as { log?: unknown }).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
routes.use(transactionsLedgerRouter);
routes.use(transactionsRouter);
routes.use(spineRouter);
const { request } = createTestApp(routes);

const PINNED_NOW = new Date("2026-05-20T17:00:00Z"); // noon in Chicago
const TODAY = "2026-05-20";
const SNAPSHOT_AT = new Date("2026-05-15T15:00:00Z"); // 10:00 in Chicago
const RANGE = "from=2026-04-01&to=2026-05-20";

type LedgerBody = ReturnType<typeof GetTransactionsLedgerResponse.parse>;
type Row = { id: string; occurredOn: string; occurredAt: string | null; amount: string; runningBalance: string | null; plaidAccountId?: string | null; source: string; reviewed: boolean };
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
const money = (c: number) => (c / 100).toFixed(2);

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

let CHK = "";
let AMX = "";
let CHK_ROW_ID = "";
let AMX_ROW_ID = "";
let CATEGORY_ID = "";
let checking: Seeded[] = [];
const byKey = new Map<string, Seeded>();

// Edge household
let EDGE_EXT1 = "";
let EDGE_EXT2 = "";
let EDGE_TWIN_ROW_ID = "";
let EDGE_CREDIT_ROW_ID = "";
const edgeIds = new Map<string, string>();

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
  await db.insert(forecastSettingsTable).values({
    userId: MAIN_USER,
    householdId,
    daysAhead: 90,
    cashBuffer: "500.00",
    bankSnapshotBalance: "5000.00",
    bankSnapshotAt: SNAPSHOT_AT,
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: CHK_ROW_ID,
    bankSnapshotMask: "5526",
  });
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
  await db.insert(forecastSettingsTable).values({
    userId: EDGE_USER,
    householdId,
    daysAhead: 90,
    cashBuffer: "0",
    bankSnapshotBalance: "1000.00",
    bankSnapshotAt: SNAPSHOT_AT,
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: main.rowId,
    bankSnapshotMask: "7777",
  });
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

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
  for (const u of USERS) householdOf.set(u, (await createTestHousehold(u)).householdId);
  await cleanup();
  await seedMain();
  await seedEdge();
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

    for (const p of pages) {
      expect(p.matchingCount).toBe(260);
      expect(p.totals).toEqual({ count: 260, moneyIn: "1000.00", moneyOut: "250.00", net: "750.00" });
      expect(p.review).toEqual({ reviewed: 0, unreviewed: 260 });
      expect(p.balanceStart).toBe("4331.00");
      expect(p.balanceEnd).toBe("5081.00");
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

  it("defaults to 50 rows and refuses a limit outside 1–100 or a bad cursor", async () => {
    const first = await get(`/transactions/ledger?${RANGE}`);
    expect(first.status).toBe(200);
    expect((first.json as LedgerBody).rows).toHaveLength(50);
    expect((first.json as LedgerBody).limit).toBe(50);

    for (const limit of ["101", "0", "1.5", "abc", ""]) {
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
    for (let k = 0; k < rows.length - 1; k++) {
      expect(cents(rows[k]!.runningBalance) - cents(rows[k]!.amount)).toBe(cents(rows[k + 1]!.runningBalance));
    }
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
  it("today's balance is the spine's bank balance, and the snapshot rule, not the day rule, set it", async () => {
    const spine = await get("/spine");
    expect(spine.status, JSON.stringify(spine.json)).toBe(200);
    const bank = (spine.json as { bank: { balance: string } }).bank.balance;
    expect(bank).toBe("5081.00");

    const r = await get(`/transactions/balances?dates=${TODAY},2026-03-31,2026-05-03,2026-05-15,${TODAY}`);
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

  it("bulk review by filter: a stale count is a 409 that changes nothing, a misspelt filter is a 400, and the right count reviews all 240", async () => {
    const filter = { from: "2026-04-01", to: TODAY, reviewed: false };
    const reviewedInDb = async () =>
      (
        await db
          .select({ id: transactionsTable.id })
          .from(transactionsTable)
          .where(and(eq(transactionsTable.userId, MAIN_USER), eq(transactionsTable.reviewed, true)))
      ).length;
    expect(await reviewedInDb()).toBe(20);

    const stale = await request("POST", "/transactions/bulk-review-matching", { filter, reviewed: true, expectedCount: 239 });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: "matching_count_changed", matchingCount: 240 });
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

    const ok = await request("POST", "/transactions/bulk-review-matching", { filter, reviewed: true, expectedCount: 240 });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const result = BulkReviewMatchingTransactionsResponse.parse(ok.json);
    expect(result.matched).toBe(240);
    expect(result.updated).toBe(240);
    expect(new Set(result.updatedIds).size).toBe(240);
    expect(await reviewedInDb()).toBe(260);

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
    expect((after.json as LedgerBody).review).toEqual({ reviewed: 260, unreviewed: 0 });
    expect((after.json as LedgerBody).totals.net).toBe("750.00");

    // Rows already in the target state are matched but not updated.
    const again = await request("POST", "/transactions/bulk-review-matching", {
      filter: { from: "2026-04-01", to: TODAY },
      reviewed: true,
      expectedCount: 260,
    });
    expect(again.status).toBe(200);
    expect(again.json).toEqual({ matched: 260, updated: 0, updatedIds: [] });
  });

  it("refuses more than 1,000 matching rows and changes none of them", async () => {
    actingUser = BIG_USER;
    try {
      const r = await request("POST", "/transactions/bulk-review-matching", { filter: {}, reviewed: true, expectedCount: 1001 });
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
});

describe("scope edges", () => {
  it("mask twins and manual rows are on the ledger; Amex-sourced manual rows and a same-mask card are not", async () => {
    actingUser = EDGE_USER;
    try {
      const r = await get("/transactions/ledger?limit=100");
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      const page = r.json as LedgerBody;
      expect(new Set(page.rows.map((row) => row.id))).toEqual(
        new Set(
          ["main", "twin", "manual", "emptyPlaidId", "pendingCoffee", "postedCoffee"].map((k) => edgeIds.get(k)!),
        ),
      );
      expect([...page.account.plaidAccountIds].sort()).toEqual([EDGE_EXT1, EDGE_EXT2].sort());

      // The bank balance counts the main account and the manual rows but not the
      // twin, and counts the replaced pending coffee once (PR4c):
      // 1000 − 10 − 30 − 5 − 25 = 930.00. The register lists every row at its
      // full amount and ties to that balance today, so the twin's −20 and the
      // pending −25 move the days before them (disclosed in lib/bankLedger.ts).
      const spine = await get("/spine");
      expect((spine.json as { bank: { balance: string } }).bank.balance).toBe("930.00");
      expect(page.anchor.todayBalance).toBe("930.00");
      expect(page.rows[0]!.runningBalance).toBe("930.00");
      expect(page.totals.net).toBe("-115.00");
      expect(page.balanceStart).toBe(money(cents("930.00") + 11500));

      const viaTwin = await get(`/transactions/ledger?account=${EDGE_TWIN_ROW_ID}&limit=1`);
      expect(viaTwin.status).toBe(200);
      const viaCard = await get(`/transactions/ledger?account=${EDGE_CREDIT_ROW_ID}&limit=1`);
      expect(viaCard.status).toBe(400);
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
