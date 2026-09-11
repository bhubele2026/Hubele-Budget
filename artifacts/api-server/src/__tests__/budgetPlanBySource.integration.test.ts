import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `test-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

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
import budgetRouter from "../routes/budget";
import { archiveExpiredOneTime } from "../lib/billsSummary";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(budgetRouter);

let server: Server;
let baseUrl: string;
const MONTH = "2026-06-01"; // 30 days ⇒ weeksInMonth = 4.29

type Bucket = { planned: string; actual: string; lineCount: number };
type Detail = {
  lines: Array<{
    categoryId: string;
    categoryName: string;
    plannedAmount: string;
    actualAmount: string;
    sourceKind: string;
    planSource: "income" | "bills" | "debts" | "unbacked";
  }>;
  planBySource: {
    income: Bucket;
    bills: Bucket;
    debts: Bucket;
    unbacked: Bucket;
    plannedTotal: string;
    actualTotal: string;
    net: string;
  };
  allowance: {
    lines: Array<{
      bucket: string;
      planned: string;
      actual: string;
      count: number;
      subBuckets: Array<{ bucket: string; actual: string; count: number }>;
    }>;
    planned: string;
    actual: string;
    weeksInMonth: string;
  };
};

const fetchMonth = async (): Promise<Detail> => {
  const res = await fetch(`${baseUrl}/budget/months/${MONTH}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Detail;
};

const lineNamed = (d: Detail, name: string) => {
  const l = d.lines.find((x) => x.categoryName === name);
  if (!l) throw new Error(`line not found: ${name}`);
  return l;
};

const catId = async (name: string): Promise<string> => {
  const rows = await db
    .select()
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, TEST_USER));
  const c = rows.find((r) => r.name === name);
  if (!c) throw new Error(`category not found: ${name}`);
  return c.id;
};

beforeAll(async () => {
  const h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = h.householdId;
  await new Promise<void>((resolve) => {
    server = createServer(app).listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  await fetch(`${baseUrl}/budget/seed-defaults`, { method: "POST" });

  // Keep the May-2026 reconciliation flag out of the way, and set allowance
  // caps we can recognise in the response.
  await db
    .insert(settingsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      preferences: { budgetMay2026AmountsV1: true },
      weeklyAllowanceAmount: "100.00",
      monthlyAllowanceAmount: "250.00",
      unplannedAllowanceAmount: "0.00",
    })
    .onConflictDoUpdate({
      target: settingsTable.userId,
      set: {
        preferences: { budgetMay2026AmountsV1: true },
        weeklyAllowanceAmount: "100.00",
        monthlyAllowanceAmount: "250.00",
        unplannedAllowanceAmount: "0.00",
      },
    });

  // One controlled bill, pointed at a curated envelope — the shape that makes
  // bill-backing beat `sourceKind`.
  await db
    .delete(recurringItemsTable)
    .where(eq(recurringItemsTable.userId, TEST_USER));
  await db.insert(recurringItemsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    name: "MGE Electric & Gas",
    kind: "bill",
    amount: "175.00",
    frequency: "monthly",
    dayOfMonth: 10,
    categoryId: await catId("Utilities"),
  });
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /budget/months/:m — planSource", () => {
  it("⚠️ calls a bill-backed MANUAL envelope `bills`, not `unbacked`", async () => {
    // `Utilities` is sourceKind "manual" and always has been — expense bills
    // are pointed at curated envelopes rather than spawning their own
    // categories. If this classified on sourceKind alone the plan would be
    // empty on real data.
    const d = await fetchMonth();
    const utilities = lineNamed(d, "Utilities");
    expect(utilities.sourceKind).toBe("manual");
    expect(utilities.planSource).toBe("bills");
    expect(utilities.plannedAmount).toBe("175.00");
  });

  it("calls a manual envelope with no bill `unbacked`", async () => {
    const d = await fetchMonth();
    // Seeded envelopes with nothing recurring behind them.
    expect(lineNamed(d, "Groceries").planSource).toBe("unbacked");
    expect(lineNamed(d, "Dining & Coffee").planSource).toBe("unbacked");
  });

  it("calls the paycheck categories `income`", async () => {
    const d = await fetchMonth();
    expect(lineNamed(d, "Hannah's paycheck (Exact)").planSource).toBe("income");
  });

  it("calls an active debt's minimum `debts`", async () => {
    await db.insert(debtsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Upstart",
      balance: "4200.00",
      apr: "19.90",
      minPayment: "212.00",
    });
    const d = await fetchMonth();
    const upstart = lineNamed(d, "Upstart");
    expect(upstart.sourceKind).toBe("auto_debts");
    expect(upstart.planSource).toBe("debts");
    expect(upstart.plannedAmount).toBe("212.00");
  });

  it("gives every line exactly one source", async () => {
    const d = await fetchMonth();
    const allowed = new Set(["income", "bills", "debts", "unbacked"]);
    for (const l of d.lines) expect(allowed.has(l.planSource)).toBe(true);
  });
});

describe("GET /budget/months/:m — planBySource", () => {
  it("⭐ plannedTotal is bills + debts and EXCLUDES the hand-planned envelopes", async () => {
    const d = await fetchMonth();
    const p = d.planBySource;
    const sum = (key: Detail["lines"][number]["planSource"]) =>
      d.lines
        .filter((l) => l.planSource === key)
        .reduce((a, l) => a + parseFloat(l.plannedAmount), 0)
        .toFixed(2);

    expect(p.bills.planned).toBe(sum("bills"));
    expect(p.debts.planned).toBe(sum("debts"));
    expect(p.unbacked.planned).toBe(sum("unbacked"));
    expect(p.plannedTotal).toBe(
      (parseFloat(p.bills.planned) + parseFloat(p.debts.planned)).toFixed(2),
    );
    // The load-bearing assertion: the unbacked money is reported and is NOT
    // in the total. On real data that difference is Groceries + Dining, whose
    // money is already committed as the Weekly Spend bill.
    expect(parseFloat(p.unbacked.planned)).toBeGreaterThan(0);
    expect(parseFloat(p.plannedTotal)).toBeLessThan(
      parseFloat(p.bills.planned) +
        parseFloat(p.debts.planned) +
        parseFloat(p.unbacked.planned),
    );
  });

  it("nets planned income against the plan", async () => {
    const d = await fetchMonth();
    const p = d.planBySource;
    expect(p.net).toBe(
      (parseFloat(p.income.planned) - parseFloat(p.plannedTotal)).toFixed(2),
    );
  });

  it("counts the lines it summed", async () => {
    const d = await fetchMonth();
    const p = d.planBySource;
    const n = (key: string) => d.lines.filter((l) => l.planSource === key).length;
    expect(p.bills.lineCount).toBe(n("bills"));
    expect(p.unbacked.lineCount).toBe(n("unbacked"));
    expect(p.debts.lineCount).toBe(n("debts"));
    expect(p.income.lineCount).toBe(n("income"));
  });
});

describe("GET /budget/months/:m — allowance", () => {
  it("returns all three buckets with the caps from settings, weekly scaled to the month", async () => {
    const d = await fetchMonth();
    const by = Object.fromEntries(d.allowance.lines.map((l) => [l.bucket, l]));
    expect(d.allowance.weeksInMonth).toBe("4.29"); // June: 30 / 7
    expect(by.weekly!.planned).toBe((100 * (30 / 7)).toFixed(2));
    expect(by.monthly!.planned).toBe("250.00");
    expect(by.unplanned!.planned).toBe("0.00");
  });

  it("⚠️ counts only spend the user FILED into a bucket — unmarked counts nowhere", async () => {
    const cat = await catId("Groceries");
    await db.insert(transactionsTable).values([
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        description: "COSTCO",
        amount: "-120.00",
        occurredOn: "2026-06-04",
        source: "plaid:chase",
        categoryId: cat,
        weeklyAllowance: true,
        weeklyBucket: "groceries",
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        description: "UNFILED SPEND",
        amount: "-500.00",
        occurredOn: "2026-06-05",
        source: "plaid:chase",
        categoryId: cat,
      },
    ]);
    const d = await fetchMonth();
    const weekly = d.allowance.lines.find((l) => l.bucket === "weekly")!;
    expect(weekly.actual).toBe("120.00");
    expect(d.allowance.actual).toBe("120.00");
  });

  it("⚠️ the five weekly slices sum to the weekly figure above them", async () => {
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      description: "GAS STATION SNACK",
      amount: "-15.00",
      occurredOn: "2026-06-06",
      source: "plaid:chase",
      weeklyAllowance: true,
      // deliberately NO weeklyBucket — it must still land somewhere
    });
    const d = await fetchMonth();
    const weekly = d.allowance.lines.find((l) => l.bucket === "weekly")!;
    const slices = weekly.subBuckets.reduce(
      (a, s) => a + parseFloat(s.actual),
      0,
    );
    expect(weekly.actual).toBe("135.00");
    expect(slices.toFixed(2)).toBe("135.00");
    expect(
      weekly.subBuckets.find((s) => s.bucket === "misc")!.actual,
    ).toBe("15.00");
  });

  it("excludes transfers, card payments, reimbursables and debt payments", async () => {
    await db.insert(transactionsTable).values([
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        description: "TRANSFER",
        amount: "-900.00",
        occurredOn: "2026-06-07",
        source: "plaid:chase",
        weeklyAllowance: true,
        isTransfer: true,
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        description: "AMEX PAYMENT",
        amount: "-800.00",
        occurredOn: "2026-06-08",
        source: "plaid:chase",
        weeklyAllowance: true,
        isExternalCardPayment: true,
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        description: "WORK LUNCH, BEING REIMBURSED",
        amount: "-70.00",
        occurredOn: "2026-06-09",
        source: "plaid:chase",
        weeklyAllowance: true,
        reimbursable: true,
      },
    ]);
    const d = await fetchMonth();
    const weekly = d.allowance.lines.find((l) => l.bucket === "weekly")!;
    // Unchanged from the previous assertion — none of the three counted.
    expect(weekly.actual).toBe("135.00");
  });
});

describe("(PR6) a one-time bill the archive now keeps active", () => {
  it("adds nothing to the plan: planBySource and its line are what they were when such a bill was archived", async () => {
    // Before PR6 `archiveExpiredOneTime` set a one-time bill inactive the day
    // after its date, so the Budget page never counted it. PR6 keeps an
    // unresolved one active for 60 days for the forecast; `isPastOneTime`
    // keeps it out of the plan exactly as before.
    vi.setSystemTime(new Date("2026-06-20T17:00:00Z")); // Date only; the server's timers stay real
    let billId: string | undefined;
    try {
      const before = await fetchMonth();
      const [row] = await db
        .insert(recurringItemsTable)
        .values({
          userId: TEST_USER,
          householdId: TEST_HOUSEHOLD_ID,
          name: "Furnace repair",
          kind: "bill",
          amount: "640.00",
          frequency: "onetime",
          anchorDate: "2026-06-15",
          categoryId: await catId("Utilities"),
        })
        .returning();
      billId = row!.id;
      await archiveExpiredOneTime(TEST_HOUSEHOLD_ID);
      const [stored] = await db.select().from(recurringItemsTable).where(eq(recurringItemsTable.id, billId));
      expect(stored!.active).toBe("true"); // 5 days overdue, unresolved: kept for the forecast

      const after = await fetchMonth();
      expect(after.planBySource).toEqual(before.planBySource);
      expect(lineNamed(after, "Utilities").plannedAmount).toBe(lineNamed(before, "Utilities").plannedAmount);
    } finally {
      if (billId) await db.delete(recurringItemsTable).where(eq(recurringItemsTable.id, billId));
      vi.useRealTimers();
    }
  });
});
