// (PR7b) A pending charge and the posted row that replaced it are ONE charge in
// spending, not two. PR4c's `pairPendingWithPosted` already keeps them out of
// cash twice; this pins the same answer through /reports/spending-facts, the
// spine, the Amex weekly payoff and the Habits facts.
//
// The reviewer's case: a pending $45.00 and its posted $47.40 on the same card
// counted $92.40 of household and real spend. The truth is $47.40.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `pr7b-pending-pairs-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
  budgetCategoriesTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import amexRouter from "../routes/amex";
import budgetRouter from "../routes/budget";
import reportsRouter from "../routes/reports";
import spineRouter from "../routes/spine";
import transactionsRouter from "../routes/transactions";
import { buildBehaviorFacts } from "../lib/behaviorFacts";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(amexRouter);
app.use(budgetRouter);
app.use(reportsRouter);
app.use(spineRouter);
app.use(transactionsRouter);

let server: Server;
let baseUrl: string;

// Thu 10/8/2026, noon Central: the spine's week is Sun 10/4 – Sat 10/10 and its
// month 10/1 – 10/8.
const NOW = new Date("2026-10-08T12:00:00-05:00");
const WEEK = { from: "2026-10-04", to: "2026-10-10" };
const MONTH_TO_DATE = { from: "2026-10-01", to: "2026-10-08" };

// One Plaid account per scenario, so no scenario's rows can pair with another's.
const acct = (name: string) => `acct-${name}-${randomUUID()}`;

type Facts = {
  householdSpend: { total: number; transactionCount: number };
  realSpend: { total: number; transactionCount: number };
  realIncome: { total: number; transactionCount: number };
  uncategorized: { total: number; transactionCount: number };
  byCategory: { categoryId: string; total: number; txnCount: number }[];
  excluded: {
    transfersTotal: number;
    debtPaymentsTotal: number;
    reimbursementTotal: number;
    ignoreTotal: number;
    cardPayments: number;
    reimbursable: number;
    replacedPending: number;
  };
};
type Spine = { spentWeek: number; spentMonth: number };

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}
const facts = (w: { from: string; to: string }) =>
  get<Facts>(`/reports/spending-facts?from=${w.from}&to=${w.to}`);

async function cleanup(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

const cat: Record<string, string> = {};

/**
 * One ledger row. `createdAt` is set explicitly (15:00 UTC on its own day, plus
 * `minutes`) because pairing needs the posted row to reach the ledger after its
 * pending row, and the database clock is not the test's mocked clock.
 */
async function addTxn(row: {
  occurredOn: string;
  description: string;
  amount: string;
  plaidAccountId: string;
  pending?: boolean;
  categoryId?: string | null;
  source?: string;
  minutes?: number;
  extra?: Partial<typeof transactionsTable.$inferInsert>;
}): Promise<string> {
  const createdAt = new Date(`${row.occurredOn}T15:00:00Z`);
  createdAt.setUTCMinutes(row.minutes ?? 0);
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      source: row.source ?? "plaid:chase",
      occurredOn: row.occurredOn,
      description: row.description,
      amount: row.amount,
      plaidAccountId: row.plaidAccountId,
      pending: row.pending ?? false,
      categoryId: row.categoryId === undefined ? cat.dining : row.categoryId,
      createdAt,
      ...row.extra,
    })
    .returning({ id: transactionsTable.id });
  return t!.id;
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
  vi.setSystemTime(NOW);
  for (const [key, name, kind] of [
    ["dining", "Dining", "expense"],
    ["groceries", "Groceries", "expense"],
    ["paycheck", "Paycheck", "income"],
    ["ignore", "Ignore", "expense"],
    ["eatingOut", "Eating out", "expense"],
  ] as const) {
    const [c] = await db
      .insert(budgetCategoriesTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name, kind })
      .returning();
    cat[key] = c!.id;
  }
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

describe("PR7b — a pending charge and its posted row count once in spending", () => {
  it("the reviewer's case: pending $45.00 + posted $47.40 on one card count $47.40, on the report and the spine", async () => {
    const card = acct("visa");
    await addTxn({ occurredOn: "2026-10-05", description: "BLUE BOTTLE COFFEE", amount: "-45.00", plaidAccountId: card, pending: true });
    await addTxn({ occurredOn: "2026-10-06", description: "BLUE BOTTLE COFFEE", amount: "-47.40", plaidAccountId: card });

    const f = await facts(WEEK);
    expect(f.householdSpend).toEqual({ total: 47.4, transactionCount: 1 });
    expect(f.realSpend).toEqual({ total: 47.4, transactionCount: 1 });
    expect(f.byCategory).toEqual([
      expect.objectContaining({ categoryId: cat.dining, total: 47.4, txnCount: 1 }),
    ]);
    // Every dollar that left is still accounted for: the pending half is shown, not lost.
    expect(f.excluded.replacedPending).toBe(45);

    // Spine parity, to the cent, with the pair in both of its windows.
    const spine = await get<Spine>("/spine");
    const month = await facts(MONTH_TO_DATE);
    expect(spine.spentWeek).toBe(f.householdSpend.total);
    expect(spine.spentMonth).toBe(month.householdSpend.total);
    expect(spine.spentWeek).toBe(47.4);
    expect(spine.spentMonth).toBe(47.4);

    // Habits: one visit, not two.
    const habits = await buildBehaviorFacts(TEST_HOUSEHOLD_ID, WEEK.from, WEEK.to);
    expect(habits.funFacts.mostVisitedMerchant).toMatchObject({ count: 1, total: 47.4 });

    // Nothing was deleted or re-tagged: both rows are still in the ledger.
    const rows = await db
      .select({ pending: transactionsTable.pending, amount: transactionsTable.amount })
      .from(transactionsTable)
      .where(eq(transactionsTable.plaidAccountId, card));
    expect(rows.map((r) => [r.pending, r.amount]).sort()).toEqual([
      [false, "-47.40"],
      [true, "-45.00"],
    ]);
  });

  it("pending rows that are not the other half of a pair still count", async () => {
    // (review N2) Its own week and accounts: passes run alone (`-t`).
    const card = acct("mastercard");
    const other = acct("discover");
    // Still waiting to post.
    await addTxn({ occurredOn: "2026-07-20", description: "TARGET 00012345", amount: "-30.00", plaidAccountId: card, pending: true });
    // The same charge text and amount on a DIFFERENT card: two charges.
    await addTxn({ occurredOn: "2026-07-20", description: "HY-VEE 1502", amount: "-60.00", plaidAccountId: card, pending: true, categoryId: cat.groceries });
    await addTxn({ occurredOn: "2026-07-21", description: "HY-VEE 1502", amount: "-60.00", plaidAccountId: other, categoryId: cat.groceries });
    // A posted amount over 1.30 × pending + $1: a second, different charge.
    await addTxn({ occurredOn: "2026-07-20", description: "KWIK TRIP 812", amount: "-20.00", plaidAccountId: card, pending: true });
    await addTxn({ occurredOn: "2026-07-21", description: "KWIK TRIP 812", amount: "-40.00", plaidAccountId: card });

    const f = await facts({ from: "2026-07-19", to: "2026-07-25" });
    // 30 + 60 + 60 + 20 + 40: every row counts.
    expect(f.householdSpend).toEqual({ total: 210, transactionCount: 5 });
    expect(f.excluded.replacedPending).toBe(0);
  });

  it("a pair straddling a week boundary counts once, in the week it posted; the weeks add up to the fortnight", async () => {
    const card = acct("amex-blue");
    // Pending Saturday 9/19, posted Monday 9/21.
    await addTxn({ occurredOn: "2026-09-19", description: "CHIPOTLE 2231", amount: "-45.00", plaidAccountId: card, pending: true });
    await addTxn({ occurredOn: "2026-09-21", description: "CHIPOTLE 2231", amount: "-47.40", plaidAccountId: card });

    const before = await facts({ from: "2026-09-13", to: "2026-09-19" });
    const after = await facts({ from: "2026-09-20", to: "2026-09-26" });
    const both = await facts({ from: "2026-09-13", to: "2026-09-26" });
    expect(before.householdSpend).toEqual({ total: 0, transactionCount: 0 });
    expect(before.excluded.replacedPending).toBe(45);
    expect(after.householdSpend).toEqual({ total: 47.4, transactionCount: 1 });
    expect(both.householdSpend).toEqual({ total: 47.4, transactionCount: 1 });
    expect(before.householdSpend.total + after.householdSpend.total).toBe(both.householdSpend.total);
  });

  it("at the edge, the posted row replaces the OLDER pending row outside the window; a second pending charge inside it still counts", async () => {
    const card = acct("chase-sapphire");
    // Two meals, both pending at $45.00; one posts Monday at $47.40. Holds post
    // oldest first, so the posted row replaced Saturday's pending row, and
    // Sunday's is a second meal still pending. Pairing only the window's rows
    // would take Sunday's instead and report $47.40.
    await addTxn({ occurredOn: "2026-09-05", description: "PANERA BREAD 601", amount: "-45.00", plaidAccountId: card, pending: true });
    await addTxn({ occurredOn: "2026-09-06", description: "PANERA BREAD 601", amount: "-45.00", plaidAccountId: card, pending: true });
    await addTxn({ occurredOn: "2026-09-07", description: "PANERA BREAD 601", amount: "-47.40", plaidAccountId: card });

    const prevWeek = await facts({ from: "2026-08-30", to: "2026-09-05" });
    const week = await facts({ from: "2026-09-06", to: "2026-09-12" });
    expect(prevWeek.householdSpend.total).toBe(0);
    expect(prevWeek.excluded.replacedPending).toBe(45);
    expect(week.householdSpend).toEqual({ total: 92.4, transactionCount: 2 });
    expect(week.excluded.replacedPending).toBe(0);
  });

  it("pairing does not depend on where the window starts, even through a chain longer than 7 days", async () => {
    const card = acct("citi");
    // Pending 8/13, 8/17 and 8/23 at $5.00; posted 8/18 and 8/24 at $6.00.
    // Posted rows pick in date order, oldest pending first: 8/18 takes 8/13,
    // 8/24 takes 8/17, and 8/23 is still pending. A read starting 7 days before
    // the week (8/16) would miss 8/13, let 8/18 take 8/17 and 8/24 take 8/23.
    await addTxn({ occurredOn: "2026-08-13", description: "STARBUCKS STORE 1234", amount: "-5.00", plaidAccountId: card, pending: true });
    await addTxn({ occurredOn: "2026-08-17", description: "STARBUCKS STORE 1234", amount: "-5.00", plaidAccountId: card, pending: true });
    await addTxn({ occurredOn: "2026-08-18", description: "STARBUCKS STORE 1234", amount: "-6.00", plaidAccountId: card });
    await addTxn({ occurredOn: "2026-08-23", description: "STARBUCKS STORE 1234", amount: "-5.00", plaidAccountId: card, pending: true });
    await addTxn({ occurredOn: "2026-08-24", description: "STARBUCKS STORE 1234", amount: "-6.00", plaidAccountId: card });

    const w1 = await facts({ from: "2026-08-09", to: "2026-08-15" });
    const w2 = await facts({ from: "2026-08-16", to: "2026-08-22" });
    const w3 = await facts({ from: "2026-08-23", to: "2026-08-29" });
    const all = await facts({ from: "2026-08-09", to: "2026-08-29" });
    expect(w1.householdSpend.total).toBe(0);
    expect(w2.householdSpend.total).toBe(6);
    expect(w3.householdSpend).toEqual({ total: 11, transactionCount: 2 });
    expect(w3.excluded.replacedPending).toBe(0);
    expect(all.householdSpend).toEqual({ total: 17, transactionCount: 3 });
    expect(all.excluded.replacedPending).toBe(10);
  });

  it("a pending deposit its posted row replaced is not income twice", async () => {
    const checking = acct("checking");
    await addTxn({ occurredOn: "2026-08-03", description: "ACME CORP PAYROLL", amount: "500.00", plaidAccountId: checking, pending: true, categoryId: cat.paycheck });
    await addTxn({ occurredOn: "2026-08-04", description: "ACME CORP PAYROLL", amount: "500.00", plaidAccountId: checking, categoryId: cat.paycheck });

    const f = await facts({ from: "2026-08-02", to: "2026-08-08" });
    expect(f.realIncome).toEqual({ total: 500, transactionCount: 1 });
    // A deposit is not an outflow: nothing to show under replacedPending.
    expect(f.excluded.replacedPending).toBe(0);
  });

  it("the Amex weekly payoff owes the pair once", async () => {
    const card = acct("amex-plat");
    const [item] = await db
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
    await db.insert(plaidAccountsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: card,
      name: "Platinum Card",
      mask: "1001",
      type: "credit",
      subtype: "credit card",
    });
    await addTxn({ occurredOn: "2026-09-28", description: "SWEETGREEN 44", amount: "-45.00", plaidAccountId: card, pending: true, source: "plaid:amex" });
    await addTxn({ occurredOn: "2026-09-29", description: "SWEETGREEN 44", amount: "-47.40", plaidAccountId: card, source: "plaid:amex" });

    const payoff = await get<{
      cards: { accountId: string; weekCharges: number; chargeCount: number }[];
    }>(`/amex/weekly-payoff?weekStart=2026-09-27`);
    expect(payoff.cards.find((c) => c.accountId === card)).toMatchObject({
      weekCharges: 47.4,
      chargeCount: 1,
    });
  });
});

describe("PR7b — the Spending popover can list a purchase whose category was deleted", () => {
  it("uncategorized=true returns rows with no category AND rows whose category no longer exists", async () => {
    const card = acct("popover");
    const none = await addTxn({ occurredOn: "2026-07-06", description: "FARMERS MARKET", amount: "-10.00", plaidAccountId: card, categoryId: null });
    const gone = await addTxn({ occurredOn: "2026-07-07", description: "HARDWARE STORE", amount: "-12.00", plaidAccountId: card, categoryId: randomUUID() });
    const live = await addTxn({ occurredOn: "2026-07-08", description: "HY-VEE 1502", amount: "-14.00", plaidAccountId: card, categoryId: cat.groceries });

    const rows = await get<{ id: string }[]>(
      `/transactions?from=2026-07-05&to=2026-07-11&uncategorized=true&limit=100`,
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(none);
    expect(ids).toContain(gone);
    expect(ids).not.toContain(live);

    // The list and the banner's total now describe the same rows.
    const f = await facts({ from: "2026-07-05", to: "2026-07-11" });
    expect(f.uncategorized).toMatchObject({ total: 22, transactionCount: 2 });
    expect(ids).toHaveLength(2);
  });
});

describe("PR7b review N3 — every dollar that left lands in exactly one bucket, across a week boundary", () => {
  it("spend + every excluded bucket (replacedPending included) = raw outflow, per week and for the fortnight", async () => {
    const card = acct("buckets-card");
    const checking = acct("buckets-checking");
    const rows: { occurredOn: string; amount: string }[] = [];
    const add = async (r: Parameters<typeof addTxn>[0]) => {
      rows.push({ occurredOn: r.occurredOn, amount: r.amount });
      await addTxn(r);
    };
    // Week A, Sun 6/07 – Sat 6/13.
    await add({ occurredOn: "2026-06-08", description: "HY-VEE 1502", amount: "-30.00", plaidAccountId: card });
    await add({ occurredOn: "2026-06-09", description: "FARMERS MARKET", amount: "-12.00", plaidAccountId: card, categoryId: null });
    await add({ occurredOn: "2026-06-10", description: "CLIENT DINNER", amount: "-40.00", plaidAccountId: card, extra: { reimbursable: true } });
    await add({ occurredOn: "2026-06-11", description: "CAPITAL ONE CRCARDPMT 5KX9", amount: "-100.00", plaidAccountId: checking, categoryId: null });
    await add({ occurredOn: "2026-06-12", description: "ONLINE TRANSFER TO SAV 8801", amount: "-200.00", plaidAccountId: checking, categoryId: null, extra: { isTransfer: true } });
    // A card payment that sat pending and then posted, both in week A.
    await add({ occurredOn: "2026-06-12", description: "CAPITAL ONE CRCARDPMT 7Q2", amount: "-80.00", plaidAccountId: checking, pending: true, categoryId: null });
    await add({ occurredOn: "2026-06-13", description: "CAPITAL ONE CRCARDPMT 7Q2", amount: "-80.00", plaidAccountId: checking, categoryId: null });
    // A purchase pending Saturday of week A, posted Monday of week B.
    await add({ occurredOn: "2026-06-13", description: "BLUE APRON", amount: "-45.00", plaidAccountId: card, pending: true });
    // Week B, Sun 6/14 – Sat 6/20.
    await add({ occurredOn: "2026-06-15", description: "BLUE APRON", amount: "-47.40", plaidAccountId: card });
    await add({ occurredOn: "2026-06-16", description: "COSTCO WHSE 1035", amount: "-15.00", plaidAccountId: card, categoryId: cat.ignore });
    // An inflow: not an outflow, in no bucket.
    await add({ occurredOn: "2026-06-17", description: "ACME CORP PAYROLL", amount: "500.00", plaidAccountId: checking, categoryId: cat.paycheck });

    const rawOutflow = (from: string, to: string) =>
      Math.round(
        rows
          .filter((r) => r.occurredOn >= from && r.occurredOn <= to && Number(r.amount) < 0)
          .reduce((s, r) => s - Number(r.amount) * 100, 0),
      ) / 100;
    const buckets = (f: Facts) =>
      Math.round(
        (f.householdSpend.total +
          f.excluded.transfersTotal +
          f.excluded.debtPaymentsTotal +
          f.excluded.reimbursementTotal +
          f.excluded.ignoreTotal +
          f.excluded.cardPayments +
          f.excluded.reimbursable +
          f.excluded.replacedPending) *
          100,
      ) / 100;

    const A = { from: "2026-06-07", to: "2026-06-13" };
    const B = { from: "2026-06-14", to: "2026-06-20" };
    const AB = { from: "2026-06-07", to: "2026-06-20" };
    const [fa, fb, fab] = [await facts(A), await facts(B), await facts(AB)];

    expect(rawOutflow(A.from, A.to)).toBe(587);
    expect(rawOutflow(B.from, B.to)).toBe(62.4);
    expect(buckets(fa)).toBe(587);
    expect(buckets(fb)).toBe(62.4);
    expect(buckets(fab)).toBe(649.4);

    expect(fa.householdSpend.total).toBe(42);
    expect(fa.excluded).toMatchObject({ cardPayments: 180, transfersTotal: 200, reimbursable: 40, replacedPending: 125 });
    expect(fb.householdSpend.total).toBe(47.4);
    expect(fb.excluded).toMatchObject({ ignoreTotal: 15, replacedPending: 0 });

    // The weeks add up to the fortnight, bucket by bucket.
    expect(fab.householdSpend.total).toBeCloseTo(fa.householdSpend.total + fb.householdSpend.total, 2);
    for (const k of Object.keys(fab.excluded) as (keyof Facts["excluded"])[]) {
      expect(fab.excluded[k], k).toBeCloseTo(fa.excluded[k] + fb.excluded[k], 2);
    }
  });
});

describe("⚠️ KNOWN RESIDUAL (pending Brad's decision) — the Budget page still counts both halves of a pair", () => {
  // PR7b review M2. The Budget page's per-category actual
  // (`GET /budget/months/:m`, routes/budget.ts) sums rows in SQL and does not
  // pair pending with posted rows. Changing it is a financial calculation on
  // the Budget page and needs the owner's decision, so this PR leaves it.
  // On `main` both pages double-counted and agreed; now they differ by the
  // replaced pending rows. When the Budget page adopts pairing, UPDATE this
  // test to assert agreement — do not delete it.
  it("June 'Eating out': Spending shows 69.40, the Budget page 134.40 — the 65.00 of replaced pending rows", async () => {
    const card = acct("budget-residual");
    await addTxn({ occurredOn: "2026-06-23", description: "OLIVE GARDEN 1234", amount: "-45.00", plaidAccountId: card, pending: true, categoryId: cat.eatingOut });
    await addTxn({ occurredOn: "2026-06-24", description: "OLIVE GARDEN 1234", amount: "-47.40", plaidAccountId: card, categoryId: cat.eatingOut });
    await addTxn({ occurredOn: "2026-06-25", description: "CHIPOTLE 9", amount: "-20.00", plaidAccountId: card, pending: true, categoryId: cat.eatingOut });
    await addTxn({ occurredOn: "2026-06-26", description: "CHIPOTLE 9", amount: "-22.00", plaidAccountId: card, categoryId: cat.eatingOut });

    const june = await facts({ from: "2026-06-01", to: "2026-06-30" });
    const spending = june.byCategory.find((c) => c.categoryId === cat.eatingOut);
    expect(spending).toMatchObject({ total: 69.4, txnCount: 2 });

    const budget = await get<{ lines: { categoryId: string; actualAmount: string }[] }>(
      "/budget/months/2026-06-01",
    );
    const line = budget.lines.find((l) => l.categoryId === cat.eatingOut);
    expect(line?.actualAmount).toBe("134.40");
    expect(Number(line!.actualAmount) - spending!.total).toBeCloseTo(65, 2);
  });
});
