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
//
// (round 4) Round 3 decided "hand vs rule filing" by re-reading the CURRENT
// mapping rules — wrong, because `PATCH /transactions/:id` repoints matching
// rules onto whatever the user just picked, so the check misread real routes
// in both directions (review H1). Round 3 also inherited `isTransfer`
// unconditionally, which hid real spending sync auto-flags as a transfer
// (Venmo/Zelle/PayPal, PFC TRANSFER_OUT — review H2). Round 4 decides both
// from the stored `isTransferUserOverridden` flag and never re-reads rules.

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
import transactionsRouter from "../routes/transactions";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(budgetRouter);
app.use(reportsRouter);
app.use(transactionsRouter);

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
  excluded: { reimbursable: number; replacedPending: number; transfersTotal: number };
};

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}
/** A real route call — used by the round 4 H1 repros so the auto-relearn /
 * rule-repoint side effects of `PATCH /transactions/:id` actually run. */
async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: unknown = null;
  try {
    json = await r.json();
  } catch {
    json = null;
  }
  return { status: r.status, json };
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

describe("(PR-D round 4) a hand filing beats an automatic one — decided from isTransferUserOverridden, never by re-reading mapping rules", () => {
  it("⭐ a: the $40 pending re-filed by hand to Auto (isTransferUserOverridden), posts at $45 with the rule's Groceries (no override) → Auto 45, Groceries 0, on Budget and Spending", async () => {
    const auto = await addCategory("Auto PR-D R4a");
    const groceries = await addCategory("Groceries PR-D R4a");
    await db.insert(mappingRulesTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      pattern: "COSTCO GAS",
      matchType: "contains",
      categoryId: groceries,
      priority: 100,
    });
    const card = acct("r4a-costco");
    await addTxn({
      occurredOn: "2027-04-06",
      description: "COSTCO GAS #0123",
      amount: "-40.00",
      plaidAccountId: card,
      categoryId: auto,
      pending: true,
      extra: { isTransferUserOverridden: true },
    });
    // Sync inserts the posted row with the rule's category, no override.
    const postedId = await addTxn({ occurredOn: "2027-04-07", description: "COSTCO GAS #0123", amount: "-45.00", plaidAccountId: card, categoryId: groceries });

    const d = await month("2027-04-01");
    expect(split(lineFor(d, auto))).toEqual({ posted: "45.00", pending: "0.00", combined: "45.00", actual: "45.00" });
    expect(split(lineFor(d, groceries))).toMatchObject({ actual: "0.00" });
    expect(d.inheritedCategories).toContainEqual({ transactionId: postedId, categoryId: auto });
    expect(await spendingTotal("2027-04-01", "2027-04-30", auto)).toBe(45);
    expect(await spendingTotal("2027-04-01", "2027-04-30", groceries)).toBe(0);
  });

  it("⭐ b1 (review H1 repro): rule COSTCO WHSE → Groceries; pending $100 and posted $110 both Groceries, no overrides; PATCH the POSTED row to Auto → Auto 110, Groceries 0", async () => {
    const groceries = await addCategory("Groceries PR-D R4b1");
    const auto = await addCategory("Auto PR-D R4b1");
    await db.insert(mappingRulesTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      pattern: "COSTCO WHSE",
      matchType: "contains",
      categoryId: groceries,
      priority: 100,
    });
    const card = acct("r4b1-costco");
    await addTxn({ occurredOn: "2027-08-06", description: "COSTCO WHSE 1035", amount: "-100.00", plaidAccountId: card, categoryId: groceries, pending: true });
    const postedId = await addTxn({ occurredOn: "2027-08-07", description: "COSTCO WHSE 1035", amount: "-110.00", plaidAccountId: card, categoryId: groceries });

    // The real route: re-filing the POSTED row also repoints the rule (auto-
    // relearn) — the whole point of the review's regression. The outcome must
    // still be Auto 110, not the stale rule's Groceries.
    const r = await api("PATCH", `/transactions/${postedId}`, { categoryId: auto });
    expect(r.status).toBe(200);

    const d = await month("2027-08-01");
    expect(split(lineFor(d, auto))).toEqual({ posted: "110.00", pending: "0.00", combined: "110.00", actual: "110.00" });
    expect(split(lineFor(d, groceries))).toMatchObject({ actual: "0.00" });
    expect(await spendingTotal("2027-08-01", "2027-08-31", auto)).toBe(110);
    expect(await spendingTotal("2027-08-01", "2027-08-31", groceries)).toBe(0);
  });

  it("⭐ b2 (review H1 repro, reverse order): same setup, PATCH the PENDING row to Auto instead → Auto 110, Groceries 0", async () => {
    const groceries = await addCategory("Groceries PR-D R4b2");
    const auto = await addCategory("Auto PR-D R4b2");
    await db.insert(mappingRulesTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      pattern: "COSTCO WHSE",
      matchType: "contains",
      categoryId: groceries,
      priority: 100,
    });
    const card = acct("r4b2-costco");
    const pendingId = await addTxn({ occurredOn: "2027-08-13", description: "COSTCO WHSE 1035", amount: "-100.00", plaidAccountId: card, categoryId: groceries, pending: true });
    await addTxn({ occurredOn: "2027-08-14", description: "COSTCO WHSE 1035", amount: "-110.00", plaidAccountId: card, categoryId: groceries });

    const r = await api("PATCH", `/transactions/${pendingId}`, { categoryId: auto });
    expect(r.status).toBe(200);

    const d = await month("2027-08-01");
    expect(split(lineFor(d, auto))).toEqual({ posted: "110.00", pending: "0.00", combined: "110.00", actual: "110.00" });
    expect(split(lineFor(d, groceries))).toMatchObject({ actual: "0.00" });
    expect(await spendingTotal("2027-08-01", "2027-08-31", auto)).toBe(110);
    expect(await spendingTotal("2027-08-01", "2027-08-31", groceries)).toBe(0);
  });

  it("c (review H1 repro): the outcome does not depend on the mapping rule at all — deleting or repointing it after sync changes nothing", async () => {
    const groceries = await addCategory("Groceries PR-D R4c");
    const [rule] = await db
      .insert(mappingRulesTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        pattern: "COSTCO WHSE",
        matchType: "contains",
        categoryId: groceries,
        priority: 100,
      })
      .returning();
    const card = acct("r4c-costco");
    // Sync filed both rows Groceries via the rule; neither was ever PATCHed.
    await addTxn({ occurredOn: "2027-08-20", description: "COSTCO WHSE 2091", amount: "-40.00", plaidAccountId: card, categoryId: groceries, pending: true });
    await addTxn({ occurredOn: "2027-08-21", description: "COSTCO WHSE 2091", amount: "-45.00", plaidAccountId: card, categoryId: groceries });

    const before = await month("2027-08-01");
    expect(split(lineFor(before, groceries))).toMatchObject({ actual: "45.00" });

    // The rule is deleted, then a differently-shaped rule repoints the same
    // pattern elsewhere. Neither write touches the transactions table.
    await db.delete(mappingRulesTable).where(eq(mappingRulesTable.id, rule!.id));
    const otherCat = await addCategory("Household PR-D R4c");
    await db.insert(mappingRulesTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      pattern: "COSTCO WHSE",
      matchType: "contains",
      categoryId: otherCat,
      priority: 100,
    });

    const after = await month("2027-08-01");
    expect(split(lineFor(after, groceries))).toMatchObject({ actual: "45.00" });
    expect(await spendingTotal("2027-08-01", "2027-08-31", groceries)).toBe(45);
  });
});

describe("(PR-D round 3 L2, NIT4) the transfer flag and the weekly slice carry over", () => {
  it("L2 (round 4: pending marked transfer BY HAND): a pending $40 Zelle marked transfer, posted bare at $48 → still a transfer on Spending, not Uncategorized spend; out of the allowance", async () => {
    const checking = acct("l2-transfer");
    // (round 4, review H2) Only a USER-SET transfer flag inherits — mark the
    // pending row `isTransferUserOverridden: true` the way a person clearing
    // it in the UI, or PATCH isTransfer=true, would.
    await addTxn({ occurredOn: "2027-05-10", description: "ZELLE TO JOHN SMITH", amount: "-40.00", plaidAccountId: checking, categoryId: null, pending: true, extra: { isTransfer: true, isTransferUserOverridden: true, weeklyAllowance: true } });
    await addTxn({ occurredOn: "2027-05-11", description: "ZELLE TO JOHN SMITH", amount: "-48.00", plaidAccountId: checking, categoryId: null });

    const f = await facts("2027-05-09", "2027-05-15");
    expect(f.uncategorized).toMatchObject({ total: 0, transactionCount: 0 });
    expect(f.householdSpend.total).toBe(0);
    expect(f.excluded).toMatchObject({ transfersTotal: 48, replacedPending: 40 });
    const d = await month("2027-05-01");
    expect(bucket(d, "weekly")).toMatchObject({ actual: "0.00", count: 0 });
  });

  it("NIT4: a posted row with its own weekly flag but no slice takes the weekly pending row's slice", async () => {
    const card = acct("nit4");
    await addTxn({ occurredOn: "2027-06-08", description: "PANERA BREAD 601", amount: "-40.00", plaidAccountId: card, categoryId: null, pending: true, extra: { weeklyAllowance: true, weeklyBucket: "dining" } });
    await addTxn({ occurredOn: "2027-06-09", description: "PANERA BREAD 601", amount: "-48.00", plaidAccountId: card, categoryId: null, extra: { weeklyAllowance: true } });

    const weekly = bucket(await month("2027-06-01"), "weekly");
    expect(weekly.subBuckets.find((s) => s.bucket === "dining")).toEqual({ bucket: "dining", actual: "48.00", count: 1 });
    expect(weekly.subBuckets.find((s) => s.bucket === "misc")).toEqual({ bucket: "misc", actual: "0.00", count: 0 });
  });
});

describe("(PR-D round 4, review H2) an auto-flagged pending transfer never overrules a posted row the household filed as real spending", () => {
  it("⭐ d1: pending 'VENMO *JOES PIZZA' auto-flagged transfer (no override); posted filed Dining by rule, weekly/dining (no override) → Dining 34, weekly 34, no transfer", async () => {
    const dining = await addCategory("Dining PR-D d1");
    const checking = acct("h2-d1-venmo");
    await addTxn({
      occurredOn: "2027-09-06",
      description: "VENMO *JOES PIZZA",
      amount: "-34.00",
      plaidAccountId: checking,
      categoryId: null,
      pending: true,
      extra: { isTransfer: true }, // sync's auto-flag; nobody overrode it
    });
    await addTxn({
      occurredOn: "2027-09-07",
      description: "VENMO *JOES PIZZA",
      amount: "-34.00",
      plaidAccountId: checking,
      categoryId: dining,
      extra: { weeklyAllowance: true, weeklyBucket: "dining" },
    });

    const d = await month("2027-09-01");
    expect(split(lineFor(d, dining))).toMatchObject({ actual: "34.00" });
    expect(bucket(d, "weekly")).toMatchObject({ actual: "34.00", count: 1 });
    expect(bucket(d, "weekly").subBuckets.find((s) => s.bucket === "dining")).toMatchObject({ actual: "34.00" });

    const f = await facts("2027-09-01", "2027-09-30");
    expect(f.excluded.transfersTotal).toBe(0);
    expect(f.byCategory.find((c) => c.categoryId === dining)).toMatchObject({ total: 34 });
  });

  it("⭐ d2: pending 'VENMO *SITTER ANNA' auto-flagged transfer; the user filed the posted row Dining, explicitly not a transfer (overridden) → Dining 60, no transfer, real spend counted", async () => {
    const dining = await addCategory("Dining PR-D d2");
    const checking = acct("h2-d2-venmo");
    await addTxn({
      occurredOn: "2027-09-13",
      description: "VENMO *SITTER ANNA",
      amount: "-60.00",
      plaidAccountId: checking,
      categoryId: null,
      pending: true,
      extra: { isTransfer: true }, // sync's auto-flag; nobody overrode it
    });
    await addTxn({
      occurredOn: "2027-09-14",
      description: "VENMO *SITTER ANNA",
      amount: "-60.00",
      plaidAccountId: checking,
      categoryId: dining,
      // The household filed this by hand: real spending, not a transfer.
      extra: { isTransfer: false, isTransferUserOverridden: true },
    });

    const d = await month("2027-09-01");
    expect(split(lineFor(d, dining))).toMatchObject({ actual: "60.00" });

    const f = await facts("2027-09-01", "2027-09-30");
    expect(f.excluded.transfersTotal).toBe(0);
    expect(f.householdSpend.total).toBeGreaterThanOrEqual(60);
    expect(f.byCategory.find((c) => c.categoryId === dining)).toMatchObject({ total: 60 });
  });
});

describe("(PR-D round 4, item 6) the bulk re-file-by-pattern route marks rows user-overridden", () => {
  it("POST /transactions/recategorize-by-pattern sets isTransferUserOverridden=true on every row it moves", async () => {
    const from = await addCategory("Misc PR-D bulk");
    const to = await addCategory("Groceries PR-D bulk");
    const t1 = await addTxn({ occurredOn: "2027-10-01", description: "ALDI 4471 BULK", amount: "-20.00", plaidAccountId: acct("bulk-1"), categoryId: from });
    const t2 = await addTxn({ occurredOn: "2027-10-02", description: "ALDI 4471 BULK", amount: "-30.00", plaidAccountId: acct("bulk-2"), categoryId: from });

    const [before1, before2] = await Promise.all([
      db.select({ v: transactionsTable.isTransferUserOverridden }).from(transactionsTable).where(eq(transactionsTable.id, t1)),
      db.select({ v: transactionsTable.isTransferUserOverridden }).from(transactionsTable).where(eq(transactionsTable.id, t2)),
    ]);
    expect(before1[0]!.v).toBe(false);
    expect(before2[0]!.v).toBe(false);

    const r = await api("POST", "/transactions/recategorize-by-pattern", {
      pattern: "ALDI 4471 BULK",
      matchType: "contains",
      fromCategoryId: from,
      toCategoryId: to,
    });
    expect(r.status).toBe(200);
    expect((r.json as { updated: number }).updated).toBe(2);

    const [after1, after2] = await Promise.all([
      db.select({ v: transactionsTable.isTransferUserOverridden }).from(transactionsTable).where(eq(transactionsTable.id, t1)),
      db.select({ v: transactionsTable.isTransferUserOverridden }).from(transactionsTable).where(eq(transactionsTable.id, t2)),
    ]);
    expect(after1[0]!.v).toBe(true);
    expect(after2[0]!.v).toBe(true);
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

describe("(PR-D round 5, review H1) POST /transactions/bulk-update marks a category/isTransfer pick user-overridden", () => {
  it("⭐ reproduced: rule COSTCO PROBE → Groceries; a pending $100 Groceries row (by rule) bulk-recategorized to Auto; posted $110 lands Groceries by rule → Auto 110, Groceries 0", async () => {
    const groceries = await addCategory("Groceries PR-D R5a");
    const auto = await addCategory("Auto PR-D R5a");
    await db.insert(mappingRulesTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      pattern: "COSTCO PROBE",
      matchType: "contains",
      categoryId: groceries,
      priority: 100,
    });
    const card = acct("r5a-costco");
    const pendingId = await addTxn({ occurredOn: "2027-10-06", description: "COSTCO PROBE 771", amount: "-100.00", plaidAccountId: card, categoryId: groceries, pending: true });

    const bulk = await api("POST", "/transactions/bulk-update", {
      ids: [pendingId],
      patch: { categoryId: auto },
    });
    expect(bulk.status).toBe(200);
    expect((bulk.json as { updated: number }).updated).toBe(1);

    // Plaid posts the charge bare-but-rule-categorized, same as sync always does.
    await addTxn({ occurredOn: "2027-10-07", description: "COSTCO PROBE 771", amount: "-110.00", plaidAccountId: card, categoryId: groceries });

    const d = await month("2027-10-01");
    expect(split(lineFor(d, auto))).toEqual({ posted: "110.00", pending: "0.00", combined: "110.00", actual: "110.00" });
    expect(split(lineFor(d, groceries))).toMatchObject({ actual: "0.00" });
    expect(await spendingTotal("2027-10-01", "2027-10-31", auto)).toBe(110);
    expect(await spendingTotal("2027-10-01", "2027-10-31", groceries)).toBe(0);

    const [row] = await db
      .select({ v: transactionsTable.isTransferUserOverridden })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, pendingId));
    expect(row!.v).toBe(true);
  });

  it("⭐ mirror: pending hand-filed via PATCH (override true) to Auto, then the POSTED row is bulk-recategorized to Household → the posted row's bulk pick wins, not the stale pending filing", async () => {
    const auto = await addCategory("Auto PR-D R5b");
    const household = await addCategory("Household PR-D R5b");
    const card = acct("r5b-mirror");
    const pendingId = await addTxn({ occurredOn: "2027-10-13", description: "TARGET 55219", amount: "-50.00", plaidAccountId: card, categoryId: null, pending: true });
    const r1 = await api("PATCH", `/transactions/${pendingId}`, { categoryId: auto });
    expect(r1.status).toBe(200);

    // Sync inserts the posted row bare, as always.
    const postedId = await addTxn({ occurredOn: "2027-10-14", description: "TARGET 55219", amount: "-55.00", plaidAccountId: card, categoryId: null });
    const bulk = await api("POST", "/transactions/bulk-update", {
      ids: [postedId],
      patch: { categoryId: household },
    });
    expect(bulk.status).toBe(200);
    expect((bulk.json as { updated: number }).updated).toBe(1);

    const d = await month("2027-10-01");
    expect(split(lineFor(d, household))).toMatchObject({ actual: "55.00" });
    expect(split(lineFor(d, auto))).toMatchObject({ actual: "0.00" });
    expect(await spendingTotal("2027-10-01", "2027-10-31", household)).toBe(55);
    expect(await spendingTotal("2027-10-01", "2027-10-31", auto)).toBe(0);
  });

  it("a bulk-update with only allowance flags does not set isTransferUserOverridden — same as a per-row PATCH", async () => {
    const card = acct("r5c-allowance-only");
    const id = await addTxn({ occurredOn: "2027-10-20", description: "CASEYS 5510", amount: "-12.00", plaidAccountId: card, categoryId: null });

    const bulk = await api("POST", "/transactions/bulk-update", {
      ids: [id],
      patch: { weeklyAllowance: true },
    });
    expect(bulk.status).toBe(200);
    expect((bulk.json as { updated: number }).updated).toBe(1);

    const [row] = await db
      .select({ v: transactionsTable.isTransferUserOverridden })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, id));
    expect(row!.v).toBe(false);
  });
});
