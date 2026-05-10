import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq } from "drizzle-orm";

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

vi.mock("../lib/plaidLiabilities", () => ({
  fetchLiabilitiesForItem: vi.fn(async () => []),
}));

import {
  db,
  debtsTable,
  debtBalanceHistoryTable,
  transactionsTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import debtsRouter from "../routes/debts";
import { createTestHousehold } from "./_helpers/testHousehold";

const app = express();
app.use(express.json());
app.use(debtsRouter);

let server: Server;
let baseUrl: string;

async function cleanup(): Promise<void> {
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(debtBalanceHistoryTable)
    .where(eq(debtBalanceHistoryTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
  await cleanup();
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await cleanup();
  await new Promise<void>((res) => server.close(() => res()));
});

beforeEach(cleanup);

type DebtBody = {
  id: string;
  balance: string;
  pendingPaymentTotal: string | null;
  pendingPaymentCount: number | null;
};

async function getDebt(id: string): Promise<DebtBody> {
  const list = (await fetch(`${baseUrl}/debts`).then((r) => r.json())) as DebtBody[];
  const found = list.find((d) => d.id === id);
  if (!found) throw new Error(`debt ${id} not in /debts response`);
  return found;
}

describe("(#421) pending tagged-payment decrement on debts API", () => {
  it("Plaid debt: tagged checking-account payment dated AFTER plaidLastSyncedAt is counted as pending", async () => {
    // Use a recent timestamp so GET /debts' opportunistic-refresh path (only
    // fires for debts >1h stale) skips this row and leaves our cutoff intact.
    const syncedAt = new Date(Date.now() - 30 * 60 * 1000);
    const txnAt1 = new Date(syncedAt.getTime() + 5 * 60 * 1000).toISOString();
    const txnAt2 = new Date(syncedAt.getTime() + 10 * 60 * 1000).toISOString();
    const oldTxnAt = new Date(syncedAt.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `item-${randomUUID()}`,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionName: "TestBank",
        institutionSlug: "testbank",
      })
      .returning();
    const [acct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: item!.id,
        accountId: `acct-${randomUUID()}`,
        name: "Visa",
        mask: "1111",
        type: "credit",
        subtype: "credit card",
        liabilityBalance: "1000.00",
      })
      .returning();
    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Visa",
        balance: "1000",
        apr: "0.2",
        minPayment: "25",
        plaidAccountId: acct!.id,
        balanceSource: "plaid",
        plaidLastSyncedAt: syncedAt,
        status: "active",
      })
      .returning();

    // Two payments AFTER the cutoff — both pending — and one BEFORE — already
    // baked into the reported balance, must NOT count.
    await db.insert(transactionsTable).values([
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: txnAt1.slice(0, 10),
        occurredAt: txnAt1,
        description: "Chase payment to Visa",
        amount: "200.00",
        debtId: debt!.id,
        source: "manual",
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: txnAt2.slice(0, 10),
        occurredAt: txnAt2,
        description: "Chase payment to Visa",
        amount: "50.00",
        debtId: debt!.id,
        source: "manual",
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: oldTxnAt.slice(0, 10),
        occurredAt: oldTxnAt,
        description: "Old payment",
        amount: "75.00",
        debtId: debt!.id,
        source: "manual",
      },
    ]);

    const body = await getDebt(debt!.id);
    expect(body.pendingPaymentCount).toBe(2);
    expect(Number(body.pendingPaymentTotal)).toBeCloseTo(250, 2);
    expect(Number(body.balance)).toBeCloseTo(1000, 2);
  });

  it("a fresh Plaid refresh advances the cutoff and clears pending automatically", async () => {
    // Recent sync so GET /debts' opportunistic refresh skips it and the
    // cutoff stays put until the explicit /refresh call below.
    const oldSync = new Date(Date.now() - 30 * 60 * 1000);
    const txnAt = new Date(oldSync.getTime() + 5 * 60 * 1000).toISOString();
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `item-${randomUUID()}`,
        accessToken: `access-sandbox-${randomUUID()}`,
        institutionName: "TestBank",
        institutionSlug: "testbank",
      })
      .returning();
    const [acct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: item!.id,
        accountId: `acct-${randomUUID()}`,
        name: "Visa",
        mask: "2222",
        type: "credit",
        subtype: "credit card",
        // Plaid now reports the post-payment balance (1000 - 200 = 800).
        liabilityBalance: "800.00",
      })
      .returning();
    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Visa",
        balance: "1000",
        apr: "0.2",
        minPayment: "25",
        plaidAccountId: acct!.id,
        balanceSource: "plaid",
        plaidLastSyncedAt: oldSync,
        status: "active",
      })
      .returning();
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: txnAt.slice(0, 10),
      occurredAt: txnAt,
      description: "Chase payment to Visa",
      amount: "200.00",
      debtId: debt!.id,
      source: "manual",
    });

    // Before refresh: pending should reflect the tagged $200.
    const pre = await getDebt(debt!.id);
    expect(pre.pendingPaymentCount).toBe(1);
    expect(Number(pre.pendingPaymentTotal)).toBeCloseTo(200, 2);

    // Refresh: applyLiabilityToDebt bumps plaidLastSyncedAt to "now" and the
    // creditor balance to 800. The 2026-04-05 payment is now <= cutoff, so
    // pending must be cleared automatically with no extra bookkeeping.
    const r = await fetch(`${baseUrl}/debts/${debt!.id}/refresh`, { method: "POST" });
    expect(r.status).toBe(200);
    const refreshed = (await r.json()) as DebtBody;
    expect(Number(refreshed.balance)).toBeCloseTo(800, 2);
    expect(refreshed.pendingPaymentTotal).toBeNull();
    expect(refreshed.pendingPaymentCount).toBeNull();

    // Subsequent GET /debts must agree.
    const post = await getDebt(debt!.id);
    expect(post.pendingPaymentTotal).toBeNull();
    expect(post.pendingPaymentCount).toBeNull();
  });

  it("manual debt: pending uses lastBalanceUpdate as the cutoff", async () => {
    const lastEdit = new Date("2026-04-15T08:00:00Z");
    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Manual Card",
        balance: "500",
        apr: "0.15",
        minPayment: "25",
        balanceSource: "manual",
        lastBalanceUpdate: lastEdit,
        status: "active",
      })
      .returning();
    await db.insert(transactionsTable).values([
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-04-20",
        occurredAt: "2026-04-20T10:00:00Z",
        description: "Payment",
        amount: "75.00",
        debtId: debt!.id,
        source: "manual",
      },
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-04-10",
        occurredAt: "2026-04-10T10:00:00Z",
        description: "Old payment baked in",
        amount: "40.00",
        debtId: debt!.id,
        source: "manual",
      },
    ]);

    const body = await getDebt(debt!.id);
    expect(body.pendingPaymentCount).toBe(1);
    expect(Number(body.pendingPaymentTotal)).toBeCloseTo(75, 2);
  });

  it("payments tagged to other debts and refunds (negative amounts) do not pollute pending", async () => {
    const [debtA] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Card A",
        balance: "500",
        apr: "0.1",
        minPayment: "25",
        balanceSource: "manual",
        lastBalanceUpdate: new Date("2026-04-01T00:00:00Z"),
        status: "active",
      })
      .returning();
    const [debtB] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Card B",
        balance: "200",
        apr: "0.1",
        minPayment: "10",
        balanceSource: "manual",
        lastBalanceUpdate: new Date("2026-04-01T00:00:00Z"),
        status: "active",
      })
      .returning();
    await db.insert(transactionsTable).values([
      // tagged to A
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-04-10",
        occurredAt: "2026-04-10T10:00:00Z",
        description: "to A",
        amount: "100.00",
        debtId: debtA!.id,
        source: "manual",
      },
      // tagged to B (must not bleed into A)
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-04-12",
        occurredAt: "2026-04-12T10:00:00Z",
        description: "to B",
        amount: "30.00",
        debtId: debtB!.id,
        source: "manual",
      },
      // untagged checking spend (no debtId) — must be ignored
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-04-13",
        occurredAt: "2026-04-13T10:00:00Z",
        description: "groceries",
        amount: "40.00",
        debtId: null,
        source: "manual",
      },
      // negative-amount refund tagged to A — not a payment-direction txn
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-04-14",
        occurredAt: "2026-04-14T10:00:00Z",
        description: "refund",
        amount: "-25.00",
        debtId: debtA!.id,
        source: "manual",
      },
    ]);

    const a = await getDebt(debtA!.id);
    const b = await getDebt(debtB!.id);
    expect(a.pendingPaymentCount).toBe(1);
    expect(Number(a.pendingPaymentTotal)).toBeCloseTo(100, 2);
    expect(b.pendingPaymentCount).toBe(1);
    expect(Number(b.pendingPaymentTotal)).toBeCloseTo(30, 2);
  });

  it("untagging a transaction (debtId -> null) drops it from pending", async () => {
    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Card",
        balance: "500",
        apr: "0.1",
        minPayment: "25",
        balanceSource: "manual",
        lastBalanceUpdate: new Date("2026-04-01T00:00:00Z"),
        status: "active",
      })
      .returning();
    const [txn] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-04-15",
        occurredAt: "2026-04-15T10:00:00Z",
        description: "Chase payment",
        amount: "120.00",
        debtId: debt!.id,
        source: "manual",
      })
      .returning();

    let body = await getDebt(debt!.id);
    expect(Number(body.pendingPaymentTotal)).toBeCloseTo(120, 2);

    await db
      .update(transactionsTable)
      .set({ debtId: null })
      .where(
        and(
          eq(transactionsTable.id, txn!.id),
          eq(transactionsTable.userId, TEST_USER),
        ),
      );

    body = await getDebt(debt!.id);
    expect(body.pendingPaymentTotal).toBeNull();
    expect(body.pendingPaymentCount).toBeNull();
  });

  it("a debt with no pending payments returns null fields (not 0/empty)", async () => {
    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Quiet Card",
        balance: "300",
        apr: "0.1",
        minPayment: "10",
        balanceSource: "manual",
        lastBalanceUpdate: new Date("2026-04-01T00:00:00Z"),
        status: "active",
      })
      .returning();
    const body = await getDebt(debt!.id);
    expect(body.pendingPaymentTotal).toBeNull();
    expect(body.pendingPaymentCount).toBeNull();
  });
});
