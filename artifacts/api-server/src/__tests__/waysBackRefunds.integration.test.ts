// ⭐ (S6 fix 3) The ways back net refunds the way the week's figure does.
//
// `GET /money/ways-back` names the categories to trim. The week's spent figure
// (`spentWeekDiscretionary`) nets a refund on its account, and the period
// breakdown's categories and `usual` net it too (`allowanceRowOf`: a refund in
// the coverage it nets, its credit negative). The trims summed the gross
// purchases instead, so a returned dinner still read as Dining spend. Now the
// trims read the same `allowanceRowOf` rows: their category amounts and usual
// weeks equal the breakdown's.
//
// Pinned now: Wed 2026-10-07 12:00 Central (week Sun 10/4 – Sat 10/10). Weekly
// cap $200. Every row on the Amex card (refunds there need no REFUND word).
// Synthetic data only.
//
//   this week   Dining  10/05 −150.00 weekly · 10/06 +50.00 weekly (returned)
//               Groceries 10/06 −120.00 (unfiled: counts against the cap)
//               Fun     10/07 −40.00 weekly
//   → the cap's pool 150 − 50 + 40 + 120 = 260.00; over by 60.00
//   Dining's 8 weeks before (weekly): 9/29 −100.00 and 9/30 +60.00 (week of 9/27: 40.00),
//               9/22 −80.00, 9/15 −120.00, 9/8 −90.00, 9/1 −70.00
//
//   trims   before: Dining 150.00 (usual 75.00), Groceries 120.00, Fun 40.00
//           after:  Groceries 120.00, Dining 100.00 (usual 55.00), Fun 40.00

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq, inArray } from "drizzle-orm";

const OWNER = `s6-ways-back-${process.pid}-${randomUUID().slice(0, 8)}`;
let HH = "";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = OWNER;
    req.actualUserId = OWNER;
    req.householdId = HH;
    req.householdOwnerId = OWNER;
    next();
  },
}));

vi.mock("../lib/plaid", async () => {
  const actual = await vi.importActual<typeof import("../lib/plaid")>("../lib/plaid");
  return {
    ...actual,
    plaid: () => {
      throw new Error("no Plaid calls in this test");
    },
  };
});

import {
  db,
  allowancePlansTable,
  budgetCategoriesTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import moneyRouter from "../routes/money";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const NOW = new Date("2026-10-07T12:00:00-05:00");
const AMEX = `acct-amex-${randomUUID()}`;
let DINING = "";
let GROCERIES = "";
let FUN = "";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(moneyRouter);

let server: Server;
let baseUrl: string;

async function get<T = any>(p: string): Promise<T> {
  const r = await fetch(`${baseUrl}${p}`);
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

async function cleanup(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, OWNER));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, OWNER));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, OWNER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, OWNER));
  if (HH) await db.delete(allowancePlansTable).where(inArray(allowancePlansTable.householdId, [HH]));
}

beforeAll(async () => {
  vi.setSystemTime(NOW);
  HH = (await createTestHousehold(OWNER)).householdId;
  await cleanup();
  const base = { userId: OWNER, householdId: HH };
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ ...base, itemId: `item-${randomUUID()}`, accessToken: "test-token", institutionSlug: "chase" })
    .returning();
  const [chk] = await db
    .insert(plaidAccountsTable)
    .values({ ...base, itemId: item!.id, accountId: `acct-chk-${randomUUID()}`, name: "Chase Checking", type: "depository", subtype: "checking" })
    .returning();
  await db.insert(forecastSettingsTable).values({
    ...base,
    daysAhead: 90,
    cashBuffer: "500.00",
    bankSnapshotBalance: "3000.00",
    bankSnapshotAt: new Date("2026-10-04T08:00:00-05:00"),
    bankSnapshotSource: "manual",
    bankSnapshotAccountId: chk!.id,
  });
  const cat = async (name: string) =>
    (await db.insert(budgetCategoriesTable).values({ ...base, name: `${name} ${randomUUID().slice(0, 4)}`, kind: "expense", groupName: "Everyday" }).returning())[0]!.id;
  DINING = await cat("Dining");
  GROCERIES = await cat("Groceries");
  FUN = await cat("Fun");
  const card = (occurredOn: string, description: string, amount: string, categoryId: string, weekly = true) => ({
    ...base,
    occurredOn,
    createdAt: createdAtStartOfHouseholdDay(occurredOn),
    description,
    amount,
    plaidAccountId: AMEX,
    source: "plaid:amex",
    categoryId,
    weeklyAllowance: weekly,
  });
  await db.insert(transactionsTable).values([
    card("2026-10-05", "BISTRO", "-150.00", DINING),
    card("2026-10-06", "BISTRO", "50.00", DINING),
    card("2026-10-06", "GROCER", "-120.00", GROCERIES, false),
    card("2026-10-07", "ARCADE", "-40.00", FUN),
    card("2026-09-29", "BISTRO", "-100.00", DINING),
    card("2026-09-30", "BISTRO", "60.00", DINING),
    card("2026-09-22", "BISTRO", "-80.00", DINING),
    card("2026-09-15", "BISTRO", "-120.00", DINING),
    card("2026-09-08", "BISTRO", "-90.00", DINING),
    card("2026-09-01", "BISTRO", "-70.00", DINING),
  ]);
  await db.insert(allowancePlansTable).values({
    householdId: HH,
    memberUserId: null,
    period: "weekly",
    amount: "200.00",
    effectiveFrom: "2026-05-01",
    source: "owner",
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

describe("(S6 fix 3) GET /money/ways-back nets refunds like the week's figure", () => {
  it("the week: 260.00 counted against 200.00 — over by 60.00 (the refund already netted here)", async () => {
    const pos = await get("/money/position");
    expect([pos.weekCap, pos.spentWeekDiscretionary, pos.remainingWeek]).toEqual(["200.00", "260.00", "-60.00"]);
  });

  it("trims: Groceries 120.00, Dining 100.00 (was 150.00) with usual 55.00 (was 75.00), Fun 40.00", async () => {
    const w = await get("/money/ways-back");
    expect(w.overBy).toBe(6000);
    // (F3) Every history row is a Tuesday or a Wednesday: read to Wednesday, the usual is the whole week's.
    expect(w.trims).toEqual([
      { categoryId: GROCERIES, name: expect.stringMatching(/^Groceries/), spentWeek: 12000, usualWeek: 0, usualFullWeek: 0 },
      { categoryId: DINING, name: expect.stringMatching(/^Dining/), spentWeek: 10000, usualWeek: 5500, usualFullWeek: 5500 },
      { categoryId: FUN, name: expect.stringMatching(/^Fun/), spentWeek: 4000, usualWeek: 0, usualFullWeek: 0 },
    ]);
  });

  it("each weekly-filed trim equals the week's breakdown for that category: amount and usual, to the cent", async () => {
    const w = await get("/money/ways-back");
    const b = await get("/money/period-breakdown?period=week&start=2026-10-04");
    expect([b.usualBasis, b.usualThrough]).toEqual([w.usualBasis, w.usualThrough]);
    const byId = new Map(b.categories.map((c: { categoryId: string }) => [c.categoryId, c]));
    for (const id of [DINING, FUN]) {
      const trim = w.trims.find((t: { categoryId: string }) => t.categoryId === id);
      const cat = byId.get(id) as { amount: string; usual: string | null; usualFullPeriod: string | null };
      expect(Math.round(Number(cat.amount) * 100), id).toBe(trim.spentWeek);
      expect(cat.usual == null ? null : Math.round(Number(cat.usual) * 100), id).toBe(trim.usualWeek);
      // (F3) Both read the same cut (to today's weekday) and the same whole weeks.
      expect(cat.usualFullPeriod == null ? null : Math.round(Number(cat.usualFullPeriod) * 100), id).toBe(trim.usualFullWeek);
    }
  });
});
