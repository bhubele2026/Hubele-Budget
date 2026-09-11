// (PR7) One spending rule, end to end: /reports/spending-facts and /spine read
// the same ledger through `classifyOutflow` and agree to the cent.
//
// Codex work-order point 7: "Buy $100 of groceries on a card and later pay
// $100 from checking. Household spending is $100. The app must never report
// $200 of spending."

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const TEST_USER = `pr7-card-payments-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
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

// The PATCH route never calls Plaid; make sure of it.
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
  mappingRulesTable,
  transactionsTable,
} from "@workspace/db";
import reportsRouter from "../routes/reports";
import spineRouter from "../routes/spine";
import transactionsRouter from "../routes/transactions";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(reportsRouter);
app.use(spineRouter);
app.use(transactionsRouter);

let server: Server;
let baseUrl: string;

// Thu 10/8/2026, noon Central: the week is Sun 10/4 – Sat 10/10.
const NOW = new Date("2026-10-08T12:00:00-05:00");
const WEEK = { from: "2026-10-04", to: "2026-10-10" };
const NEXT_WEEK = { from: "2026-10-11", to: "2026-10-17" };

type Facts = {
  householdSpend: { total: number; transactionCount: number };
  realSpend: { total: number; transactionCount: number };
  uncategorized: { total: number; transactionCount: number };
  unplanned: { total: number; transactionCount: number };
  excluded: {
    transfersTotal: number;
    debtPaymentsTotal: number;
    reimbursementTotal: number;
    ignoreTotal: number;
    cardPayments: number;
    reimbursable: number;
  };
};
type Spine = { spentWeek: number; spentMonth: number };

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${baseUrl}${path}`);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}
async function patch(path: string, body: unknown): Promise<number> {
  const r = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.status;
}
const facts = (w: { from: string; to: string }) =>
  get<Facts>(`/reports/spending-facts?from=${w.from}&to=${w.to}`);

async function cleanup(): Promise<void> {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(mappingRulesTable).where(eq(mappingRulesTable.userId, TEST_USER));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, TEST_USER));
}

const cat: Record<string, string> = {};

async function addTxn(row: Partial<typeof transactionsTable.$inferInsert> & {
  occurredOn: string;
  description: string;
  amount: string;
}): Promise<string> {
  const [t] = await db
    .insert(transactionsTable)
    .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, source: "plaid:chase", ...row })
    .returning({ id: transactionsTable.id });
  return t!.id;
}

async function readRow(id: string) {
  const [row] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, id));
  return row!;
}

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
  vi.setSystemTime(NOW);
  for (const [key, name] of [
    ["groceries", "Groceries"],
    ["misc", "Misc / Buffer"],
  ] as const) {
    const [c] = await db
      .insert(budgetCategoriesTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name, kind: "expense" })
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

describe("PR7 — a card payment is never spending twice", () => {
  let paymentId = "";

  it("Codex check: $100 of Amex groceries + a $100 card payment → spending $100, never $200", async () => {
    await addTxn({
      occurredOn: "2026-10-05",
      description: "WHOLE FOODS MARKET",
      amount: "-100.00",
      categoryId: cat.groceries,
      source: "plaid:amex",
    });
    paymentId = await addTxn({
      occurredOn: "2026-10-07",
      description: "CAPITAL ONE CRCARDPMT 5KX9",
      amount: "-100.00",
      categoryId: null,
    });

    const f = await facts(WEEK);
    expect(f.householdSpend).toEqual({ total: 100, transactionCount: 1 });
    expect(f.realSpend).toEqual({ total: 100, transactionCount: 1 });
    expect(f.uncategorized.total).toBe(0);
    expect(f.excluded.cardPayments).toBe(100);

    const spine = await get<Spine>("/spine");
    expect(spine.spentWeek).toBe(100);
    expect(spine.spentMonth).toBe(100);
  });

  it("(review H1) filing the card payment under a category by hand keeps it out of spending", async () => {
    // The Spending page's Recategorize popover and the Chase row picker send
    // exactly this; the route sets isTransferUserOverridden on the row.
    expect(await patch(`/transactions/${paymentId}`, { categoryId: cat.misc })).toBe(200);
    let row = await readRow(paymentId);
    expect(row.categoryId).toBe(cat.misc);
    expect(row.isTransferUserOverridden).toBe(true);

    let f = await facts(WEEK);
    expect(f.householdSpend).toEqual({ total: 100, transactionCount: 1 });
    expect(f.excluded.cardPayments).toBe(100);
    let spine = await get<Spine>("/spine");
    expect(spine.spentWeek).toBe(100);
    expect(spine.spentMonth).toBe(100);

    // Clearing the Transfer flag by hand sets the same flag; still a card payment.
    expect(await patch(`/transactions/${paymentId}`, { isTransfer: false })).toBe(200);
    f = await facts(WEEK);
    expect(f.householdSpend.total).toBe(100);
    spine = await get<Spine>("/spine");
    expect(spine.spentWeek).toBe(100);

    // Recognition is in totals only: the row itself was never re-tagged.
    row = await readRow(paymentId);
    expect(row.isTransfer).toBe(false);
    expect(row.isExternalCardPayment).toBe(false);
    expect(row.categoryId).toBe(cat.misc);
  });

  it("(review M1) the spine's spent week and month are household spending, uncategorized included", async () => {
    await addTxn({ occurredOn: "2026-10-06", description: "FARMERS MARKET", amount: "-12.34", categoryId: null });

    const f = await facts(WEEK);
    expect(f.householdSpend).toEqual({ total: 112.34, transactionCount: 2 });
    expect(f.realSpend.total).toBe(100);
    expect(f.uncategorized.total).toBe(12.34);

    const spine = await get<Spine>("/spine");
    expect(spine.spentWeek).toBe(f.householdSpend.total);
    expect(spine.spentWeek).not.toBe(f.realSpend.total);
    const month = await facts({ from: "2026-10-01", to: "2026-10-08" });
    expect(spine.spentMonth).toBe(month.householdSpend.total);
    expect(spine.spentMonth).not.toBe(month.realSpend.total);
    expect(spine.spentMonth).toBe(112.34);
  });

  it("the rest of the rule on one ledger: every outflow lands in exactly one bucket", async () => {
    const d = "2026-10-12";
    await addTxn({ occurredOn: d, description: "HY-VEE 1502", amount: "-60.00", categoryId: cat.groceries });
    await addTxn({ occurredOn: d, description: "FARMERS MARKET", amount: "-25.00", unplannedAllowance: true });
    await addTxn({ occurredOn: d, description: "HARDWARE", amount: "-10.00", categoryId: randomUUID() }); // category since deleted
    await addTxn({ occurredOn: d, description: "CLIENT DINNER", amount: "-40.00", categoryId: cat.groceries, source: "plaid:amex", reimbursable: true });
    await addTxn({ occurredOn: d, description: "PAYMENT 88231", amount: "-300.00", categoryId: cat.misc, pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" });
    await addTxn({ occurredOn: d, description: "APPLECARD GSBANK PAYMENT", amount: "-75.00", categoryId: cat.misc, unplannedAllowance: true });
    await addTxn({ occurredOn: d, description: "ONLINE TRANSFER TO SAV ...8801", amount: "-200.00", categoryId: cat.misc });

    const f = await facts(NEXT_WEEK);
    // 60 categorized + 25 uncategorized + 10 whose category is gone.
    expect(f.householdSpend).toEqual({ total: 95, transactionCount: 3 });
    expect(f.realSpend).toEqual({ total: 60, transactionCount: 1 });
    expect(f.uncategorized).toMatchObject({ total: 35, transactionCount: 2 });
    // A card payment tagged UN is still not a purchase.
    expect(f.unplanned).toMatchObject({ total: 25, transactionCount: 1 });
    expect(f.excluded).toEqual({
      transfersTotal: 200,
      debtPaymentsTotal: 0,
      reimbursementTotal: 0,
      ignoreTotal: 0,
      cardPayments: 375,
      reimbursable: 40,
      replacedPending: 0,
    });
    // Reconciles: 95 + 200 + 375 + 40 = 710, every dollar that left.
    const e = f.excluded;
    expect(
      f.householdSpend.total + e.transfersTotal + e.debtPaymentsTotal + e.reimbursementTotal +
        e.ignoreTotal + e.cardPayments + e.reimbursable,
    ).toBe(710);
  });
});
