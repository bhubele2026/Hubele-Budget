// ⭐ PR14 review H1 — the ledger for a Chase account other than the snapshot's.
//
// The Chase page offers an account picker when a household has two or more
// Chase checking accounts. Picking the second one sends `account=<its id>`;
// PR13 answered 400. The contract now: any Chase depository account of the
// household is accepted with its mask twins. Its rows, totals and review counts
// come back with every balance null (`balanceUnavailableReason`
// "not_snapshot_account"); no balance is computed for it and no manual row is on
// it. The snapshot's account is unchanged to the cent.
//
// Household H: Chase checking A (mask 1111, the snapshot's: $2,000.00 read
// 2026-05-15 at 10:00 in Chicago) and its twin; Chase checking B (mask 2222) and
// its twin; manual rows; Amex rows (on the card's Plaid account, and imported);
// an Amex card; a PayPal depository account; a Chase credit card with mask 2222.
// Household H2 has its own Chase checking account. A household with no snapshot
// has a Chase checking and a Chase savings account. A fourth household covers
// the ledger's `uncategorized` filter (PR7's rule).
//
// The clock is pinned: today is 2026-05-20 in Chicago.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { eq, inArray } from "drizzle-orm";

const RUN = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const H_USER = `ledger-other-h-${RUN}`;
const H2_USER = `ledger-other-h2-${RUN}`;
const NOSNAP_USER = `ledger-other-nosnap-${RUN}`;
const CAT_USER = `ledger-other-cat-${RUN}`;
const USERS = [H_USER, H2_USER, NOSNAP_USER, CAT_USER];
const householdOf = new Map<string, string>();
let actingUser = H_USER;

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

// The real cash signal, watched: another account's ledger must never compute it.
vi.mock("../lib/cashSignal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cashSignal")>();
  return { ...actual, computeCashSignal: vi.fn(actual.computeCashSignal) };
});

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
import { computeCashSignal } from "../lib/cashSignal";
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

type LedgerBody = ReturnType<typeof GetTransactionsLedgerResponse.parse>;
type Row = {
  id: string;
  occurredOn: string;
  amount: string;
  runningBalance: string | null;
  balanceAmount: string | null;
  countsInBalance: boolean;
  balanceReason: string;
  replacedPendingId: string | null;
  heldAhead: boolean;
  afterToday: boolean;
  stalePending: boolean;
  reviewed: boolean;
};

type AccountKey = "A" | "At" | "B" | "Bt" | "AMX" | "PAYPAL" | "CC";
type Spec = {
  key: string;
  /** The Plaid account the row is on; null for a row with no Plaid account. */
  account: AccountKey | null;
  source: string;
  day: string;
  amount: string;
  description: string;
  pending?: boolean;
  reviewed?: boolean;
  createdAt?: Date;
};
type Seeded = Spec & { id: string };

/**
 * Household H's rows. Every row is untimed, so the ledger orders a day's rows by
 * id. The comments say what the cash rule does with each row, worked out by hand.
 */
const H_ROWS: Spec[] = [
  // A, the snapshot's account. Dated before the snapshot day: inside the $2,000.00.
  { key: "a1", account: "A", source: "plaid", day: "2026-05-10", amount: "-100.00", description: "GROCER ALPHA" },
  // After the read: counted in today's balance.
  { key: "a2", account: "A", source: "plaid", day: "2026-05-18", amount: "-25.00", description: "HARDWARE BETA" },
  { key: "a3", account: "A", source: "plaid", day: "2026-05-19", amount: "500.00", description: "PAYROLL GAMMA" },
  // A's twin: listed with A, moves nothing.
  { key: "at1", account: "At", source: "plaid", day: "2026-05-19", amount: "-40.00", description: "TWIN A DELTA" },
  // Manual rows belong to the bank balance's account: on A's ledger, never on B's.
  { key: "m1", account: null, source: "manual", day: "2026-05-12", amount: "-60.00", description: "MANUAL EPSILON" },
  { key: "m2", account: null, source: "manual", day: "2026-05-19", amount: "-15.00", description: "MANUAL ZETA" },
  // Amex, on the card's Plaid account and imported: on no ledger.
  { key: "x1", account: "AMX", source: "plaid:amex", day: "2026-05-11", amount: "-70.00", description: "AMEX ETA" },
  { key: "x2", account: null, source: "amex", day: "2026-05-13", amount: "-80.00", description: "AMEX IMPORT THETA" },
  // PayPal and the Chase card: on no ledger.
  { key: "p1", account: "PAYPAL", source: "plaid", day: "2026-05-14", amount: "-33.00", description: "PAYPAL IOTA" },
  { key: "cc1", account: "CC", source: "plaid", day: "2026-05-16", amount: "-44.00", description: "CHASE CARD KAPPA" },
  // B.
  { key: "b1", account: "B", source: "plaid", day: "2026-04-02", amount: "1000.00", description: "SAVINGS TRANSFER IN" },
  { key: "b2", account: "B", source: "plaid", day: "2026-04-15", amount: "-212.34", description: "BOOKSHOP LAMBDA" },
  // Still pending, 30 days old, no posting pairs with it: stale, and counted.
  { key: "b8", account: "B", source: "plaid", day: "2026-04-20", amount: "-9.99", pending: true, description: "NEWSSTAND MU" },
  // B's twin: listed with B, counts 0.
  { key: "bt1", account: "Bt", source: "plaid", day: "2026-05-02", amount: "-55.55", description: "TWIN B NU" },
  // PR4c: the posted row replaces the pending row, which counts 0.
  { key: "b4", account: "B", source: "plaid", day: "2026-05-17", amount: "-30.00", pending: true, description: "BLUE BOTTLE COFFEE" },
  { key: "b5", account: "B", source: "plaid", day: "2026-05-18", amount: "-30.00", description: "BLUE BOTTLE COFFEE 0518" },
  { key: "b6", account: "B", source: "plaid", day: "2026-05-19", amount: "-7.89", reviewed: true, description: "PHARMACY XI" },
  { key: "bt2", account: "Bt", source: "plaid", day: "2026-05-19", amount: "20.00", description: "TWIN B OMICRON" },
  // Typed today, dated after it: listed, counted in the totals.
  { key: "b7", account: "B", source: "plaid", day: "2026-05-25", amount: "-45.00", description: "UTILITY PI", createdAt: createdAtStartOfHouseholdDay(TODAY) },
];
/** The rows the cash rule counts 0 on B's ledger (picked as B). */
const B_NOT_COUNTED = new Set(["bt1", "bt2", "b4"]);
/** The rows the cash rule counts 0 on A's ledger. */
const A_NOT_COUNTED = new Set(["at1"]);
const A_SCOPE = (s: Spec) =>
  s.account === "A" || s.account === "At" || (s.account === null && s.source !== "amex" && !s.source.startsWith("plaid:"));
const B_SCOPE = (s: Spec) => s.account === "B" || s.account === "Bt";

const rowOf = new Map<string, Seeded>();
const accountRow = new Map<AccountKey | "H2" | "NS_CHK" | "NS_SAV" | "CAT", { rowId: string; externalId: string }>();
const nosnapIds = new Map<string, string>();
const catIds = new Map<string, string>();

const cents = (s: string | null | undefined): number => {
  if (s === null || s === undefined) throw new Error("expected money, got null");
  return Math.round(Number(s) * 100);
};
const fmt = (c: number): string => {
  const abs = Math.abs(c);
  return `${c < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
};

/** `totals`, computed independently: the rows matching the filter, summing the counted rows' amounts. */
function totalsOf(rows: Spec[], notCounted: Set<string>): { count: number; moneyIn: string; moneyOut: string; net: string } {
  let moneyIn = 0;
  let moneyOut = 0;
  for (const s of rows) {
    if (notCounted.has(s.key)) continue;
    const c = cents(s.amount);
    if (c > 0) moneyIn += c;
    else moneyOut -= c;
  }
  return { count: rows.length, moneyIn: fmt(moneyIn), moneyOut: fmt(moneyOut), net: fmt(moneyIn - moneyOut) };
}

/** The ledger's order, computed independently: day desc, then (untimed rows) id desc. */
function newestFirst(a: Seeded, b: Seeded): number {
  if (a.day !== b.day) return a.day < b.day ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

const seeded = (pred: (s: Spec) => boolean): Seeded[] => H_ROWS.filter(pred).map((s) => rowOf.get(s.key)!);

async function get(path: string): Promise<{ status: number; json: unknown }> {
  return request("GET", path);
}

async function ledger(query: string): Promise<LedgerBody> {
  const { status, json } = await get(`/transactions/ledger?${query}`);
  expect(status, `${query} -> ${JSON.stringify(json)}`).toBe(200);
  // The response matches the generated schema; keep the raw body.
  GetTransactionsLedgerResponse.parse(json);
  return json as LedgerBody;
}

async function walk(query: string, limit: number): Promise<LedgerBody[]> {
  const pages: LedgerBody[] = [];
  let cursor: string | null = null;
  do {
    pages.push(await ledger(`${query}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
    cursor = pages[pages.length - 1]!.nextCursor ?? null;
    if (pages.length > 50) throw new Error("the cursor never ran out");
  } while (cursor);
  return pages;
}

const rowsOf = (pages: LedgerBody[]) => pages.flatMap((p) => p.rows as unknown as Row[]);

async function spineBalance(): Promise<string> {
  const spine = await get("/spine");
  expect(spine.status, JSON.stringify(spine.json)).toBe(200);
  return (spine.json as { bank: { balance: string } }).bank.balance;
}

async function reviewedByKey(): Promise<Map<string, boolean>> {
  const rows = await db
    .select({ id: transactionsTable.id, reviewed: transactionsTable.reviewed })
    .from(transactionsTable)
    .where(eq(transactionsTable.userId, H_USER));
  const keyOf = new Map([...rowOf.values()].map((s) => [s.id, s.key]));
  return new Map(rows.map((r) => [keyOf.get(r.id)!, r.reviewed]));
}

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

async function insertRows(
  userId: string,
  rows: Array<{ key: string; day: string; amount: string; plaidAccountId: string | null; source: string; pending?: boolean; reviewed?: boolean; categoryId?: string | null; createdAt?: Date }>,
): Promise<Map<string, string>> {
  const inserted = await db
    .insert(transactionsTable)
    .values(
      rows.map((r) => ({
        userId,
        householdId: householdOf.get(userId)!,
        occurredOn: r.day,
        createdAt: r.createdAt ?? createdAtStartOfHouseholdDay(r.day),
        description: `ROW ${r.key}`,
        amount: r.amount,
        pending: r.pending ?? false,
        reviewed: r.reviewed ?? false,
        categoryId: r.categoryId ?? null,
        plaidAccountId: r.plaidAccountId,
        plaidTransactionId: r.plaidAccountId ? `ptx-${RUN}-${userId}-${r.key}` : null,
        source: r.source,
      })),
    )
    .returning({ id: transactionsTable.id, description: transactionsTable.description });
  return new Map(inserted.map((r) => [r.description.slice("ROW ".length), r.id]));
}

async function seedH(): Promise<void> {
  const householdId = householdOf.get(H_USER)!;
  const chase = { institutionName: "Chase", type: "depository", subtype: "checking" };
  accountRow.set("A", await addAccount(H_USER, { ...chase, mask: "1111" }));
  accountRow.set("At", await addAccount(H_USER, { ...chase, institutionName: "CHASE", mask: "1111" }));
  accountRow.set("B", await addAccount(H_USER, { ...chase, mask: "2222" }));
  accountRow.set("Bt", await addAccount(H_USER, { ...chase, institutionName: "chase", mask: "2222" }));
  accountRow.set("AMX", await addAccount(H_USER, { institutionName: "American Express", mask: "3003", type: "credit", subtype: "credit card" }));
  accountRow.set("PAYPAL", await addAccount(H_USER, { institutionName: "PayPal", mask: "4004", type: "depository", subtype: "paypal" }));
  accountRow.set("CC", await addAccount(H_USER, { institutionName: "Chase", mask: "2222", type: "credit", subtype: "credit card" }));
  await db.insert(forecastSettingsTable).values({
    userId: H_USER,
    householdId,
    daysAhead: 90,
    cashBuffer: "0",
    bankSnapshotBalance: "2000.00",
    bankSnapshotAt: SNAPSHOT_AT,
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: accountRow.get("A")!.rowId,
    bankSnapshotMask: "1111",
  });
  const inserted = await db
    .insert(transactionsTable)
    .values(
      H_ROWS.map((s) => ({
        userId: H_USER,
        householdId,
        occurredOn: s.day,
        occurredAt: null,
        createdAt: s.createdAt ?? createdAtStartOfHouseholdDay(s.day),
        description: s.description,
        amount: s.amount,
        pending: s.pending ?? false,
        reviewed: s.reviewed ?? false,
        plaidAccountId: s.account ? accountRow.get(s.account)!.externalId : null,
        plaidTransactionId: s.account ? `ptx-${RUN}-${s.key}` : null,
        source: s.source,
      })),
    )
    .returning({ id: transactionsTable.id, description: transactionsTable.description });
  const idOf = new Map(inserted.map((r) => [r.description, r.id]));
  for (const s of H_ROWS) rowOf.set(s.key, { ...s, id: idOf.get(s.description)! });

  // H2: another household's Chase checking account, with a row of its own.
  accountRow.set("H2", await addAccount(H2_USER, { ...chase, mask: "5555" }));
  await insertRows(H2_USER, [{ key: "h2", day: "2026-05-12", amount: "-1.00", plaidAccountId: accountRow.get("H2")!.externalId, source: "plaid" }]);
}

async function seedNoSnapshot(): Promise<void> {
  // No forecast settings: the checking account resolves as the sole checking
  // account, and there is no snapshot.
  accountRow.set("NS_CHK", await addAccount(NOSNAP_USER, { institutionName: "Chase", mask: "6666", type: "depository", subtype: "checking" }));
  accountRow.set("NS_SAV", await addAccount(NOSNAP_USER, { institutionName: "Chase", mask: "6677", type: "depository", subtype: "savings" }));
  const ids = await insertRows(NOSNAP_USER, [
    { key: "n1", day: "2026-05-12", amount: "-12.00", plaidAccountId: accountRow.get("NS_CHK")!.externalId, source: "plaid" },
    { key: "n2", day: "2026-05-13", amount: "-3.00", plaidAccountId: null, source: "manual" },
    { key: "n3", day: "2026-05-14", amount: "8.00", plaidAccountId: accountRow.get("NS_SAV")!.externalId, source: "plaid" },
  ]);
  for (const [k, v] of ids) nosnapIds.set(k, v);
}

async function seedCategories(): Promise<void> {
  accountRow.set("CAT", await addAccount(CAT_USER, { institutionName: "Chase", mask: "8888", type: "depository", subtype: "checking" }));
  const ext = accountRow.get("CAT")!.externalId;
  const [live] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: CAT_USER, householdId: householdOf.get(CAT_USER)!, name: "Groceries", kind: "expense", groupName: "Living" })
    .returning();
  const [doomed] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: CAT_USER, householdId: householdOf.get(CAT_USER)!, name: "Deleted Later", kind: "expense", groupName: "Living" })
    .returning();
  // A category that exists, but in another household.
  const [foreign] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: H2_USER, householdId: householdOf.get(H2_USER)!, name: "Their Category", kind: "expense", groupName: "Living" })
    .returning();
  const ids = await insertRows(CAT_USER, [
    { key: "none", day: "2026-05-11", amount: "-10.00", plaidAccountId: ext, source: "plaid" },
    { key: "live", day: "2026-05-12", amount: "-20.00", plaidAccountId: ext, source: "plaid", categoryId: live!.id },
    { key: "deleted", day: "2026-05-13", amount: "-30.00", plaidAccountId: ext, source: "plaid", categoryId: doomed!.id },
    { key: "neverExisted", day: "2026-05-14", amount: "40.00", plaidAccountId: ext, source: "plaid", categoryId: randomUUID(), reviewed: true },
    { key: "foreign", day: "2026-05-15", amount: "-50.00", plaidAccountId: ext, source: "plaid", categoryId: foreign!.id },
  ]);
  for (const [k, v] of ids) catIds.set(k, v);
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.id, doomed!.id));
  // The delete leaves the row pointing at the id that is gone.
  const [row] = await db.select({ categoryId: transactionsTable.categoryId }).from(transactionsTable).where(eq(transactionsTable.id, catIds.get("deleted")!));
  expect(row!.categoryId).toBe(doomed!.id);
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_NOW);
  for (const u of USERS) householdOf.set(u, (await createTestHousehold(u)).householdId);
  await cleanup();
  await seedH();
  await seedNoSnapshot();
  await seedCategories();
});

afterAll(async () => {
  await cleanup();
  vi.useRealTimers();
});

const NO_BALANCE_ANCHOR = { today: TODAY, todayBalance: null, snapshotBalance: null, snapshotAt: null, snapshotDay: null };

describe("another Chase checking account (B)", () => {
  it("lists exactly B's and its twin's rows, newest first, every page with no balance, the cash rule's labels and totals computed from B's counted rows", async () => {
    const B = accountRow.get("B")!;
    const signal = vi.mocked(computeCashSignal);
    signal.mockClear();

    const pages = await walk(`account=${B.rowId}`, 3);
    expect(pages.map((p) => p.rows.length)).toEqual([3, 3, 3]);
    expect(pages[2]!.nextCursor).toBeNull();
    const rows = rowsOf(pages);
    const expected = seeded(B_SCOPE).sort(newestFirst);
    expect(rows.map((r) => r.id)).toEqual(expected.map((s) => s.id));
    // Nothing of A's, no manual, Amex, PayPal or card row.
    const outside = new Set(seeded((s) => !B_SCOPE(s)).map((s) => s.id));
    expect(rows.some((r) => outside.has(r.id))).toBe(false);

    const row = (key: string) => rows.find((r) => r.id === rowOf.get(key)!.id)!;
    for (const r of rows) {
      expect(r.balanceAmount).toBeNull();
      expect(r.runningBalance).toBeNull();
      expect(r.heldAhead).toBe(false);
    }
    for (const key of ["bt1", "bt2"]) {
      expect(row(key)).toMatchObject({ countsInBalance: false, balanceReason: "not_bank" });
    }
    expect(row("b4")).toMatchObject({ countsInBalance: false, balanceReason: "superseded" });
    expect(row("b5")).toMatchObject({ countsInBalance: true, balanceReason: "counted", replacedPendingId: rowOf.get("b4")!.id });
    expect(row("b8")).toMatchObject({ countsInBalance: true, balanceReason: "counted", stalePending: true });
    expect(row("b7")).toMatchObject({ countsInBalance: true, afterToday: true });
    for (const r of rows) {
      const key = [...rowOf.values()].find((s) => s.id === r.id)!.key;
      expect(r.countsInBalance, key).toBe(!B_NOT_COUNTED.has(key));
      expect(r.afterToday, key).toBe(key === "b7");
      expect(r.stalePending, key).toBe(key === "b8");
    }

    const totals = totalsOf(H_ROWS.filter(B_SCOPE), B_NOT_COUNTED);
    // The same figures by hand: in 1,000.00; out 212.34 + 9.99 + 30.00 + 7.89 + 45.00.
    expect(totals).toEqual({ count: 9, moneyIn: "1000.00", moneyOut: "305.22", net: "694.78" });
    for (const p of pages) {
      expect(p.totals).toEqual(totals);
      expect(p.matchingCount).toBe(9);
      expect(p.review).toEqual({ reviewed: 1, unreviewed: 8 });
      expect(p.balanceStart).toBeNull();
      expect(p.balanceEnd).toBeNull();
      expect(p.balanceToday).toBeNull();
      expect(p.balanceUnavailableReason).toBe("not_snapshot_account");
      expect(p.anchor).toEqual(NO_BALANCE_ANCHOR);
      expect(p.account.via).toBe("pointer");
      expect([...p.account.plaidAccountIds].sort()).toEqual([B.externalId, accountRow.get("Bt")!.externalId].sort());
    }
    // No balance was computed for it.
    expect(signal).not.toHaveBeenCalled();
  });

  it("applies from/to and reviewed=false: totals and review counts over the range, matchingCount with reviewed too", async () => {
    const B = accountRow.get("B")!;
    const page = await ledger(`account=${B.rowId}&from=2026-05-01&to=${TODAY}&reviewed=false&limit=100`);
    const inRange = H_ROWS.filter((s) => B_SCOPE(s) && s.day >= "2026-05-01" && s.day <= TODAY);
    const unreviewed = inRange.filter((s) => !s.reviewed);
    expect((page.rows as unknown as Row[]).map((r) => r.id)).toEqual(
      unreviewed.map((s) => rowOf.get(s.key)!).sort(newestFirst).map((s) => s.id),
    );
    expect(page.matchingCount).toBe(unreviewed.length);
    expect(page.matchingCount).toBe(4);
    expect(page.totals).toEqual(totalsOf(inRange, B_NOT_COUNTED));
    expect(page.totals).toEqual({ count: 5, moneyIn: "0.00", moneyOut: "37.89", net: "-37.89" });
    expect(page.review).toEqual({ reviewed: 1, unreviewed: 4 });
    // The pairing still reads B's whole history: the pending coffee counts 0.
    expect((page.rows as unknown as Row[]).find((r) => r.id === rowOf.get("b4")!.id)).toMatchObject({ balanceReason: "superseded", balanceAmount: null });
    expect(page.balanceStart).toBeNull();
    expect(page.balanceEnd).toBeNull();
    expect(page.balanceUnavailableReason).toBe("not_snapshot_account");
  });

  it("balances for B are all null, with the reason, and compute nothing", async () => {
    const B = accountRow.get("B")!;
    const signal = vi.mocked(computeCashSignal);
    signal.mockClear();
    const r = await get(`/transactions/balances?account=${B.rowId}&dates=2026-04-01,2026-05-18,${TODAY},2026-05-21`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    GetTransactionsBalancesResponse.parse(r.json);
    const body = r.json as { balances: unknown; balanceUnavailableReason: unknown; anchor: unknown; account: { plaidAccountIds: string[] } };
    expect(body.balances).toEqual([
      { date: "2026-04-01", balance: null },
      { date: "2026-05-18", balance: null },
      { date: TODAY, balance: null },
      { date: "2026-05-21", balance: null },
    ]);
    expect(body.balanceUnavailableReason).toBe("not_snapshot_account");
    expect(body.anchor).toEqual(NO_BALANCE_ANCHOR);
    expect([...body.account.plaidAccountIds].sort()).toEqual([B.externalId, accountRow.get("Bt")!.externalId].sort());
    expect(signal).not.toHaveBeenCalled();
  });

  it("picked through its twin, the same rows are listed and the twin is the account the cash rule reads", async () => {
    const page = await ledger(`account=${accountRow.get("Bt")!.rowId}&limit=100`);
    const rows = page.rows as unknown as Row[];
    expect(rows.map((r) => r.id)).toEqual(seeded(B_SCOPE).sort(newestFirst).map((s) => s.id));
    for (const r of rows) {
      const s = [...rowOf.values()].find((x) => x.id === r.id)!;
      expect(r.balanceAmount).toBeNull();
      if (s.account === "B") expect(r.balanceReason, s.key).toBe("not_bank");
      else expect(r.balanceReason, s.key).toBe("counted");
    }
    expect(page.totals).toEqual(totalsOf(H_ROWS.filter(B_SCOPE), new Set(H_ROWS.filter((s) => s.account === "B").map((s) => s.key))));
    expect(page.balanceUnavailableReason).toBe("not_snapshot_account");
  });
});

describe("the snapshot's account (A) is unchanged", () => {
  it("no account, account=A and account=A's twin answer identically, with totals and balances computed without B, and today's balance is the spine's", async () => {
    const A = accountRow.get("A")!;
    const byDefault = await ledger("limit=100");
    const byA = await ledger(`account=${A.rowId}&limit=100`);
    const byTwin = await ledger(`account=${accountRow.get("At")!.rowId}&limit=100`);
    expect(byA).toEqual(byDefault);
    expect(byTwin).toEqual(byDefault);

    const scope = seeded(A_SCOPE).sort(newestFirst);
    const rows = byDefault.rows as unknown as Row[];
    expect(rows.map((r) => r.id)).toEqual(scope.map((s) => s.id));

    // The spine's bank balance, by hand, reading only A and the manual rows: the
    // $2,000.00 snapshot plus the rows after the read (a2, a3, m2). a1 and m1 are
    // inside it; A's twin, B, B's twin and every card row are not A's.
    const bank = await spineBalance();
    expect(bank).toBe(fmt(200000 + cents("-25.00") + cents("500.00") + cents("-15.00")));
    expect(bank).toBe("2460.00");

    const totals = totalsOf(H_ROWS.filter(A_SCOPE), A_NOT_COUNTED);
    expect(totals).toEqual({ count: 6, moneyIn: "500.00", moneyOut: "200.00", net: "300.00" });
    expect(byDefault.totals).toEqual(totals);
    expect(byDefault.matchingCount).toBe(6);
    expect(byDefault.review).toEqual({ reviewed: 0, unreviewed: 6 });
    expect(byDefault.balanceToday).toBe(bank);
    expect(byDefault.balanceEnd).toBe(bank);
    // Today less every counted row dated through today.
    expect(byDefault.balanceStart).toBe(fmt(cents(bank) - cents(totals.net)));
    expect(byDefault.balanceStart).toBe("2160.00");
    expect(byDefault.balanceUnavailableReason).toBeNull();
    expect(byDefault.anchor).toEqual({
      today: TODAY,
      todayBalance: bank,
      snapshotBalance: "2000.00",
      snapshotAt: SNAPSHOT_AT.toISOString(),
      snapshotDay: "2026-05-15",
    });
    expect([...byDefault.account.plaidAccountIds].sort()).toEqual([A.externalId, accountRow.get("At")!.externalId].sort());

    const row = (key: string) => rows.find((r) => r.id === rowOf.get(key)!.id)!;
    expect(row("at1")).toMatchObject({ countsInBalance: false, balanceReason: "not_bank", balanceAmount: "0.00" });
    for (const key of ["a1", "a2", "a3", "m1", "m2"]) {
      expect(row(key)).toMatchObject({ countsInBalance: true, balanceReason: "counted", balanceAmount: rowOf.get(key)!.amount });
    }
    expect(rows[0]!.runningBalance).toBe(bank);
    for (let k = 0; k < rows.length - 1; k++) {
      expect(cents(rows[k]!.runningBalance) - cents(rows[k]!.balanceAmount), `row ${k}`).toBe(cents(rows[k + 1]!.runningBalance));
    }
    const oldest = rows[rows.length - 1]!;
    expect(cents(oldest.runningBalance)).toBe(cents(byDefault.balanceStart) + cents(oldest.balanceAmount));

    const b = await get(`/transactions/balances?dates=2026-05-09,2026-05-10,2026-05-12,2026-05-15,2026-05-18,2026-05-19,${TODAY},2026-05-21`);
    expect(b.status, JSON.stringify(b.json)).toBe(200);
    const body = GetTransactionsBalancesResponse.parse(b.json);
    expect(body.balanceUnavailableReason).toBeNull();
    expect(body.balances).toEqual([
      { date: "2026-05-09", balance: "2160.00" },
      { date: "2026-05-10", balance: "2060.00" },
      { date: "2026-05-12", balance: "2000.00" },
      { date: "2026-05-15", balance: "2000.00" },
      { date: "2026-05-18", balance: "1975.00" },
      { date: "2026-05-19", balance: bank },
      { date: TODAY, balance: bank },
      { date: "2026-05-21", balance: null },
    ]);
    const viaA = await get(`/transactions/balances?account=${A.rowId}&dates=2026-05-09,2026-05-10,2026-05-12,2026-05-15,2026-05-18,2026-05-19,${TODAY},2026-05-21`);
    expect(viaA.json).toEqual(b.json);
    // The snapshot's ledger does read the cash signal: the watch above is live.
    expect(vi.mocked(computeCashSignal)).toHaveBeenCalled();
  });
});

describe("accounts that are not a Chase depository account of the household", () => {
  it("the Amex card, PayPal, the Chase card with B's mask and another household's Chase account are 400 account_not_ledger everywhere; a non-uuid is invalid_account; nothing is written", async () => {
    const before = await reviewedByKey();
    const cases: Array<[string, string, string]> = [
      ["Amex card", accountRow.get("AMX")!.rowId, "account_not_ledger"],
      ["PayPal", accountRow.get("PAYPAL")!.rowId, "account_not_ledger"],
      ["Chase card, mask 2222", accountRow.get("CC")!.rowId, "account_not_ledger"],
      ["H2's Chase checking", accountRow.get("H2")!.rowId, "account_not_ledger"],
      ["abc", "abc", "invalid_account"],
    ];
    for (const [name, account, code] of cases) {
      const page = await get(`/transactions/ledger?account=${account}`);
      expect(page.status, `${name} ledger`).toBe(400);
      expect(page.json, `${name} ledger`).toMatchObject({ code });
      const balances = await get(`/transactions/balances?account=${account}&dates=${TODAY}`);
      expect(balances.status, `${name} balances`).toBe(400);
      expect(balances.json, `${name} balances`).toMatchObject({ code });
      const bulk = await request("POST", "/transactions/bulk-review-matching", { filter: { account }, reviewed: true, expectedCount: 0 });
      expect(bulk.status, `${name} bulk`).toBe(400);
      expect(bulk.json, `${name} bulk`).toMatchObject({ code });
    }
    expect(await reviewedByKey()).toEqual(before);
    const [h2Row] = await db.select({ reviewed: transactionsTable.reviewed }).from(transactionsTable).where(eq(transactionsTable.userId, H2_USER));
    expect(h2Row!.reviewed).toBe(false);
  });
});

describe("bulk review for B", () => {
  it("a stale count is a 409 that writes nothing; the right count reviews only B's and its twin's rows, and A's ledger does not move", async () => {
    const B = accountRow.get("B")!;
    const aBefore = await ledger("limit=100");
    const before = await reviewedByKey();
    const filter = { account: B.rowId, from: "2026-04-01", to: TODAY, reviewed: false };
    const matching = H_ROWS.filter((s) => B_SCOPE(s) && s.day >= "2026-04-01" && s.day <= TODAY && !s.reviewed);
    expect(matching).toHaveLength(7);

    const stale = await request("POST", "/transactions/bulk-review-matching", { filter, reviewed: true, expectedCount: matching.length - 1 });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: "matching_count_changed", matchingCount: matching.length });
    expect(await reviewedByKey()).toEqual(before);

    const ok = await request("POST", "/transactions/bulk-review-matching", { filter, reviewed: true, expectedCount: matching.length });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const result = BulkReviewMatchingTransactionsResponse.parse(ok.json);
    expect(result.matched).toBe(7);
    expect(result.updated).toBe(7);
    expect(new Set(result.updatedIds)).toEqual(new Set(matching.map((s) => rowOf.get(s.key)!.id)));

    // Row by row: only those seven changed. A, its twin, the manual, Amex,
    // PayPal and card rows, and B's row dated after today, are untouched.
    const after = await reviewedByKey();
    const expected = new Map(H_ROWS.map((s) => [s.key, !!s.reviewed || matching.some((m) => m.key === s.key)]));
    expect(after).toEqual(expected);
    for (const key of ["a1", "a2", "a3", "at1", "m1", "m2", "x1", "x2", "p1", "cc1", "b7"]) {
      expect(after.get(key), key).toBe(false);
    }

    const bAfter = await ledger(`account=${B.rowId}&limit=1`);
    expect(bAfter.review).toEqual({ reviewed: 8, unreviewed: 1 });
    expect(bAfter.totals).toEqual(totalsOf(H_ROWS.filter(B_SCOPE), B_NOT_COUNTED));
    expect(await ledger("limit=100")).toEqual(aBefore);
  });
});

describe("no snapshot", () => {
  it("the resolved account's ledger says no_snapshot with every balance null; another Chase account there says not_snapshot_account", async () => {
    actingUser = NOSNAP_USER;
    try {
      const byDefault = await ledger("limit=100");
      expect(new Set((byDefault.rows as unknown as Row[]).map((r) => r.id))).toEqual(new Set([nosnapIds.get("n1"), nosnapIds.get("n2")]));
      expect(byDefault.balanceUnavailableReason).toBe("no_snapshot");
      expect(byDefault.balanceStart).toBeNull();
      expect(byDefault.balanceEnd).toBeNull();
      expect(byDefault.balanceToday).toBeNull();
      expect(byDefault.anchor.todayBalance).toBeNull();
      expect(byDefault.account.plaidAccountIds).toEqual([accountRow.get("NS_CHK")!.externalId]);
      for (const r of byDefault.rows as unknown as Row[]) {
        expect(r.runningBalance).toBeNull();
        // As before PR14: the snapshot's ledger still gives what each row moves.
        expect(r.balanceAmount).toBe(r.amount);
      }
      expect(byDefault.totals).toEqual({ count: 2, moneyIn: "0.00", moneyOut: "15.00", net: "-15.00" });
      expect(await ledger(`account=${accountRow.get("NS_CHK")!.rowId}&limit=100`)).toEqual(byDefault);

      const b = await get(`/transactions/balances?dates=${TODAY}`);
      expect(b.status).toBe(200);
      const body = GetTransactionsBalancesResponse.parse(b.json);
      expect(body.balances).toEqual([{ date: TODAY, balance: null }]);
      expect(body.balanceUnavailableReason).toBe("no_snapshot");

      const savings = await ledger(`account=${accountRow.get("NS_SAV")!.rowId}&limit=100`);
      expect((savings.rows as unknown as Row[]).map((r) => [r.id, r.balanceAmount, r.runningBalance])).toEqual([[nosnapIds.get("n3"), null, null]]);
      expect(savings.totals).toEqual({ count: 1, moneyIn: "8.00", moneyOut: "0.00", net: "8.00" });
      expect(savings.balanceUnavailableReason).toBe("not_snapshot_account");
      const savingsBalances = await get(`/transactions/balances?account=${accountRow.get("NS_SAV")!.rowId}&dates=${TODAY}`);
      expect((savingsBalances.json as { balanceUnavailableReason: unknown }).balanceUnavailableReason).toBe("not_snapshot_account");
    } finally {
      actingUser = H_USER;
    }
  });
});

describe("uncategorized rule (PR7)", () => {
  it("uncategorized=true lists rows with no category, a deleted category or another household's category, not a live one; counts, totals and review include them; each row is listed once without the filter", async () => {
    actingUser = CAT_USER;
    try {
      const uncategorized = ["none", "deleted", "neverExisted", "foreign"].map((k) => catIds.get(k)!);
      const page = await ledger("uncategorized=true&limit=100");
      expect(new Set((page.rows as unknown as Row[]).map((r) => r.id))).toEqual(new Set(uncategorized));
      expect((page.rows as unknown as Row[]).some((r) => r.id === catIds.get("live"))).toBe(false);
      expect(page.matchingCount).toBe(4);
      // In 40.00 (neverExisted); out 10.00 + 30.00 + 50.00.
      expect(page.totals).toEqual({ count: 4, moneyIn: "40.00", moneyOut: "90.00", net: "-50.00" });
      expect(page.review).toEqual({ reviewed: 1, unreviewed: 3 });
      expect((await ledger("uncategorized=true&reviewed=false&limit=100")).matchingCount).toBe(3);

      const all = await ledger("limit=100");
      const ids = (all.rows as unknown as Row[]).map((r) => r.id);
      expect(ids).toHaveLength(5);
      expect(new Set(ids)).toEqual(new Set(catIds.values()));
      expect(all.totals).toEqual({ count: 5, moneyIn: "40.00", moneyOut: "110.00", net: "-70.00" });
    } finally {
      actingUser = H_USER;
    }
  });

  it("bulk review by uncategorized=true marks the deleted-category rows with the right count, and never the live-category row", async () => {
    actingUser = CAT_USER;
    try {
      const reviewed = async () =>
        new Map(
          (
            await db
              .select({ id: transactionsTable.id, reviewed: transactionsTable.reviewed })
              .from(transactionsTable)
              .where(inArray(transactionsTable.id, [...catIds.values()]))
          ).map((r) => [r.id, r.reviewed]),
        );
      const before = await reviewed();
      const filter = { uncategorized: true, reviewed: false };
      const stale = await request("POST", "/transactions/bulk-review-matching", { filter, reviewed: true, expectedCount: 2 });
      expect(stale.status).toBe(409);
      expect(stale.json).toMatchObject({ code: "matching_count_changed", matchingCount: 3 });
      expect(await reviewed()).toEqual(before);

      const ok = await request("POST", "/transactions/bulk-review-matching", { filter, reviewed: true, expectedCount: 3 });
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      const result = BulkReviewMatchingTransactionsResponse.parse(ok.json);
      expect(result.matched).toBe(3);
      expect(new Set(result.updatedIds)).toEqual(new Set(["none", "deleted", "foreign"].map((k) => catIds.get(k)!)));
      const after = await reviewed();
      expect(after.get(catIds.get("deleted")!)).toBe(true);
      expect(after.get(catIds.get("foreign")!)).toBe(true);
      expect(after.get(catIds.get("none")!)).toBe(true);
      expect(after.get(catIds.get("neverExisted")!)).toBe(true);
      expect(after.get(catIds.get("live")!)).toBe(false);
    } finally {
      actingUser = H_USER;
    }
  });
});
