// ⭐ (S6 fix 1) A return on ANY credit card nets its purchase — not only on Amex.
//
// Before S6 the refund rule (`classifyRefund`) called a credit "money back on a
// card" only on an Amex ledger source ("amex", "plaid:amex"), while every other
// card test in the app (`isCardLedgerRow`) reads the Plaid account's type. A
// return on a Chase card without the word REFUND therefore never offset its
// purchase, and spending read high. Now the refund rule asks the same card
// question; a payment to the card (its words, its Plaid category) still never
// nets.
//
// Pinned now: Wed 2026-10-07 12:00 Central (week Sun 10/4 – Sat 10/10; the
// month so far 10/1 – 10/7). Synthetic data only.
//
//   Chase Freedom ••1234 (a Plaid CREDIT account, source "plaid:chase"):
//     10/05 TARGET T-1234              −80.00  Groceries, weekly
//     10/06 TARGET T-1234              +30.00  Groceries, weekly  ← the return (no REFUND word)
//     10/06 Payment Thank You-Mobile  +200.00  a payment by its words: never nets
//     10/06 AUTOMATIC PAYMENT - THANK +100.00  Plaid LOAN_PAYMENTS: never nets
//   Chase Checking ••5526 (depository):
//     10/05 SHELL OIL 5741             −40.00  filed nowhere (counts against the cap)
//     10/06 KROGER #442                +12.00  a credit off a card, no REFUND word: never nets
//     10/06 Payment to Chase card …   −300.00  a card payment: not spending
//
//   household spend   before 80 + 40 = 120.00   after (80 − 30) + 40 = 90.00
//   the cap's pool    before 120.00             after 90.00  (cap 300 → 210.00 left)
//   Groceries         before 80.00              after 50.00

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq, inArray } from "drizzle-orm";

const OWNER = `s6-card-credit-${process.pid}-${randomUUID().slice(0, 8)}`;
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
import { allowanceRowOf, allowanceSpentCents } from "@workspace/avalanche-core";
import moneyRouter from "../routes/money";
import reportsRouter from "../routes/reports";
import spineRouter from "../routes/spine";
import { loadAllowanceWindow } from "../lib/moneyContext";
import { classifierSpendForRange } from "./_helpers/classifierSpend";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const NOW = new Date("2026-10-07T12:00:00-05:00");
const WEEK = { start: "2026-10-04", end: "2026-10-10" };
const CARD = `acct-freedom-${randomUUID()}`;
const CHECKING = `acct-chk-${randomUUID()}`;
let GROCERIES = "";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(moneyRouter);
app.use(reportsRouter);
app.use(spineRouter);

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
    .values({ ...base, itemId: `item-${randomUUID()}`, accessToken: "test-token", institutionName: "Chase", institutionSlug: "chase" })
    .returning();
  const [chk] = await db
    .insert(plaidAccountsTable)
    .values({ ...base, itemId: item!.id, accountId: CHECKING, name: "Chase Checking", mask: "5526", type: "depository", subtype: "checking" })
    .returning();
  await db
    .insert(plaidAccountsTable)
    .values({ ...base, itemId: item!.id, accountId: CARD, name: "Freedom", mask: "1234", type: "credit", subtype: "credit card" });
  await db.insert(forecastSettingsTable).values({
    ...base,
    daysAhead: 90,
    cashBuffer: "500.00",
    bankSnapshotBalance: "3000.00",
    bankSnapshotAt: new Date("2026-10-04T08:00:00-05:00"),
    bankSnapshotSource: "manual",
    bankSnapshotAccountId: chk!.id,
  });
  GROCERIES = (await db.insert(budgetCategoriesTable).values({ ...base, name: `Groceries ${randomUUID().slice(0, 4)}`, kind: "expense" }).returning())[0]!.id;
  const row = (
    plaidAccountId: string,
    occurredOn: string,
    description: string,
    amount: string,
    extra: Partial<typeof transactionsTable.$inferInsert> = {},
  ) => ({
    ...base,
    occurredOn,
    createdAt: createdAtStartOfHouseholdDay(occurredOn),
    description,
    amount,
    plaidAccountId,
    source: "plaid:chase",
    ...extra,
  });
  const target = { categoryId: GROCERIES, weeklyAllowance: true, pfcDetailed: "GENERAL_MERCHANDISE_SUPERSTORES" };
  await db.insert(transactionsTable).values([
    row(CARD, "2026-10-05", "TARGET T-1234", "-80.00", target),
    row(CARD, "2026-10-06", "TARGET T-1234", "30.00", target),
    row(CARD, "2026-10-06", "Payment Thank You-Mobile", "200.00"),
    row(CARD, "2026-10-06", "AUTOMATIC PAYMENT - THANK", "100.00", { pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" }),
    row(CHECKING, "2026-10-05", "SHELL OIL 5741", "-40.00"),
    row(CHECKING, "2026-10-06", "KROGER #442", "12.00"),
    row(CHECKING, "2026-10-06", "Payment to Chase card ending in 1234 10/06", "-300.00"),
  ]);
  await db.insert(allowancePlansTable).values({
    householdId: HH,
    memberUserId: null,
    period: "weekly",
    amount: "300.00",
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

describe("(S6 fix 1) a return on a non-Amex credit card nets its purchase", () => {
  it("spending facts: the card 80.00 − 30.00 = 50.00, checking 40.00 → 90.00 (was 120.00); payments and the checking credit never net", async () => {
    const f = await get(`/reports/spending-facts?from=${WEEK.start}&to=${WEEK.end}`);
    expect(f.householdSpend).toEqual({ total: 90, transactionCount: 2 });
    expect(f.refunds).toEqual({ total: 30, transactionCount: 1, fromCategories: 30 });
    expect(f.realSpend).toEqual({ total: 50, transactionCount: 1 });
    expect(f.byCategory.map((c: { categoryId: string; total: number }) => [c.categoryId, c.total])).toEqual([[GROCERIES, 50]]);
    expect(f.uncategorized.total).toBe(40);
    expect(f.excluded.cardPayments).toBe(300);
  });

  it("the household-money classifier (mode 'today') is still householdSpend, the return included", async () => {
    const { spend } = await classifierSpendForRange(HH, WEEK.start, WEEK.end, { mode: "today" });
    expect(spend).toEqual({ total: 90, transactionCount: 2 });
  });

  it("the cap's pool nets the return on the card's own account: 90.00 (was 120.00)", async () => {
    const w = await loadAllowanceWindow(HH, WEEK);
    expect(allowanceSpentCents(w.movement.map(({ row, m }) => allowanceRowOf(row, m)), "weekly")).toBe(9000);
    const refunds = w.movement.filter(({ m }) => m.coverage === "refund").map(({ row }) => row.description);
    expect(refunds).toEqual(["TARGET T-1234"]);
  });

  it("the money position and the spine move together: spent 90.00, 210.00 left of 300.00", async () => {
    const pos = await get("/money/position");
    expect([pos.weekCap, pos.spentWeekDiscretionary, pos.remainingWeek]).toEqual(["300.00", "90.00", "210.00"]);
    const spine = await get("/spine");
    expect(spine.spentWeek).toBe(90);
    expect(spine.spentMonth).toBe(90);
    expect(spine.position.remainingWeek).toBe("210.00");
  });

  it("the week's breakdown: Groceries 50.00, unfiled 40.00, actual 90.00", async () => {
    const b = await get(`/money/period-breakdown?period=week&start=${WEEK.start}`);
    expect(b.actual).toBe("90.00");
    expect(b.categories.map((c: { categoryId: string; amount: string }) => [c.categoryId, c.amount])).toEqual([[GROCERIES, "50.00"]]);
    expect(b.needsClassification.amount).toBe("40.00");
    expect(b.refundFloorAdjustment).toBe("0.00");
  });
});
