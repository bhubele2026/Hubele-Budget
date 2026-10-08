// ⭐ (V5) Honest debt words in the spine: `debt.confirmedPaymentsMtd` (gross
// confirmed payments this month) and `debt.newChargesMtd` (new charges on the
// debts' own accounts this month) — each equal to GET /debt-plan to the cent,
// and neither a balance nor available credit.
//
// Pinned now: Wed 2026-10-07 12:00 Central; the household month is 10/1–10/7.
// All figures are synthetic. Plaid sign: on a card, negative = a charge.
//
// Household A
//   Card One (credit, linked to the debt "Card One"):
//     10/02 GROCER −120.00 ............................ charge   ✓ 120.00
//     10/03 INTEREST CHARGE ON PURCHASES −15.25 ....... interest ✗
//     10/03 LATE FEE (BANK_FEES_LATE_PAYMENT) −29.00 .. fee      ✗
//     10/04 PAYMENT THANK YOU +200.00 ................. payment  ✗
//     10/05 STORE RETURN +30.00 ....................... credit   ✗ (not netted)
//     10/05 CAFE −55.00, pending ...................... pending  ✗
//     10/06 SAVINGS SWEEP −70.00, is_transfer ......... transfer ✗
//     09/30 BOOKSHOP −80.00 ........................... last month ✗
//     10/06 BALANCE TRANSFER PAYMENT +500.00 .......... payment  ✗
//   Card Two (credit, linked to the debt "Card Two"):
//     10/06 BALANCE TRANSFER −500.00 .................. half of a transfer pair with Card One's +500 ✗
//     10/06 HARDWARE −64.40 ........................... charge   ✓ 64.40
//   Loose card (credit, linked to no debt):
//     10/05 DINER −33.33, tagged to Card One .......... charge   ✓ 33.33
//     10/05 DINER −99.00, untagged .................... tied to no debt ✗
//   Workbook Amex rows (no account) — the household tracks "Amex Gold" by hand:
//     10/04 MARKET +45.10 (amex: positive = charge) ... charge   ✓ 45.10
//     10/04 INTEREST CHARGE +5.00 ..................... interest ✗
//   Checking (depository): 10/02 CARD ONE ONLINE PAYMENT −250.00 tagged to
//     Card One — a confirmed payment, never a charge.
//   A logged claim: "Payment — Card Two" +100.00 (manual, payment_state claimed) ✗
//   Card Two's liability ledger holds a 250.00 draw on 10/03 (a ledger event
//   with no transaction row): it pairs with the 250.00 checking payment, so that
//   payment is confirmed but not genuine — and, having no row, is no new charge.
//   → newChargesMtd = 120.00 + 64.40 + 33.33 + 45.10 = 262.83
//   → confirmedPaymentsMtd = 250.00 (gross) · paidDownMtd = 0.00 (genuine)
// Household B — one linked card with one charge of 77.00 this month.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { eq } from "drizzle-orm";

const A_OWNER = `v5-dw-a-${process.pid}-${randomUUID().slice(0, 8)}`;
const B_OWNER = `v5-dw-b-${process.pid}-${randomUUID().slice(0, 8)}`;
const HH: Record<string, { householdId: string; ownerUserId: string }> = {};

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { headers: Record<string, string | string[] | undefined>; userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    const who = String(req.headers["x-test-user"] ?? A_OWNER);
    req.userId = who;
    req.actualUserId = who;
    req.householdId = HH[who]!.householdId;
    req.householdOwnerId = HH[who]!.ownerUserId;
    next();
  },
}));

import { db, debtLedgerEventsTable, debtsTable, plaidAccountsTable, plaidItemsTable, transactionsTable } from "@workspace/db";
import spineRouter from "../routes/spine";
import debtPlanRouter from "../routes/debtPlan";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const NOW = new Date("2026-10-07T12:00:00-05:00");
const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(spineRouter);
app.use(debtPlanRouter);

let server: Server;
let baseUrl: string;
async function get<T = any>(p: string, as: string = A_OWNER): Promise<T> {
  const r = await fetch(`${baseUrl}${p}`, { headers: { "x-test-user": as } });
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

async function cleanup(): Promise<void> {
  for (const u of [A_OWNER, B_OWNER]) {
    await db.delete(transactionsTable).where(eq(transactionsTable.userId, u));
    await db.delete(debtsTable).where(eq(debtsTable.userId, u));
    await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, u));
    await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, u));
  }
}

async function seed(owner: string) {
  const hh = HH[owner]!.householdId;
  const base = { userId: owner, householdId: hh };
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ ...base, itemId: `item-${randomUUID()}`, accessToken: "test-token", institutionSlug: "bank" })
    .returning();
  const account = async (name: string, type: string) =>
    (
      await db
        .insert(plaidAccountsTable)
        .values({ ...base, itemId: item!.id, accountId: `acct-${name}-${randomUUID()}`, name, type })
        .returning()
    )[0]!;
  const debt = async (name: string, plaidAccountId: string | null) =>
    (
      await db
        .insert(debtsTable)
        .values({ ...base, name, balance: "1000.00", originalBalance: "2000.00", apr: "0.1999", minPayment: "40.00", status: "active", type: "credit", plaidAccountId })
        .returning()
    )[0]!.id;
  const tx = (occurredOn: string, description: string, amount: string, extra: Record<string, unknown>) => ({
    ...base,
    occurredOn,
    createdAt: createdAtStartOfHouseholdDay(occurredOn),
    description,
    amount,
    ...extra,
  });
  return { base, account, debt, tx };
}

beforeAll(async () => {
  vi.setSystemTime(NOW);
  HH[A_OWNER] = await createTestHousehold(A_OWNER);
  HH[B_OWNER] = await createTestHousehold(B_OWNER);
  await cleanup();

  // ── Household A
  {
    const { account, debt, tx } = await seed(A_OWNER);
    const checking = await account("checking", "depository");
    const one = await account("card-one", "credit");
    const two = await account("card-two", "credit");
    const loose = await account("loose", "credit");
    const CARD_ONE = await debt("Card One", one.id);
    const CARD_TWO = await debt("Card Two", two.id);
    await debt("Amex Gold", null);
    const on = (a: { accountId: string }, extra: Record<string, unknown> = {}) => ({ plaidAccountId: a.accountId, source: "plaid", ...extra });
    await db.insert(transactionsTable).values([
      tx("2026-10-02", "GROCER", "-120.00", on(one)),
      tx("2026-10-03", "INTEREST CHARGE ON PURCHASES", "-15.25", on(one)),
      tx("2026-10-03", "LATE FEE", "-29.00", on(one, { pfcDetailed: "BANK_FEES_LATE_PAYMENT" })),
      tx("2026-10-04", "PAYMENT THANK YOU", "200.00", on(one)),
      tx("2026-10-05", "STORE RETURN", "30.00", on(one)),
      tx("2026-10-05", "CAFE", "-55.00", on(one, { pending: true })),
      tx("2026-10-06", "SAVINGS SWEEP", "-70.00", on(one, { isTransfer: true })),
      tx("2026-09-30", "BOOKSHOP", "-80.00", on(one)),
      tx("2026-10-06", "BALANCE TRANSFER PAYMENT", "500.00", on(one)),
      tx("2026-10-06", "BALANCE TRANSFER", "-500.00", on(two)),
      tx("2026-10-06", "HARDWARE", "-64.40", on(two)),
      tx("2026-10-05", "DINER", "-33.33", on(loose, { debtId: CARD_ONE })),
      tx("2026-10-05", "DINER", "-99.00", on(loose)),
      tx("2026-10-04", "MARKET", "45.10", { source: "amex" }),
      tx("2026-10-04", "INTEREST CHARGE", "5.00", { source: "amex" }),
      tx("2026-10-02", "CARD ONE ONLINE PAYMENT", "-250.00", on(checking, { debtId: CARD_ONE, plaidTransactionId: `pt-${randomUUID()}` })),
      tx("2026-10-03", "Payment — Card Two", "100.00", { source: "manual", debtId: CARD_TWO, paymentState: "claimed" }),
    ]);
    await db.insert(debtLedgerEventsTable).values({
      householdId: HH[A_OWNER]!.householdId,
      debtId: CARD_TWO,
      transactionId: null,
      kind: "charge",
      amount: "250.00",
      occurredOn: "2026-10-03",
    });
  }
  // ── Household B
  {
    const { account, debt, tx } = await seed(B_OWNER);
    const card = await account("b-card", "credit");
    await debt("B Card", card.id);
    await db.insert(transactionsTable).values([tx("2026-10-03", "SHOP", "-77.00", { plaidAccountId: card.accountId, source: "plaid" })]);
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

describe("spine debt words (V5)", () => {
  it("newChargesMtd and confirmedPaymentsMtd, worked by hand", async () => {
    const spine = await get("/spine");
    expect(spine.debt.newChargesMtd).toBe(262.83);
    expect(spine.debt.confirmedPaymentsMtd).toBe(250);
    // Gross is not genuine: the 250.00 was moved from Card Two, not paid down.
    expect(spine.debt.paidDownMtd).toBe(0);
  });

  it("each equals GET /debt-plan to the cent (computeDebtHeadline is the one function)", async () => {
    const [spine, plan] = await Promise.all([get("/spine"), get("/debt-plan")]);
    expect(spine.debt.newChargesMtd).toBe(plan.newChargesMtd);
    expect(spine.debt.confirmedPaymentsMtd).toBe(plan.confirmedMtd);
    expect(spine.debt.paidDownMtd).toBe(plan.paidDownGenuineMtd);
  });

  it("household scoping: B reads only its own charge", async () => {
    const [spine, plan] = await Promise.all([get("/spine", B_OWNER), get("/debt-plan", B_OWNER)]);
    expect(spine.debt.newChargesMtd).toBe(77);
    expect(plan.newChargesMtd).toBe(77);
    expect(spine.debt.confirmedPaymentsMtd).toBe(0);
  });

  it("⚠️ the debt object names no balance, nothing owed, no credit and no limit", async () => {
    const spine = await get("/spine");
    expect(Object.keys(spine.debt)).toEqual(["payoffPct", "nextMilestone", "paidDownMtd", "confirmedPaymentsMtd", "newChargesMtd"]);
    for (const k of Object.keys(spine.debt)) expect(k).not.toMatch(/balance|owed|remaining|limit|credit|available/i);
    expect(JSON.stringify(spine.debt)).not.toMatch(/1000|2000/);
  });
});
