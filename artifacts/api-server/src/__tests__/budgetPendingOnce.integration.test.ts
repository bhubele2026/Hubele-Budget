// (PR-D, owner decisions 6 and 14) The Budget page counts a pending purchase
// ONCE, with the same rule as Spending, and a posted row that replaced a filed
// pending row carries that filing.
//
// Owner: "Show posted spending, pending spending, combined spending so far.
// Pending purchases consume available budget. When they post, replace the
// pending version and adjust for the final amount. Example: a $40 pending
// restaurant charge posts at $48 → spending becomes $48, not $88."
//
// The pairing is PR4c's `pairPendingWithPosted`, read for the month's window
// (`findSupersededPendingForRange`, exactly the whole-ledger answer for rows in
// the month). The filing a posted row lacks comes from the pending row it
// replaced (`effectiveFiling`) — sync inserts the posted row bare, so without
// this the charge would leave its envelope the moment it posts (review H1).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `prd-pending-once-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

// Count pairing runs without changing them (review M3).
vi.mock("@workspace/avalanche-core", async () => {
  const actual = await vi.importActual<typeof import("@workspace/avalanche-core")>(
    "@workspace/avalanche-core",
  );
  return { ...actual, pairPendingWithPostedAmong: vi.fn(actual.pairPendingWithPostedAmong) };
});

import {
  db,
  avalancheSettingsTable,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  debtsTable,
  mappingRulesTable,
  recurringItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import { pairPendingWithPostedAmong } from "@workspace/avalanche-core";
import budgetRouter from "../routes/budget";
import reportsRouter from "../routes/reports";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(budgetRouter);
app.use(reportsRouter);

let server: Server;
let baseUrl: string;

type Line = {
  categoryId: string;
  categoryName: string;
  plannedAmount: string;
  actualAmount: string;
  postedAmount: string;
  pendingAmount: string;
  combinedAmount: string;
  planSource: string;
  kind: string;
  sourceBreakdown: { source: string; count: number; amount: string }[];
};
type Split = { posted: string; pending: string; combined: string };
type AllowanceLine = Split & {
  bucket: string;
  planned: string;
  actual: string;
  count: number;
  subBuckets: { bucket: string; actual: string; count: number }[];
};
type PlanBucket = { planned: string; actual: string; lineCount: number };
type Month = {
  lines: Line[];
  summary: { expenses: { actual: string } };
  planBySource: {
    income: PlanBucket;
    bills: PlanBucket;
    debts: PlanBucket;
    unbacked: PlanBucket;
    plannedTotal: string;
    actualTotal: string;
    net: string;
  };
  allowance: Split & { lines: AllowanceLine[]; planned: string; actual: string };
  replacedPendingIds: string[];
  inheritedCategories: { transactionId: string; categoryId: string }[];
};
type Facts = {
  householdSpend: { total: number; transactionCount: number };
  uncategorized: { total: number; transactionCount: number };
  byCategory: { categoryId: string; total: number; txnCount: number }[];
  excluded: { reimbursable: number; replacedPending: number };
};

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}
const month = (m: string) => get<Month>(`/budget/months/${m}`);
const facts = (from: string, to: string) =>
  get<Facts>(`/reports/spending-facts?from=${from}&to=${to}`);
const lineFor = (d: Month, categoryId: string): Line => {
  const l = d.lines.find((x) => x.categoryId === categoryId);
  if (!l) throw new Error(`no line for ${categoryId}`);
  return l;
};
const split = (l: Line) => ({
  posted: l.postedAmount,
  pending: l.pendingAmount,
  combined: l.combinedAmount,
  actual: l.actualAmount,
});
const bucket = (d: Month, b: string): AllowanceLine => {
  const l = d.allowance.lines.find((x) => x.bucket === b);
  if (!l) throw new Error(`no allowance bucket ${b}`);
  return l;
};
const spendingTotal = async (from: string, to: string, categoryId: string) => {
  const f = await facts(from, to);
  return f.byCategory.find((c) => c.categoryId === categoryId)?.total ?? 0;
};

// One Plaid account per scenario, so no scenario's rows can pair with another's.
const acct = (name: string) => `acct-${name}-${randomUUID()}`;

async function addCategory(name: string, kind: "expense" | "income" = "expense"): Promise<string> {
  const [c] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name, kind })
    .returning();
  return c!.id;
}

/**
 * One ledger row. `createdAt` is explicit (15:00 UTC on its own day): pairing
 * needs the posted row to reach the ledger after its pending row, and the
 * database clock is not the test's.
 */
async function addTxn(row: {
  occurredOn: string;
  description: string;
  amount: string;
  plaidAccountId: string;
  categoryId: string | null;
  pending?: boolean;
  extra?: Partial<typeof transactionsTable.$inferInsert>;
}): Promise<string> {
  const createdAt = new Date(`${row.occurredOn}T15:00:00Z`);
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      source: "plaid:chase",
      occurredOn: row.occurredOn,
      description: row.description,
      amount: row.amount,
      plaidAccountId: row.plaidAccountId,
      pending: row.pending ?? false,
      categoryId: row.categoryId,
      createdAt,
      ...row.extra,
    })
    .returning({ id: transactionsTable.id });
  return t!.id;
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  for (const t of [
    transactionsTable,
    mappingRulesTable,
    recurringItemsTable,
    budgetLinesTable,
    budgetMonthsTable,
    budgetCategoriesTable,
    debtsTable,
    avalancheSettingsTable,
    settingsTable,
  ]) {
    await db.delete(t).where(eq(t.userId, TEST_USER));
  }
  await new Promise<void>((res) => server.close(() => res()));
});

describe("(PR-D) a category's actual counts a pending purchase once", () => {
  it("⭐ the owner's example: $40 pending → posted 0 / pending 40 / combined 40; it posts at $48 → 48 / 0 / 48, never 88", async () => {
    const cat = await addCategory("Restaurants PR-D");
    const card = acct("restaurant");
    const pendingId = await addTxn({
      occurredOn: "2026-07-14",
      description: "OLIVE GARDEN 1234",
      amount: "-40.00",
      plaidAccountId: card,
      categoryId: cat,
      pending: true,
    });

    // Not yet posted: the pending charge already uses the budget.
    const before = await month("2026-07-01");
    expect(split(lineFor(before, cat))).toEqual({
      posted: "0.00",
      pending: "40.00",
      combined: "40.00",
      actual: "40.00",
    });
    expect(before.replacedPendingIds).not.toContain(pendingId);
    expect(await spendingTotal("2026-07-01", "2026-07-31", cat)).toBe(40);

    // It posts at $48 (tip added), filed the same way.
    const postedId = await addTxn({
      occurredOn: "2026-07-15",
      description: "OLIVE GARDEN 1234",
      amount: "-48.00",
      plaidAccountId: card,
      categoryId: cat,
    });

    const after = await month("2026-07-01");
    const line = lineFor(after, cat);
    expect(split(line)).toEqual({
      posted: "48.00",
      pending: "0.00",
      combined: "48.00",
      actual: "48.00",
    });
    // The replaced row is named, so the page's drill can leave it out and still tie.
    expect(after.replacedPendingIds).toContain(pendingId);
    expect(after.replacedPendingIds).not.toContain(postedId);
    // The source badge counts the charge once too.
    expect(line.sourceBreakdown).toEqual([{ source: "Bank", count: 1, amount: "48.00" }]);
    // Budget and Spending agree to the cent.
    expect(await spendingTotal("2026-07-01", "2026-07-31", cat)).toBe(Number(line.actualAmount));

    // Nothing was deleted: both rows are still in the ledger.
    const rows = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(eq(transactionsTable.plaidAccountId, card));
    expect(rows).toHaveLength(2);
  });

  it("a pending row with no posted successor counts once; a posted row too large to be its successor is a second charge", async () => {
    const cat = await addCategory("Coffee PR-D");
    const card = acct("coffee");
    // Still pending.
    await addTxn({ occurredOn: "2026-07-20", description: "KWIK TRIP 812", amount: "-20.00", plaidAccountId: card, categoryId: cat, pending: true });
    // $40 > 1.30 × $20 + $1: not the same charge, so nothing is replaced.
    await addTxn({ occurredOn: "2026-07-21", description: "KWIK TRIP 812", amount: "-40.00", plaidAccountId: card, categoryId: cat });

    const d = await month("2026-07-01");
    expect(split(lineFor(d, cat))).toEqual({
      posted: "40.00",
      pending: "20.00",
      combined: "60.00",
      actual: "60.00",
    });
    expect(await spendingTotal("2026-07-01", "2026-07-31", cat)).toBe(60);
  });

  it("⚠️ a pair across a month boundary counts once, in the month it posted — the earlier month falls when it posts", async () => {
    const cat = await addCategory("Dinner out PR-D");
    const card = acct("boundary");
    await addTxn({ occurredOn: "2026-09-30", description: "CHIPOTLE 2231", amount: "-40.00", plaidAccountId: card, categoryId: cat, pending: true });

    expect(split(lineFor(await month("2026-09-01"), cat))).toMatchObject({ pending: "40.00", actual: "40.00" });

    // Posted bare, as sync inserts it: October still files it under the pending row's category.
    await addTxn({ occurredOn: "2026-10-01", description: "CHIPOTLE 2231", amount: "-48.00", plaidAccountId: card, categoryId: null });

    const sept = await month("2026-09-01");
    const oct = await month("2026-10-01");
    expect(split(lineFor(sept, cat))).toEqual({ posted: "0.00", pending: "0.00", combined: "0.00", actual: "0.00" });
    expect(split(lineFor(oct, cat))).toEqual({ posted: "48.00", pending: "0.00", combined: "48.00", actual: "48.00" });
    // Spending draws the same line.
    expect(await spendingTotal("2026-09-01", "2026-09-30", cat)).toBe(0);
    expect(await spendingTotal("2026-10-01", "2026-10-31", cat)).toBe(48);
  });

  it("a pending deposit its posted row replaced is not income twice", async () => {
    const cat = await addCategory("Paycheck PR-D", "income");
    const checking = acct("checking");
    await addTxn({ occurredOn: "2026-06-03", description: "ACME CORP PAYROLL", amount: "500.00", plaidAccountId: checking, categoryId: cat, pending: true });
    await addTxn({ occurredOn: "2026-06-04", description: "ACME CORP PAYROLL", amount: "500.00", plaidAccountId: checking, categoryId: cat });

    const d = await month("2026-06-01");
    expect(split(lineFor(d, cat))).toEqual({ posted: "500.00", pending: "0.00", combined: "500.00", actual: "500.00" });
  });
});

describe("(PR-D review H1) the posted row arrives bare — it carries the pending row's filing", () => {
  it("⭐ $40 pending in Eating out, filed weekly/dining; sync inserts the $48 posted row with no category and no flags → Eating out 48, weekly 48, Spending's category 48, Uncategorized 0", async () => {
    const cat = await addCategory("Eating out PR-D H1");
    const card = acct("h1");
    await addTxn({
      occurredOn: "2026-12-10",
      description: "OLIVE GARDEN 1234",
      amount: "-40.00",
      plaidAccountId: card,
      categoryId: cat,
      pending: true,
      extra: { weeklyAllowance: true, weeklyBucket: "dining" },
    });
    const postedId = await addTxn({
      occurredOn: "2026-12-11",
      description: "OLIVE GARDEN 1234",
      amount: "-48.00",
      plaidAccountId: card,
      categoryId: null,
    });

    const d = await month("2026-12-01");
    expect(split(lineFor(d, cat))).toEqual({ posted: "48.00", pending: "0.00", combined: "48.00", actual: "48.00" });
    expect(bucket(d, "weekly")).toMatchObject({ posted: "48.00", pending: "0.00", actual: "48.00", count: 1 });
    expect(bucket(d, "weekly").subBuckets.find((s) => s.bucket === "dining")).toEqual({ bucket: "dining", actual: "48.00", count: 1 });
    expect(d.allowance).toMatchObject({ posted: "48.00", pending: "0.00", actual: "48.00" });
    expect(d.summary.expenses.actual).toBe("48.00");
    // The drill needs to know the bare row counts under Eating out.
    expect(d.inheritedCategories).toEqual([{ transactionId: postedId, categoryId: cat }]);

    const f = await facts("2026-12-01", "2026-12-31");
    expect(f.byCategory.find((c) => c.categoryId === cat)).toMatchObject({ total: 48, txnCount: 1 });
    expect(f.uncategorized).toMatchObject({ total: 0, transactionCount: 0 });
    expect(f.householdSpend).toEqual({ total: 48, transactionCount: 1 });

    // Read-time only: the stored row is untouched.
    const [stored] = await db
      .select({ categoryId: transactionsTable.categoryId, weekly: transactionsTable.weeklyAllowance })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, postedId));
    expect(stored).toEqual({ categoryId: null, weekly: false });
  });

  it("(review M2) a posted row with its OWN category keeps it: the whole charge leaves the pending row's category", async () => {
    const catA = await addCategory("Dining PR-D M2-A");
    const catB = await addCategory("Groceries PR-D M2-B");
    const card = acct("m2-cat");
    await addTxn({ occurredOn: "2026-07-24", description: "HY-VEE 1502", amount: "-40.00", plaidAccountId: card, categoryId: catA, pending: true });
    await addTxn({ occurredOn: "2026-07-25", description: "HY-VEE 1502", amount: "-48.00", plaidAccountId: card, categoryId: catB });

    const d = await month("2026-07-01");
    expect(split(lineFor(d, catA))).toEqual({ posted: "0.00", pending: "0.00", combined: "0.00", actual: "0.00" });
    expect(split(lineFor(d, catB))).toEqual({ posted: "48.00", pending: "0.00", combined: "48.00", actual: "48.00" });
    expect(await spendingTotal("2026-07-01", "2026-07-31", catA)).toBe(0);
    expect(await spendingTotal("2026-07-01", "2026-07-31", catB)).toBe(48);
    expect(d.inheritedCategories.map((x) => x.categoryId)).not.toContain(catA);
  });

  it("(review M2) a posted row with its OWN allowance flag keeps it: pending unplanned, posted weekly → unplanned 0, weekly 48", async () => {
    const card = acct("m2-flags");
    await addTxn({ occurredOn: "2027-01-12", description: "TARGET 00012345", amount: "-40.00", plaidAccountId: card, categoryId: null, pending: true, extra: { unplannedAllowance: true } });
    await addTxn({ occurredOn: "2027-01-13", description: "TARGET 00012345", amount: "-48.00", plaidAccountId: card, categoryId: null, extra: { weeklyAllowance: true } });

    const d = await month("2027-01-01");
    expect(bucket(d, "unplanned")).toMatchObject({ actual: "0.00", count: 0 });
    expect(bucket(d, "weekly")).toMatchObject({ actual: "48.00", count: 1 });
    expect(d.allowance.actual).toBe("48.00");
  });

  it("allowance flags are inherited only when the posted row has none: pending monthly, posted bare → monthly 22", async () => {
    const card = acct("inherit-flags");
    await addTxn({ occurredOn: "2027-02-03", description: "CASEYS 3301", amount: "-20.00", plaidAccountId: card, categoryId: null, pending: true, extra: { monthlyAllowance: true } });
    await addTxn({ occurredOn: "2027-02-04", description: "CASEYS 3301", amount: "-22.00", plaidAccountId: card, categoryId: null });

    const d = await month("2027-02-01");
    expect(bucket(d, "monthly")).toMatchObject({ posted: "22.00", pending: "0.00", actual: "22.00", count: 1 });
    expect(bucket(d, "weekly")).toMatchObject({ actual: "0.00" });
  });

  it("a reimbursable pending charge stays reimbursable once it posts bare: out of the allowance and out of Spending", async () => {
    const card = acct("inherit-reimb");
    await addTxn({ occurredOn: "2027-02-16", description: "CLIENT DINNER", amount: "-40.00", plaidAccountId: card, categoryId: null, pending: true, extra: { reimbursable: true, weeklyAllowance: true } });
    await addTxn({ occurredOn: "2027-02-17", description: "CLIENT DINNER", amount: "-48.00", plaidAccountId: card, categoryId: null });

    const d = await month("2027-02-01");
    // Only the monthly $22 from the test above: the reimbursable $48 is not allowance spend.
    expect(bucket(d, "weekly")).toMatchObject({ actual: "0.00", count: 0 });
    const f = await facts("2027-02-15", "2027-02-21");
    expect(f.householdSpend.total).toBe(0);
    expect(f.excluded).toMatchObject({ reimbursable: 48, replacedPending: 40 });
  });
});

describe("(PR-D review M3) pairing runs at most once per month read, and not at all without a pending row in reach", () => {
  it("a month with no pending row in it or in the 7 days before: no pairing", async () => {
    const card = acct("no-pending");
    // 8+ days before March: it cannot be replaced by a March row.
    await addTxn({ occurredOn: "2027-02-20", description: "SHELL OIL 57442", amount: "-30.00", plaidAccountId: card, categoryId: null, pending: true });
    await addTxn({ occurredOn: "2027-03-05", description: "SHELL OIL 57442", amount: "-31.00", plaidAccountId: card, categoryId: null });
    const spy = vi.mocked(pairPendingWithPostedAmong);
    spy.mockClear();
    await month("2027-03-01");
    expect(spy).not.toHaveBeenCalled();
  });

  it("a month holding a pending row: one pairing run", async () => {
    const spy = vi.mocked(pairPendingWithPostedAmong);
    spy.mockClear();
    await month("2026-12-01");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("(PR-D) the allowance card counts a pending purchase once", () => {
  it("posted / pending / combined per bucket and in total; the $40 → $48 pair counts $48 (both halves filed by hand)", async () => {
    const card = acct("allowance-card");
    const other = acct("allowance-other");
    await addTxn({
      occurredOn: "2026-08-10",
      description: "PANERA BREAD 601",
      amount: "-40.00",
      plaidAccountId: card,
      categoryId: null,
      pending: true,
      extra: { weeklyAllowance: true, weeklyBucket: "dining" },
    });
    // A monthly-filed charge still pending, with nothing to replace it.
    await addTxn({
      occurredOn: "2026-08-12",
      description: "TARGET 00012345",
      amount: "-15.00",
      plaidAccountId: other,
      categoryId: null,
      pending: true,
      extra: { monthlyAllowance: true },
    });

    const before = await month("2026-08-01");
    expect(bucket(before, "weekly")).toMatchObject({ posted: "0.00", pending: "40.00", combined: "40.00", actual: "40.00", count: 1 });
    expect(bucket(before, "monthly")).toMatchObject({ posted: "0.00", pending: "15.00", combined: "15.00", actual: "15.00" });
    expect(before.allowance).toMatchObject({ posted: "0.00", pending: "55.00", combined: "55.00", actual: "55.00" });

    await addTxn({
      occurredOn: "2026-08-11",
      description: "PANERA BREAD 601",
      amount: "-48.00",
      plaidAccountId: card,
      categoryId: null,
      extra: { weeklyAllowance: true, weeklyBucket: "dining" },
    });

    const after = await month("2026-08-01");
    const weekly = bucket(after, "weekly");
    expect(weekly).toMatchObject({ posted: "48.00", pending: "0.00", combined: "48.00", actual: "48.00", count: 1 });
    expect(weekly.subBuckets.find((s) => s.bucket === "dining")).toEqual({ bucket: "dining", actual: "48.00", count: 1 });
    expect(bucket(after, "monthly")).toMatchObject({ posted: "0.00", pending: "15.00", combined: "15.00", actual: "15.00" });
    expect(after.allowance).toMatchObject({ posted: "48.00", pending: "15.00", combined: "63.00", actual: "63.00" });
  });
});

describe("(PR-D) MUST NOT CHANGE — the plan", () => {
  it("⭐ plannedTotal and every planned figure in planBySource are the same before and after pending and posted rows land", async () => {
    const utilities = await addCategory("Utilities PR-D");
    await db.insert(recurringItemsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "MGE Electric & Gas PR-D",
      kind: "bill",
      amount: "175.00",
      frequency: "monthly",
      dayOfMonth: 10,
      categoryId: utilities,
    });

    const planOf = (d: Month) => ({
      plannedTotal: d.planBySource.plannedTotal,
      net: d.planBySource.net,
      income: [d.planBySource.income.planned, d.planBySource.income.lineCount],
      bills: [d.planBySource.bills.planned, d.planBySource.bills.lineCount],
      debts: [d.planBySource.debts.planned, d.planBySource.debts.lineCount],
      unbacked: [d.planBySource.unbacked.planned, d.planBySource.unbacked.lineCount],
      lines: d.lines.map((l) => [l.categoryId, l.plannedAmount, l.planSource]),
      allowancePlanned: [d.allowance.planned, ...d.allowance.lines.map((l) => l.planned)],
    });

    const before = await month("2026-11-01");
    expect(lineFor(before, utilities)).toMatchObject({ plannedAmount: "175.00", planSource: "bills" });

    const card = acct("plan");
    await addTxn({ occurredOn: "2026-11-10", description: "MGE ONLINE PMT", amount: "-160.00", plaidAccountId: card, categoryId: utilities, pending: true });
    await addTxn({ occurredOn: "2026-11-11", description: "MGE ONLINE PMT", amount: "-175.00", plaidAccountId: card, categoryId: utilities });
    await addTxn({ occurredOn: "2026-11-12", description: "MGE WATER", amount: "-30.00", plaidAccountId: card, categoryId: utilities, pending: true });

    const after = await month("2026-11-01");
    expect(planOf(after)).toEqual(planOf(before));
    expect(after.planBySource.plannedTotal).toBe(
      (Number(after.planBySource.bills.planned) + Number(after.planBySource.debts.planned)).toFixed(2),
    );

    // Only the actuals moved: 175 posted + 30 still pending; the $160 pending is replaced.
    expect(split(lineFor(after, utilities))).toEqual({ posted: "175.00", pending: "30.00", combined: "205.00", actual: "205.00" });
    const billsActual = after.lines
      .filter((l) => l.planSource === "bills")
      .reduce((s, l) => s + Math.round(Number(l.actualAmount) * 100), 0);
    expect(after.planBySource.bills.actual).toBe((billsActual / 100).toFixed(2));
  });
});
