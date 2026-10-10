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
  debtStatementsTable,
  transactionsTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import { addDaysISO } from "@workspace/avalanche-core";
import debtsRouter from "../routes/debts";
import { loadPendingPayments } from "../lib/debtPending";
import { householdDayOf, householdTodayISO } from "../lib/householdClock";
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
  liabilityAsOf: string | null;
  statement: { date: string; balance: string | null; minPayment: string | null; dueDate: string | null } | null;
};

/** A linked credit-card account on its own item; returns the plaid_accounts row id and external id. */
async function seedCard(opts: { mask: string; liabilityBalance?: string; liabilityLastFetchedAt?: Date | null }) {
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
  const externalId = `acct-${randomUUID()}`;
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      itemId: item!.id,
      accountId: externalId,
      name: "Visa",
      mask: opts.mask,
      type: "credit",
      subtype: "credit card",
      liabilityBalance: opts.liabilityBalance ?? "1000.00",
      liabilityLastFetchedAt: opts.liabilityLastFetchedAt ?? null,
    })
    .returning();
  return { rowId: acct!.id, externalId };
}

async function getDebt(id: string): Promise<DebtBody> {
  const list = (await fetch(`${baseUrl}/debts`).then((r) => r.json())) as DebtBody[];
  const found = list.find((d) => d.id === id);
  if (!found) throw new Error(`debt ${id} not in /debts response`);
  return found;
}

describe("(#421) pending tagged-payment decrement on debts API", () => {
  it("⭐ (WP2) Plaid debt: a payment dated AFTER the balance's as-of DAY is pending; one dated ON that day is not, whatever its time", async () => {
    // Recent, so GET /debts' opportunistic refresh (debts > 1 h stale) skips it.
    const syncedAt = new Date(Date.now() - 30 * 60 * 1000);
    const asOfDay = householdDayOf(syncedAt);
    const sameDayAfterSync = new Date(syncedAt.getTime() + 5 * 60 * 1000).toISOString();
    const card = await seedCard({ mask: "1111" });
    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Visa",
        balance: "1000",
        apr: "0.2",
        minPayment: "25",
        plaidAccountId: card.rowId,
        balanceSource: "plaid",
        plaidLastSyncedAt: syncedAt,
        status: "active",
      })
      .returning();

    await db.insert(transactionsTable).values([
      // The next two days: pending.
      { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, occurredOn: addDaysISO(asOfDay, 1), description: "Chase payment to Visa", amount: "200.00", debtId: debt!.id, source: "manual" },
      { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, occurredOn: addDaysISO(asOfDay, 2), description: "Chase payment to Visa", amount: "50.00", debtId: debt!.id, source: "manual" },
      // ⭐ THE AS-OF DAY ITSELF, timed AFTER the sync: in the balance. Before
      // WP2 its instant beat the cutoff and it was subtracted a second time.
      { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, occurredOn: asOfDay, occurredAt: sameDayAfterSync, description: "Same-day payment", amount: "300.00", debtId: debt!.id, source: "manual" },
      // Before the as-of day: in the balance.
      { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, occurredOn: addDaysISO(asOfDay, -1), description: "Old payment", amount: "75.00", debtId: debt!.id, source: "manual" },
    ]);

    const body = await getDebt(debt!.id);
    expect(body.pendingPaymentCount).toBe(2);
    expect(Number(body.pendingPaymentTotal)).toBeCloseTo(250, 2);
    expect(Number(body.balance)).toBeCloseTo(1000, 2);
    // The as-of the rule cut at is served with the debt (no liability fetch on file → the last refresh).
    expect(body.liabilityAsOf).toBe(syncedAt.toISOString());
  });

  it("a fresh Plaid refresh advances the as-of and clears pending automatically", async () => {
    // Synced two days ago: a payment dated yesterday is after that day.
    const oldSync = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const yesterday = addDaysISO(householdTodayISO(), -1);
    // Plaid now reports the post-payment balance (1000 - 200 = 800).
    const card = await seedCard({ mask: "2222", liabilityBalance: "800.00" });
    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        name: "Visa",
        balance: "1000",
        apr: "0.2",
        minPayment: "25",
        plaidAccountId: card.rowId,
        balanceSource: "plaid",
        plaidLastSyncedAt: oldSync,
        status: "active",
      })
      .returning();
    await db.insert(transactionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      occurredOn: yesterday,
      description: "Chase payment to Visa",
      amount: "200.00",
      debtId: debt!.id,
      source: "manual",
    });

    // Before the refresh (read directly: GET /debts would refresh this 2-day-old
    // debt first): the tagged $200 is pending.
    const pre = await loadPendingPayments(TEST_HOUSEHOLD_ID, [debt!]);
    expect(pre.get(debt!.id)).toEqual({ total: 200, count: 1 });

    // Refresh: applyLiabilityToDebt bumps plaidLastSyncedAt to "now" and the
    // creditor balance to 800. Yesterday's payment is now on or before the
    // as-of day, so pending clears with no extra bookkeeping.
    const r = await fetch(`${baseUrl}/debts/${debt!.id}/refresh`, { method: "POST" });
    expect(r.status).toBe(200);
    const refreshed = (await r.json()) as DebtBody;
    expect(Number(refreshed.balance)).toBeCloseTo(800, 2);
    expect(refreshed.pendingPaymentTotal).toBeNull();
    expect(refreshed.pendingPaymentCount).toBeNull();
    expect(new Date(refreshed.liabilityAsOf!).getTime()).toBeGreaterThan(oldSync.getTime());

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
      // (WP2) The edit's own day (Apr 15), timed after it: the day rule takes
      // it to be in the balance the household typed that day.
      {
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-04-15",
        occurredAt: "2026-04-15T10:00:00Z",
        description: "Same-day payment",
        amount: "30.00",
        debtId: debt!.id,
        source: "manual",
      },
    ]);

    const body = await getDebt(debt!.id);
    expect(body.pendingPaymentCount).toBe(1);
    expect(Number(body.pendingPaymentTotal)).toBeCloseTo(75, 2);
    expect(body.liabilityAsOf).toBe(lastEdit.toISOString());
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

  it("⭐ (WP2) a feed REFUND tagged by the old sync is not a payment; a feed payment is", async () => {
    const syncedAt = new Date(Date.now() - 30 * 60 * 1000);
    const next = addDaysISO(householdDayOf(syncedAt), 1);
    const card = await seedCard({ mask: "3333" });
    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Platinum", balance: "3842.98", apr: "0", minPayment: "85",
        plaidAccountId: card.rowId, balanceSource: "plaid", plaidLastSyncedAt: syncedAt, status: "active",
      })
      .returning();
    const feed = { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, occurredOn: next, debtId: debt!.id, source: "plaid:amex", plaidAccountId: card.externalId };
    await db.insert(transactionsTable).values([
      { ...feed, description: "ONLINE PAYMENT - THANK YOU", amount: "500.00", plaidTransactionId: `pt-pay-${randomUUID()}` },
      // Tagged to the debt, as the sync tagged every positive card row before WP2.
      { ...feed, description: "TARGET T-1123 REFUND", amount: "54.19", plaidTransactionId: `pt-ref-${randomUUID()}` },
    ]);
    const body = await getDebt(debt!.id);
    expect(body.pendingPaymentCount).toBe(1);
    expect(Number(body.pendingPaymentTotal)).toBeCloseTo(500, 2);
  });

  it("(WP2) a confirmed claim and its bank row count once — and a row that confirmed a claim never counts", async () => {
    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Card", balance: "900", apr: "0.1", minPayment: "25",
        balanceSource: "manual", lastBalanceUpdate: new Date("2026-04-01T15:00:00Z"), status: "active",
      })
      .returning();
    const base = { userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, debtId: debt!.id, occurredOn: "2026-04-05" };
    // The checking row the household tagged to the card, and the claim it confirmed (both money out).
    const [bank] = await db
      .insert(transactionsTable)
      .values({ ...base, description: "CARD EPAYMENT", amount: "-300.00", source: "plaid:chase", plaidTransactionId: `pt-bank-${randomUUID()}`, plaidAccountId: "chk-ext" })
      .returning();
    await db.insert(transactionsTable).values({
      ...base, description: "Payment — Card", amount: "-300.00", source: "manual", paymentState: "confirmed", confirmedByTxnId: bank!.id,
    });
    // The card's own feed row for that payment: the one pending figure.
    await db.insert(transactionsTable).values({
      ...base, description: "PAYMENT RECEIVED - THANK YOU", amount: "300.00", source: "plaid:visa", plaidTransactionId: `pt-card-${randomUUID()}`, plaidAccountId: "card-ext",
    });
    let body = await getDebt(debt!.id);
    expect(body.pendingPaymentCount).toBe(1);
    expect(Number(body.pendingPaymentTotal)).toBeCloseTo(300, 2);

    // A payment-shaped row that is a claim's confirming row is that claim's
    // payment: it never counts again (no real pairing makes such a row today —
    // claims pair with money out — so this pins the rule, not a live case).
    const [confirming] = await db
      .insert(transactionsTable)
      .values({ ...base, occurredOn: "2026-04-06", description: "ONLINE PAYMENT - THANK YOU", amount: "120.00", source: "plaid:visa", plaidTransactionId: `pt-conf-${randomUUID()}` })
      .returning();
    await db.insert(transactionsTable).values({
      ...base, occurredOn: "2026-04-06", description: "Payment — Card", amount: "-120.00", source: "manual", paymentState: "confirmed", confirmedByTxnId: confirming!.id,
    });
    body = await getDebt(debt!.id);
    expect(body.pendingPaymentCount).toBe(1);
    expect(Number(body.pendingPaymentTotal)).toBeCloseTo(300, 2);
  });

  it("(WP2) liabilityAsOf is the later of the liability fetch and the last Plaid refresh; statement is the newest on file", async () => {
    const syncedAt = new Date(Date.now() - 30 * 60 * 1000);
    const fetchedAt = new Date(Date.now() - 10 * 60 * 1000);
    const card = await seedCard({ mask: "4444", liabilityLastFetchedAt: fetchedAt });
    const [debt] = await db
      .insert(debtsTable)
      .values({
        userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "Platinum", balance: "3842.98", apr: "0", minPayment: "85",
        plaidAccountId: card.rowId, balanceSource: "plaid", plaidLastSyncedAt: syncedAt, status: "active",
      })
      .returning();
    const [quiet] = await db
      .insert(debtsTable)
      .values({ userId: TEST_USER, householdId: TEST_HOUSEHOLD_ID, name: "No statement", balance: "10", apr: "0", minPayment: "0", status: "active" })
      .returning();
    await db.insert(debtStatementsTable).values([
      { householdId: TEST_HOUSEHOLD_ID, debtId: debt!.id, statementDate: "2026-08-27", statementBalance: "2500.00", minPayment: "75.00", dueDate: "2026-09-22", source: "plaid" },
      { householdId: TEST_HOUSEHOLD_ID, debtId: debt!.id, statementDate: "2026-09-27", statementBalance: "2980.44", minPayment: "85.00", dueDate: "2026-10-22", source: "plaid" },
    ]);
    const body = await getDebt(debt!.id);
    expect(body.liabilityAsOf).toBe(fetchedAt.toISOString());
    expect(body.statement).toEqual({ date: "2026-09-27", balance: "2980.44", minPayment: "85.00", dueDate: "2026-10-22" });
    // The current balance is not the statement: two different figures, both served.
    expect(body.balance).toBe("3842.98");
    const none = await getDebt(quiet!.id);
    expect(none.statement).toBeNull();
    expect(none.liabilityAsOf).toBeNull();
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
