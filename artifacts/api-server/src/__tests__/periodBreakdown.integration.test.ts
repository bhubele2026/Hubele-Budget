// ⭐ (S3) GET /money/period-breakdown — "Why are we over weekly and monthly?"
// Synthetic households, every figure worked by hand. All names, amounts and
// account numbers are made up.
//
// Pinned now: Wed 2026-10-07 12:00 Central. The household week is Sun 10/4 –
// Sat 10/10; the month is October.
//
// Household A — weekly plan $300, monthly plan $400 (both from 2026-05-01).
//   Accounts: Chase Checking ••5526 · Amex Platinum ••1001 · Amex Blue ••2002.
//   This week (the weekly cap's pool: weekly-flagged + unfiled):
//     Plat 10/5  HEB GROCERY        −96.60  weekly · Groceries
//     Plat 10/5  QT FUEL            −45.00  weekly · Gas
//     Plat 10/6  HEB GROCERY REFUND +20.00  weekly · Groceries   (a refund: nets −20)
//     Blue 10/6  TARGET            −130.00  weekly, split Groceries 80 / Home 50
//     Chase 10/6 SHELL OIL 57442    −45.00  PENDING, weekly · Gas
//     Chase 10/7 SHELL OIL 57442    −47.40  posted (replaces the pending row; carries its flag)
//     Plat 10/7  TACO SHOP           −25.50  no flag · Dining      (unfiled: counts)
//   Beside it (never in the week's figure):
//     Plat 10/6  HOME DEPOT          −85.00  unplanned
//     Plat 10/7  SHOE STORE          −30.00  monthly · Home
//     Chase 10/5 Online Transfer to SAV −200.00  transfer
//     Chase 10/6 AMERICAN EXPRESS ACH PMT −180.00  the card payment
//   Week: Groceries 96.60 − 20 + 80 = 156.60 (3 rows) · Gas 45 + 47.40 = 92.40 (2) ·
//         Home 50.00 (1, a split part) · unfiled 25.50 (Dining)
//         actual 324.50 = 156.60 + 92.40 + 50 + 25.50, no floor;
//         remaining 300 − 324.50 = −24.50 → over 24.50.
//   Usual Groceries: prior weeks 8/9 0 · 8/16 40 · 8/23 0 · 8/30 55 · 9/6 0 ·
//         9/13 60 · 9/20 70 · 9/27 50 → median floor((40+50)/2) = 45.00;
//         above usual 156.60 − 45 = 111.60.
//   Month (monthly-flagged): Plat 10/1 COSTCO −150 Home · Blue 10/2 IKEA −200 Home ·
//         Chase 10/3 CITY PHARMACY −60 Health · Plat 10/7 SHOE STORE −30 Home
//         → Home 380 · Health 60 · actual 440 → over the $400 plan by 40.
//         Usual Home: Jul 0 · Aug 300 · Sep 100 → 100; Health: 0, 0, 0 → 0.
//         (F3) October is still running (today the 7th), so usual reads each prior
//         month only through its 7th: Home Jul 0 · Aug 0 (the 300 is on the 12th) ·
//         Sep 0 (the 100 is on the 10th) → 0, above usual 380; a full month
//         usually 100 (usualFullPeriod). The week's Groceries rows all fall on a
//         Sunday or Monday, so read to Wednesday the usual is still 45.
//
// Household B — nothing: no plan, no rows (and must see nothing of A's).
// Household C — a $300 weekly plan and no rows: a quiet week reads "0.00".
// Household D — the clock: Sat 10/31 23:30 CT (Sun 11/1 04:30 UTC) rows and
//   Sun 11/1 rows across the week AND month boundary.
// Household E — a refund larger than the card's purchases: the floor is said.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq, inArray } from "drizzle-orm";

const tag = `${process.pid}-${randomUUID().slice(0, 8)}`;
const A = `pb-a-${tag}`;
const B = `pb-b-${tag}`;
const C = `pb-c-${tag}`;
const D = `pb-d-${tag}`;
const E = `pb-e-${tag}`;
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
    const who = String(req.headers["x-test-user"] ?? A);
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
  allowancePlansTable,
  budgetCategoriesTable,
  forecastSettingsTable,
  merchantAliasesTable,
  planAdjustmentsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  transactionSplitsTable,
  transactionsTable,
} from "@workspace/db";
import { GetPeriodBreakdownResponse } from "@workspace/api-zod";
import moneyRouter from "../routes/money";
import spineRouter from "../routes/spine";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";
import { loadHookPayoffs, readHookSettings } from "../lib/everydayHooks";
import { computeCashSignalDetailed } from "../lib/cashSignal";
import { POSITION_HORIZON_DAYS, tier2PairedTxnIdsOf } from "../lib/moneyPosition";
import { merchantSignature } from "../lib/merchantNameExtract";

const NOW = new Date("2026-10-07T12:00:00-05:00");

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(moneyRouter);
app.use(spineRouter);

let server: Server;
let baseUrl: string;

async function call(path: string, as: string = A): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${baseUrl}${path}`, { headers: { "x-test-user": as } });
  return { status: r.status, body: await r.json() };
}
async function get<T>(path: string, as: string = A): Promise<T> {
  const r = await call(path, as);
  if (r.status !== 200) throw new Error(`GET ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as T;
}

type Row = {
  id: string;
  date: string;
  displayName: string;
  amount: string;
  account: { id: string | null; institution: string | null; name: string | null; mask: string | null };
  pending: boolean;
  category: { id: string; name: string } | null;
  reason: { coverage: string; nets: string | null; rule: string };
  splitPart: { index: number; count: number; parentAmount: string } | null;
};
type Breakdown = {
  period: string;
  basis: string;
  start: string;
  end: string;
  isCurrent: boolean;
  timezone: string;
  scope: { kind: string; id: string | null; institution: string | null; name: string | null; mask: string | null };
  planScope: string;
  plan: { status: string; amount: string | null; source: string; planId: string | null; effectiveFrom: string | null };
  carryOver: string | null;
  actual: string;
  remaining: string | null;
  over: string | null;
  withinPlan: boolean | null;
  categories: Array<{
    categoryId: string | null;
    name: string | null;
    amount: string;
    shareBp: number | null;
    count: number;
    usual: string | null;
    usualFullPeriod: string | null;
    aboveUsual: string | null;
    rows: Row[];
    truncated: boolean;
  }>;
  needsClassification: { amount: string; count: number; rows: Row[]; truncated: boolean; countsAgainstPlan: boolean };
  refundFloorAdjustment: string;
  usualBasis: string;
  usualThrough: string | null;
  beside: {
    unplanned: string;
    weekly: string | null;
    monthly: string | null;
    billMatched: string;
    reimbursable: string;
    householdSpend: string | null;
  };
  limitations: string[];
};
type Position = {
  spentWeekDiscretionary: string;
  remainingWeek: string | null;
  withinPlan: string | null;
  weekCap: string | null;
  unplannedWeek: string;
  monthlyWeek: string;
  needsClassificationWeek: string;
  weekAdjustment: { amount: string } | null;
};
type Spine = {
  spentWeek: number;
  position: { remainingWeek: string | null; withinPlan: string | null };
  monthAllowance: { plan: string | null; actual: string; status: string; remaining: string | null; over: string | null };
};

const cents = (v: string | null): number => Math.round(Number(v) * 100);
/** Σ categories + needsClassification + floor, in cents. */
const groupsPlusFloor = (b: Breakdown): number =>
  b.categories.reduce((a, c) => a + cents(c.amount), 0) + cents(b.needsClassification.amount) + cents(b.refundFloorAdjustment);
const allRows = (b: Breakdown): Row[] => [...b.categories.flatMap((c) => c.rows), ...b.needsClassification.rows];

const ids: Record<string, string> = {};
const acct: Record<string, { rowId: string; ext: string }> = {};
const cat: Record<string, string> = {};

async function cleanup(): Promise<void> {
  const users = [A, B, C, D, E];
  const hhIds = Object.values(HH).map((h) => h.householdId);
  if (hhIds.length) {
    await db.delete(transactionSplitsTable).where(inArray(transactionSplitsTable.householdId, hhIds));
    await db.delete(allowancePlansTable).where(inArray(allowancePlansTable.householdId, hhIds));
    await db.delete(planAdjustmentsTable).where(inArray(planAdjustmentsTable.householdId, hhIds));
    await db.delete(merchantAliasesTable).where(inArray(merchantAliasesTable.householdId, hhIds));
  }
  await db.delete(transactionsTable).where(inArray(transactionsTable.userId, users));
  await db.delete(recurringItemsTable).where(inArray(recurringItemsTable.userId, users));
  await db.delete(budgetCategoriesTable).where(inArray(budgetCategoriesTable.userId, users));
  await db.delete(forecastSettingsTable).where(inArray(forecastSettingsTable.userId, users));
  await db.delete(plaidAccountsTable).where(inArray(plaidAccountsTable.userId, users));
  await db.delete(plaidItemsTable).where(inArray(plaidItemsTable.userId, users));
}

type TxnSpec = {
  key?: string;
  on: string;
  desc: string;
  amount: string;
  account: string;
  category?: string;
  weekly?: boolean;
  monthly?: boolean;
  unplanned?: boolean;
  transfer?: boolean;
  pending?: boolean;
  occurredAt?: string;
};

async function seedTxns(user: string, rows: TxnSpec[]): Promise<void> {
  const hh = HH[user]!.householdId;
  for (const r of rows) {
    const a = acct[r.account]!;
    const [t] = await db
      .insert(transactionsTable)
      .values({
        userId: user,
        householdId: hh,
        occurredOn: r.on,
        occurredAt: r.occurredAt ?? null,
        createdAt: createdAtStartOfHouseholdDay(r.on),
        description: r.desc,
        amount: r.amount,
        plaidAccountId: a.ext,
        source: r.account.includes("chase") ? "plaid:chase" : "plaid:amex",
        categoryId: r.category ? cat[r.category]! : null,
        weeklyAllowance: r.weekly ?? false,
        monthlyAllowance: r.monthly ?? false,
        unplannedAllowance: r.unplanned ?? false,
        isTransfer: r.transfer ?? false,
        pending: r.pending ?? false,
      })
      .returning({ id: transactionsTable.id });
    if (r.key) ids[r.key] = t!.id;
  }
}

async function seedAccount(user: string, key: string, inst: string, name: string, mask: string, type: string, subtype: string): Promise<string> {
  const hh = HH[user]!.householdId;
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ userId: user, householdId: hh, itemId: `item-${randomUUID()}`, accessToken: "t", institutionSlug: inst.toLowerCase().includes("chase") ? "chase" : "amex", institutionName: inst })
    .returning();
  const ext = `${key}-${randomUUID().slice(0, 8)}`;
  const [row] = await db
    .insert(plaidAccountsTable)
    .values({ userId: user, householdId: hh, itemId: item!.id, accountId: ext, name, mask, type, subtype })
    .returning();
  acct[key] = { rowId: row!.id, ext };
  return row!.id;
}

async function seedCategories(user: string, names: string[]): Promise<void> {
  const hh = HH[user]!.householdId;
  for (const n of names) {
    const [c] = await db
      .insert(budgetCategoriesTable)
      .values({ userId: user, householdId: hh, name: `${n} ${tag.slice(-4)}`, kind: "expense", groupName: "Everyday" })
      .returning();
    cat[`${user}:${n}`] = c!.id;
    if (user === A) cat[n] = c!.id;
  }
}

async function seedPlans(user: string, weekly: string | null, monthly: string | null): Promise<void> {
  const hh = HH[user]!.householdId;
  const rows = [
    ...(weekly ? [{ householdId: hh, memberUserId: null, period: "weekly", amount: weekly, effectiveFrom: "2026-05-01", source: "owner" }] : []),
    ...(monthly ? [{ householdId: hh, memberUserId: null, period: "monthly", amount: monthly, effectiveFrom: "2026-05-01", source: "owner" }] : []),
  ];
  if (rows.length) await db.insert(allowancePlansTable).values(rows);
}

beforeAll(async () => {
  vi.setSystemTime(NOW);
  for (const u of [A, B, C, D, E]) HH[u] = await createTestHousehold(u);
  await cleanup();

  // ── Household A
  const chaseRow = await seedAccount(A, "chase", "Chase", "Chase Checking", "5526", "depository", "checking");
  await seedAccount(A, "plat", "American Express", "Amex Platinum", "1001", "credit", "credit card");
  await seedAccount(A, "blue", "American Express", "Amex Blue", "2002", "credit", "credit card");
  await db.insert(forecastSettingsTable).values({
    userId: A,
    householdId: HH[A]!.householdId,
    daysAhead: 90,
    cashBuffer: "500.00",
    bankSnapshotBalance: "3000.00",
    bankSnapshotAt: new Date("2026-10-04T08:00:00-05:00"),
    bankSnapshotSource: "manual",
    bankSnapshotAccountId: chaseRow,
  });
  await seedCategories(A, ["Groceries", "Gas", "Home", "Dining", "Health"]);
  await seedPlans(A, "300.00", "400.00");
  await seedTxns(A, [
    // This week
    { key: "heb", on: "2026-10-05", desc: "HEB GROCERY", amount: "-96.60", account: "plat", category: "Groceries", weekly: true },
    { key: "qt", on: "2026-10-05", desc: "QT FUEL", amount: "-45.00", account: "plat", category: "Gas", weekly: true },
    { key: "hebRefund", on: "2026-10-06", desc: "HEB GROCERY REFUND", amount: "20.00", account: "plat", category: "Groceries", weekly: true },
    { key: "target", on: "2026-10-06", desc: "TARGET", amount: "-130.00", account: "blue", category: "Groceries", weekly: true },
    { key: "shellPending", on: "2026-10-06", desc: "SHELL OIL 57442", amount: "-45.00", account: "chase", category: "Gas", weekly: true, pending: true },
    { key: "shellPosted", on: "2026-10-07", desc: "SHELL OIL 57442", amount: "-47.40", account: "chase" },
    { key: "taco", on: "2026-10-07", desc: "TACO SHOP 22", amount: "-25.50", account: "plat", category: "Dining" },
    { key: "homeDepot", on: "2026-10-06", desc: "HOME DEPOT", amount: "-85.00", account: "plat", category: "Home", unplanned: true },
    { key: "shoes", on: "2026-10-07", desc: "SHOE STORE", amount: "-30.00", account: "plat", category: "Home", monthly: true },
    { key: "toSavings", on: "2026-10-05", desc: "Online Transfer to SAV ...8801", amount: "-200.00", account: "chase", transfer: true },
    { key: "amexPayment", on: "2026-10-06", desc: "AMERICAN EXPRESS ACH PMT", amount: "-180.00", account: "chase" },
    // Earlier in October (monthly)
    { key: "costco", on: "2026-10-01", desc: "COSTCO WHSE", amount: "-150.00", account: "plat", category: "Home", monthly: true },
    { key: "ikea", on: "2026-10-02", desc: "IKEA", amount: "-200.00", account: "blue", category: "Home", monthly: true },
    { key: "pharmacy", on: "2026-10-03", desc: "CITY PHARMACY", amount: "-60.00", account: "chase", category: "Health", monthly: true },
    // Prior weeks (Groceries, weekly) and prior months (Home, monthly)
    { on: "2026-08-16", desc: "HEB GROCERY", amount: "-40.00", account: "plat", category: "Groceries", weekly: true },
    { on: "2026-08-30", desc: "HEB GROCERY", amount: "-55.00", account: "plat", category: "Groceries", weekly: true },
    { on: "2026-09-14", desc: "HEB GROCERY", amount: "-60.00", account: "plat", category: "Groceries", weekly: true },
    { on: "2026-09-21", desc: "HEB GROCERY", amount: "-70.00", account: "plat", category: "Groceries", weekly: true },
    { key: "lastWeekHeb", on: "2026-09-28", desc: "HEB GROCERY", amount: "-50.00", account: "plat", category: "Groceries", weekly: true },
    { on: "2026-08-12", desc: "FURNITURE MART", amount: "-300.00", account: "blue", category: "Home", monthly: true },
    { on: "2026-09-10", desc: "FURNITURE MART", amount: "-100.00", account: "blue", category: "Home", monthly: true },
  ]);
  await db.insert(transactionSplitsTable).values([
    { householdId: HH[A]!.householdId, transactionId: ids.target!, categoryId: cat.Groceries!, amount: "-80.00", userId: A },
    { householdId: HH[A]!.householdId, transactionId: ids.target!, categoryId: cat.Home!, amount: "-50.00", userId: A },
  ]);
  await db.insert(merchantAliasesTable).values({ householdId: HH[A]!.householdId, userId: A, signature: merchantSignature("HEB GROCERY"), alias: "H-E-B" });

  // ── Household C: a plan, no rows.
  await seedPlans(C, "300.00", null);

  // ── Household D: the clock.
  await seedAccount(D, "dplat", "American Express", "Amex Gold", "3003", "credit", "credit card");
  await seedCategories(D, ["Dining", "Books"]);
  await seedPlans(D, "100.00", "200.00");
  await seedTxns(D, [
    // Sat 10/31 23:30 Central is Sun 11/1 04:30 UTC: the household's Saturday.
    { key: "lateDiner", on: "2026-10-31", occurredAt: "2026-11-01T04:30:00Z", desc: "LATE NIGHT DINER", amount: "-40.00", account: "dplat", category: `${D}:Dining`, weekly: true },
    { key: "lateBooks", on: "2026-10-31", occurredAt: "2026-11-01T04:30:00Z", desc: "BOOKSHOP", amount: "-70.00", account: "dplat", category: `${D}:Books`, monthly: true },
    { key: "sunMarket", on: "2026-11-01", desc: "SUNDAY MARKET", amount: "-30.00", account: "dplat", category: `${D}:Books`, monthly: true },
    { key: "sunCoffee", on: "2026-11-01", desc: "COFFEE CART", amount: "-12.00", account: "dplat", category: `${D}:Dining`, weekly: true },
  ]);

  // ── Household E: refunds beyond purchases on the card.
  await seedAccount(E, "eplat", "American Express", "Amex Green", "4004", "credit", "credit card");
  await seedAccount(E, "echase", "Chase", "Chase Checking", "6606", "depository", "checking");
  await seedCategories(E, ["Groceries", "Gas"]);
  await seedPlans(E, "200.00", null);
  await seedTxns(E, [
    { on: "2026-10-05", desc: "GREEN GROCER", amount: "-20.00", account: "eplat", category: `${E}:Groceries`, weekly: true },
    { on: "2026-10-06", desc: "GREEN GROCER REFUND", amount: "60.00", account: "eplat", category: `${E}:Groceries`, weekly: true },
    { on: "2026-10-06", desc: "CORNER FUEL", amount: "-30.00", account: "echase", category: `${E}:Gas`, weekly: true },
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
});

const WEEK = "/money/period-breakdown?period=week&start=2026-10-04";
const MONTH = "/money/period-breakdown?period=month&start=2026-10-01";

describe("this week — household A, worked by hand", () => {
  it("plan, actual, over, and every group to the cent; the response matches the spec", async () => {
    const b = await get<Breakdown>(WEEK);
    // For the review note: S3_PRINT_SAMPLE=<file> writes this response (and the month's) there.
    if (process.env.S3_PRINT_SAMPLE) {
      writeFileSync(process.env.S3_PRINT_SAMPLE, JSON.stringify({ week: b, month: await get<Breakdown>(MONTH) }, null, 2));
    }
    expect(() => GetPeriodBreakdownResponse.parse(b)).not.toThrow();
    expect(b).toMatchObject({
      period: "week",
      basis: "weekly_allowance",
      start: "2026-10-04",
      end: "2026-10-10",
      isCurrent: true,
      timezone: "America/Chicago",
      scope: { kind: "household", id: null },
      planScope: "household",
      plan: { status: "set", amount: "300.00", source: "plan", effectiveFrom: "2026-05-01" },
      carryOver: null,
      actual: "324.50",
      remaining: "-24.50",
      over: "24.50",
      withinPlan: false,
      refundFloorAdjustment: "0.00",
      limitations: [],
    });
    expect(b.plan.planId).toEqual(expect.any(String));
    expect(b.categories.map((c) => [c.name?.split(" ")[0], c.amount, c.count])).toEqual([
      ["Groceries", "156.60", 3],
      ["Gas", "92.40", 2],
      ["Home", "50.00", 1],
    ]);
    expect(b.categories[0]!.shareBp).toBe(Math.round((15660 * 10000) / 32450));
    expect(b.needsClassification).toMatchObject({ amount: "25.50", count: 1, truncated: false, countsAgainstPlan: true });
    expect(b.needsClassification.rows[0]).toMatchObject({ id: ids.taco, category: { id: cat.Dining }, reason: { coverage: "needs_classification", rule: "unfiled" } });
    // ⭐ Σ groups + floor = actual, to the cent.
    expect(groupsPlusFloor(b)).toBe(cents(b.actual));
    expect(b.beside).toEqual({
      unplanned: "85.00",
      weekly: null,
      monthly: "30.00",
      billMatched: "0.00",
      reimbursable: "0.00",
      householdSpend: expect.any(String),
    });
  });

  it("rows: largest first, account identity with ••last4, the alias as the name, the rule that placed each", async () => {
    const b = await get<Breakdown>(WEEK);
    const groceries = b.categories[0]!;
    expect(groceries.rows.map((r) => [r.id, r.amount])).toEqual([
      [ids.heb, "96.60"],
      [ids.target, "80.00"],
      [ids.hebRefund, "-20.00"],
    ]);
    expect(groceries.rows[0]).toMatchObject({
      date: "2026-10-05",
      displayName: "H-E-B",
      account: { id: acct.plat!.rowId, institution: "American Express", name: "Amex Platinum", mask: "1001" },
      pending: false,
      reason: { coverage: "allowance_weekly", nets: null, rule: "weekly_flag" },
      splitPart: null,
    });
    // The refund nets its own category, signed, and says what it nets.
    expect(groceries.rows[2]).toMatchObject({ reason: { coverage: "refund", nets: "allowance_weekly", rule: "weekly_flag" } });
    for (const r of allRows(b)) {
      expect(r.account.mask, r.id).toMatch(/^\d{4}$/);
      expect(["weekly_flag", "unfiled"]).toContain(r.reason.rule);
    }
  });

  it("usual = the median of the 8 weeks before; above usual = how far past it", async () => {
    const b = await get<Breakdown>(WEEK);
    // (F3) The current week reads each prior week Sunday–Wednesday; every Groceries row is a Sunday or Monday.
    expect(b).toMatchObject({ usualBasis: "same_days", usualThrough: "2026-10-07" });
    expect(b.categories[0]).toMatchObject({ usual: "45.00", usualFullPeriod: "45.00", aboveUsual: "111.60" });
    // Gas and Home had no weekly rows before: usual 0 (a week with none counts), never null here.
    expect(b.categories[1]).toMatchObject({ usual: "0.00", usualFullPeriod: "0.00", aboveUsual: "92.40" });
  });

  it("⭐ actual === /money/position spent, remaining === position === spine; beside === position and spine", async () => {
    const [b, pos, spine] = await Promise.all([get<Breakdown>(WEEK), get<Position>("/money/position"), get<Spine>("/spine")]);
    expect(b.actual).toBe(pos.spentWeekDiscretionary);
    expect(b.remaining).toBe(pos.remainingWeek);
    expect(b.remaining).toBe(spine.position.remainingWeek);
    expect(pos.withinPlan).toBe("over");
    expect(spine.position.withinPlan).toBe("over");
    expect(b.plan.amount).toBe(pos.weekCap);
    expect(b.carryOver).toBeNull();
    expect(pos.weekAdjustment).toBeNull();
    expect(b.beside.unplanned).toBe(pos.unplannedWeek);
    expect(b.beside.monthly).toBe(pos.monthlyWeek);
    expect(b.needsClassification.amount).toBe(pos.needsClassificationWeek);
    expect(cents(b.beside.householdSpend)).toBe(Math.round(spine.spentWeek * 100));
  });

  it("pending→posted counts once (the posted 47.40, carrying the pending row's flag); the pending row never appears", async () => {
    const b = await get<Breakdown>(WEEK);
    const gas = b.categories.find((c) => c.categoryId === cat.Gas)!;
    expect(gas.rows.map((r) => [r.id, r.amount, r.pending])).toEqual([
      [ids.shellPosted, "47.40", false],
      [ids.qt, "45.00", false],
    ]);
    expect(gas.rows[0]!.account).toMatchObject({ name: "Chase Checking", mask: "5526" });
    expect(allRows(b).some((r) => r.id === ids.shellPending)).toBe(false);
  });

  it("a split row counts by its parts — they sum to the parent and keep its account; the parent never counts again", async () => {
    const b = await get<Breakdown>(WEEK);
    const parts = allRows(b).filter((r) => r.id === ids.target);
    // (Two parts written in one statement share a created_at; the loader then
    // orders them by id, so which is part 0 is not fixed.)
    expect(parts.map((r) => [r.category?.id, r.amount, r.splitPart?.count, r.splitPart?.parentAmount])).toEqual([
      [cat.Groceries, "80.00", 2, "130.00"],
      [cat.Home, "50.00", 2, "130.00"],
    ]);
    expect(parts.map((r) => r.splitPart!.index).sort()).toEqual([0, 1]);
    expect(parts.every((r) => r.account.mask === "2002" && r.reason.coverage === "allowance_weekly")).toBe(true);
    expect(parts.reduce((a, r) => a + cents(r.amount), 0)).toBe(13000);
  });

  it("an Amex purchase appears; the checking-side Amex payment, the transfer, unplanned and monthly rows never do", async () => {
    const b = await get<Breakdown>(WEEK);
    const shown = new Set(allRows(b).map((r) => r.id));
    expect(shown.has(ids.heb!)).toBe(true);
    for (const k of ["amexPayment", "toSavings", "homeDepot", "shoes"]) expect(shown.has(ids[k]!), k).toBe(false);
  });

  it("account= scoping: each account's contribution, the plan still the household's; Σ accounts === household actual", async () => {
    const household = await get<Breakdown>(WEEK);
    const each = await Promise.all(
      ["chase", "plat", "blue"].map((k) => get<Breakdown>(`${WEEK}&account=${acct[k]!.rowId}`)),
    );
    expect(each.map((x) => x.actual)).toEqual(["47.40", "147.10", "130.00"]);
    expect(each.reduce((a, x) => a + cents(x.actual), 0)).toBe(cents(household.actual));
    const plat = each[1]!;
    expect(plat.scope).toEqual({ kind: "account", id: acct.plat!.rowId, institution: "American Express", name: "Amex Platinum", mask: "1001" });
    expect(plat).toMatchObject({ planScope: "household", plan: { amount: "300.00" }, remaining: "152.90" });
    expect(plat.beside.householdSpend).toBeNull();
    expect(groupsPlusFloor(plat)).toBe(cents(plat.actual));
    expect(allRows(plat).every((r) => r.account.mask === "1001")).toBe(true);
  });

  it("a carry-over lowers what is left — the same figure the position quotes", async () => {
    await db.insert(planAdjustmentsTable).values({ householdId: HH[A]!.householdId, weekStart: "2026-10-04", amountCents: -4000, kind: "carry_over", reason: "test" });
    try {
      const [b, pos] = await Promise.all([get<Breakdown>(WEEK), get<Position>("/money/position")]);
      expect(b).toMatchObject({ carryOver: "-40.00", remaining: "-64.50", over: "64.50", withinPlan: false });
      expect(b.remaining).toBe(pos.remainingWeek);
      expect(b.carryOver).toBe(pos.weekAdjustment!.amount);
    } finally {
      await db.delete(planAdjustmentsTable).where(eq(planAdjustmentsTable.householdId, HH[A]!.householdId));
    }
  });

  it("rowsPerGroup caps the list and says so; the group's amount and count still cover every row", async () => {
    const b = await get<Breakdown>(`${WEEK}&rowsPerGroup=1`);
    expect(b.categories[0]).toMatchObject({ amount: "156.60", count: 3, truncated: true });
    expect(b.categories[0]!.rows.map((r) => r.id)).toEqual([ids.heb]);
    expect(b.actual).toBe("324.50");
  });

  it("a past week reads the same way: last week's groceries, not current", async () => {
    const b = await get<Breakdown>("/money/period-breakdown?period=week&start=2026-09-27");
    expect(b).toMatchObject({ isCurrent: false, start: "2026-09-27", end: "2026-10-03", actual: "50.00", remaining: "250.00", over: "0.00", withinPlan: true });
    // (F3) A past week: whole weeks against a whole week, as before.
    expect(b).toMatchObject({ usualBasis: "full_period", usualThrough: null });
    expect(b.categories[0]!.usual).toBe(b.categories[0]!.usualFullPeriod);
    expect(b.categories.map((c) => [c.categoryId, c.amount])).toEqual([[cat.Groceries, "50.00"]]);
    expect(b.categories[0]!.rows[0]!.id).toBe(ids.lastWeekHeb);
    expect(groupsPlusFloor(b)).toBe(cents(b.actual));
    // Before the first of last month the forecast's bill pairs are not known: said.
    const old = await get<Breakdown>("/money/period-breakdown?period=week&start=2026-08-30");
    expect(old.limitations).toContain("tier2_pairs_only_since:2026-09-01");
  });
});

describe("this month — the monthly allowance", () => {
  it("monthly-flagged spending by category, over the $400 plan; unfiled rows do not count against it", async () => {
    const b = await get<Breakdown>(MONTH);
    expect(() => GetPeriodBreakdownResponse.parse(b)).not.toThrow();
    expect(b).toMatchObject({
      period: "month",
      basis: "monthly_allowance",
      start: "2026-10-01",
      end: "2026-10-31",
      isCurrent: true,
      plan: { status: "set", amount: "400.00", source: "plan" },
      carryOver: null,
      actual: "440.00",
      remaining: "-40.00",
      over: "40.00",
      withinPlan: false,
      refundFloorAdjustment: "0.00",
    });
    // (F3) Deliberately changed: Home's usual was 100.00 (three FULL months against seven days of
    // October) and above usual 280.00. Read to the 7th of each month it is 0.00 and 380.00; the full
    // month's 100.00 is kept beside it.
    expect(b).toMatchObject({ usualBasis: "same_days", usualThrough: "2026-10-07" });
    expect(b.categories.map((c) => [c.categoryId, c.amount, c.count, c.usual, c.usualFullPeriod, c.aboveUsual])).toEqual([
      [cat.Home, "380.00", 3, "0.00", "100.00", "380.00"],
      [cat.Health, "60.00", 1, "0.00", "0.00", "60.00"],
    ]);
    expect(b.categories[0]!.rows.map((r) => r.id)).toEqual([ids.ikea, ids.costco, ids.shoes]);
    expect(b.needsClassification).toMatchObject({ amount: "0.00", count: 0, countsAgainstPlan: false });
    expect(b.beside.weekly).toBe("324.50");
    expect(b.beside.monthly).toBeNull();
    expect(groupsPlusFloor(b)).toBe(cents(b.actual));
  });

  it("⭐ actual === the figure the Monthly Spend hook sizes its reserve from (loadHookPayoffs), to the cent", async () => {
    const b = await get<Breakdown>(MONTH);
    const { householdId } = HH[A]!;
    const { ledger } = await computeCashSignalDetailed(householdId, A, { horizonDays: POSITION_HORIZON_DAYS });
    const payoffs = await loadHookPayoffs({
      householdId,
      ownerUserId: A,
      todayISO: "2026-10-07",
      settings: await readHookSettings(A),
      occurrences: [{ key: "monthly|2026-10-31", cadence: "monthly", occurrenceDate: "2026-10-31", storedCents: 0 }],
      tier2PairedTxnIds: tier2PairedTxnIdsOf(ledger),
    });
    const hook = payoffs.get("monthly|2026-10-31")!;
    expect(hook.fromStoredAmount).toBe(false);
    expect(hook.spentCents).toBe(cents(b.actual));
    expect(hook.remainingCents).toBe(0); // over the plan: nothing left to reserve
  });

  it("⭐ spine.monthAllowance === the endpoint's plan, actual, remaining and over, with its status", async () => {
    const [b, spine] = await Promise.all([get<Breakdown>(MONTH), get<Spine>("/spine")]);
    expect(spine.monthAllowance).toEqual({ plan: b.plan.amount, actual: b.actual, status: "over", remaining: b.remaining, over: b.over });
    expect(spine.monthAllowance).toEqual({ plan: "400.00", actual: "440.00", status: "over", remaining: "-40.00", over: "40.00" });
  });
});

describe("not set is never $0", () => {
  it("no plan rows: not_set, every plan figure null, the actual a real 0.00", async () => {
    for (const path of [WEEK, MONTH]) {
      const b = await get<Breakdown>(path, B);
      expect(b).toMatchObject({
        plan: { status: "not_set", amount: null, source: "none", planId: null, effectiveFrom: null },
        actual: "0.00",
        remaining: null,
        over: null,
        withinPlan: null,
        categories: [],
      });
      expect(JSON.stringify(b)).not.toMatch(/324\.50|440\.00|Amex Platinum|H-E-B/);
    }
    const spine = await get<Spine>("/spine", B);
    expect(spine.monthAllowance).toEqual({ plan: null, actual: "0.00", status: "not_set", remaining: null, over: null });
  });

  it("a plan and a quiet week: actual 0.00, the whole plan left", async () => {
    const b = await get<Breakdown>(WEEK, C);
    expect(b).toMatchObject({ plan: { status: "set", amount: "300.00" }, actual: "0.00", remaining: "300.00", over: "0.00", withinPlan: true, categories: [] });
    expect(b.needsClassification).toMatchObject({ amount: "0.00", count: 0, rows: [] });
  });
});

describe("the clock — household D (America/Chicago)", () => {
  const dWeek = (start: string) => `/money/period-breakdown?period=week&start=${start}`;
  const dMonth = (start: string) => `/money/period-breakdown?period=month&start=${start}`;

  it("Sat 23:30 Central (Sun 04:30 UTC): the purchase stays in the old week and the old month", async () => {
    vi.setSystemTime(new Date("2026-11-01T04:45:00Z")); // Sat 10/31 23:45 CT
    try {
      const wk = await get<Breakdown>(dWeek("2026-10-25"), D);
      expect(wk).toMatchObject({ isCurrent: true, actual: "40.00", remaining: "60.00" });
      expect(allRows(wk).map((r) => r.id)).toEqual([ids.lateDiner]);
      const mo = await get<Breakdown>(dMonth("2026-10-01"), D);
      expect(mo).toMatchObject({ isCurrent: true, actual: "70.00" });
      // UTC says November; the household does not: the new week and month are the future.
      for (const path of [dWeek("2026-11-01"), dMonth("2026-11-01")]) {
        const r = await call(path, D);
        expect(r.status, path).toBe(400);
        expect(r.body).toEqual({ error: "start_in_future" });
      }
    } finally {
      vi.setSystemTime(NOW);
    }
  });

  it("Oct 31 → Nov 1: each row in its own week and month, read the next day", async () => {
    vi.setSystemTime(new Date("2026-11-02T18:00:00Z")); // Mon 11/2 12:00 CT
    try {
      const [oldWeek, newWeek, oct, nov] = await Promise.all([
        get<Breakdown>(dWeek("2026-10-25"), D),
        get<Breakdown>(dWeek("2026-11-01"), D),
        get<Breakdown>(dMonth("2026-10-01"), D),
        get<Breakdown>(dMonth("2026-11-01"), D),
      ]);
      expect([oldWeek.isCurrent, oldWeek.actual, allRows(oldWeek).map((r) => r.id)]).toEqual([false, "40.00", [ids.lateDiner]]);
      expect([newWeek.isCurrent, newWeek.actual, allRows(newWeek).map((r) => r.id)]).toEqual([true, "12.00", [ids.sunCoffee]]);
      expect([oct.isCurrent, oct.actual, allRows(oct).map((r) => r.id)]).toEqual([false, "70.00", [ids.lateBooks]]);
      expect([nov.isCurrent, nov.actual, allRows(nov).map((r) => r.id)]).toEqual([true, "30.00", [ids.sunMarket]]);
      const pos = await get<Position>("/money/position", D);
      expect(newWeek.actual).toBe(pos.spentWeekDiscretionary);
      const spine = await get<Spine>("/spine", D);
      expect(spine.monthAllowance).toEqual({ plan: "200.00", actual: "30.00", status: "within", remaining: "170.00", over: "0.00" });
    } finally {
      vi.setSystemTime(NOW);
    }
  });
});

describe("the refund floor — household E", () => {
  it("a card refunded beyond its purchases floors at 0; the floor is said, and Σ groups + floor = actual", async () => {
    const b = await get<Breakdown>(WEEK, E);
    // Card: 20 − 60 = −40 → 0. Checking: 30. actual 30.
    expect(b.actual).toBe("30.00");
    expect(b.categories.map((c) => [c.categoryId, c.amount])).toEqual([
      [cat[`${E}:Gas`], "30.00"],
      [cat[`${E}:Groceries`], "-40.00"],
    ]);
    expect(b.refundFloorAdjustment).toBe("40.00");
    expect(groupsPlusFloor(b)).toBe(cents(b.actual));
    const pos = await get<Position>("/money/position", E);
    expect(b.actual).toBe(pos.spentWeekDiscretionary);
  });
});

describe("refused requests", () => {
  const bad: Array<[string, number, string]> = [
    ["/money/period-breakdown?period=week&start=2026-10-05", 400, "start_not_a_sunday"],
    ["/money/period-breakdown?period=month&start=2026-10-02", 400, "start_not_first_of_month"],
    ["/money/period-breakdown?period=week&start=2026-10-11", 400, "start_in_future"],
    ["/money/period-breakdown?period=month&start=2026-11-01", 400, "start_in_future"],
    ["/money/period-breakdown?period=week&start=2026-04-19", 400, "before_tracking_start"],
    [`${WEEK}&account=not-a-uuid`, 400, "invalid_account"],
    [`${WEEK}&account=${randomUUID()}`, 404, "account_not_found"],
    [`${WEEK}&rowsPerGroup=51`, 400, ""],
    [`${WEEK}&rowsPerGroup=1e1`, 400, "invalid_rows_per_group"],
  ];
  for (const [path, status, code] of bad) {
    it(`${path.replace("/money/period-breakdown?", "")} → ${status}`, async () => {
      const r = await call(path);
      expect(r.status).toBe(status);
      if (code) expect(r.body).toEqual({ error: code });
    });
  }

  it("another household's account is not found, and nothing of it is read", async () => {
    const r = await call(`${WEEK}&account=${acct.plat!.rowId}`, B);
    expect(r.status).toBe(404);
  });

  it("the week that holds the tracking start is read from that day on, and says so", async () => {
    const b = await get<Breakdown>("/money/period-breakdown?period=week&start=2026-04-26");
    expect(b.limitations).toContain("tracking_start:2026-05-01");
    expect(b.limitations).toContain("usual_periods:0");
    expect(b.categories.every((c) => c.usual === null)).toBe(true);
  });
});
