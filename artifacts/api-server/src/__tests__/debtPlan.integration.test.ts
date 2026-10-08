// (PR-D) The debt plan against a real Postgres: payment claims confirmed by
// bank rows (and the cash rule counting that payment once), the liability
// ledger, daily progress snapshots, insert-only milestones, statements, and
// GET /debt-plan's shape, household isolation and no-balance law.
//
// Synthetic data only.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

const OWNER = `prd-owner-${process.pid}-${randomUUID().slice(0, 8)}`;
const OTHER = `prd-other-${process.pid}-${randomUUID().slice(0, 8)}`;
let HH = "";
let HH_OTHER = "";
let current = { user: OWNER, hh: () => HH };

process.env.OWNER_EMAIL = "owner@example.com";

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = current.user;
    req.actualUserId = current.user;
    req.householdId = current.hh();
    req.householdOwnerId = current.user;
    next();
  },
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: async (userId: string) => ({
        id: userId,
        primaryEmailAddressId: "e1",
        emailAddresses: [{ id: "e1", emailAddress: userId === OWNER ? "owner@example.com" : "member@example.com" }],
      }),
    },
  },
}));

import {
  db,
  avalancheSettingsTable,
  debtBalanceHistoryTable,
  debtLedgerEventsTable,
  debtMilestonesTable,
  debtProgressSnapshotsTable,
  debtStatementsTable,
  debtsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { addDaysISO, payoffPct } from "@workspace/avalanche-core";
import express from "express";
import debtsRouter from "../routes/debts";
import debtPlanRouter from "../routes/debtPlan";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";
import { computeCashSignal } from "../lib/cashSignal";
import { confirmDebtPaymentClaims } from "../lib/debtPaymentConfirm";
import { recordDebtStatements, syncDebtLedgerEvents } from "../lib/debtLedger";
import { writeAchievedMilestones, writeDebtProgressSnapshots } from "../lib/debtProgressSnapshot";
import { withPendingPayments } from "../lib/debtPending";
import { householdTodayISO } from "../lib/householdClock";

const router = express.Router();
router.use(debtsRouter);
router.use(debtPlanRouter);
const { request } = createTestApp(router);

const TODAY = householdTodayISO();
const SNAP_DAY = addDaysISO(TODAY, -10);
const CHECKING = `chk-${randomUUID()}`;
const CARD = `card-${randomUUID()}`;
let checkingId = "";
let cardAcctId = "";

async function wipe(householdId: string): Promise<void> {
  await db.delete(debtMilestonesTable).where(eq(debtMilestonesTable.householdId, householdId));
  await db.delete(debtProgressSnapshotsTable).where(eq(debtProgressSnapshotsTable.householdId, householdId));
  await db.delete(debtLedgerEventsTable).where(eq(debtLedgerEventsTable.householdId, householdId));
  await db.delete(debtStatementsTable).where(eq(debtStatementsTable.householdId, householdId));
  await db.update(transactionsTable).set({ confirmedByTxnId: null }).where(eq(transactionsTable.householdId, householdId));
  await db.delete(transactionsTable).where(eq(transactionsTable.householdId, householdId));
  await db.delete(debtBalanceHistoryTable).where(eq(debtBalanceHistoryTable.householdId, householdId));
  await db.delete(debtsTable).where(eq(debtsTable.householdId, householdId));
  await db.delete(avalancheSettingsTable).where(eq(avalancheSettingsTable.householdId, householdId));
}

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
  HH_OTHER = (await createTestHousehold(OTHER)).householdId;
  await wipe(HH);
  await wipe(HH_OTHER);
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.householdId, HH));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.householdId, HH));
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ userId: OWNER, householdId: HH, itemId: `item-${randomUUID()}`, accessToken: "test-token", institutionSlug: "bank" })
    .returning();
  const [chk] = await db
    .insert(plaidAccountsTable)
    .values({ userId: OWNER, householdId: HH, itemId: item!.id, accountId: CHECKING, name: "Checking", type: "depository", subtype: "checking" })
    .returning();
  const [card] = await db
    .insert(plaidAccountsTable)
    .values({ userId: OWNER, householdId: HH, itemId: item!.id, accountId: CARD, name: "Visa Feed", type: "credit", subtype: "credit card" })
    .returning();
  checkingId = chk!.id;
  cardAcctId = card!.id;
  await db.insert(forecastSettingsTable).values({
    userId: OWNER,
    householdId: HH,
    daysAhead: 90,
    cashBuffer: "500.00",
    bankSnapshotBalance: "5000.00",
    bankSnapshotAt: new Date(`${SNAP_DAY}T12:00:00-05:00`),
    bankSnapshotSource: "manual",
    bankSnapshotAccountId: checkingId,
  });
});

beforeEach(async () => {
  current = { user: OWNER, hh: () => HH };
  await wipe(HH);
  await wipe(HH_OTHER);
});

afterAll(async () => {
  await wipe(HH);
  await wipe(HH_OTHER);
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, OWNER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.householdId, HH));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.householdId, HH));
});

async function addDebt(o: Partial<typeof debtsTable.$inferInsert> & { name: string }, hh = HH, user = OWNER) {
  const [d] = await db
    .insert(debtsTable)
    .values({ userId: user, householdId: hh, balance: "3000.00", originalBalance: "5000.00", apr: "0.2249", minPayment: "85.00", type: "credit_card", ...o })
    .returning();
  return d!;
}

async function addTxn(o: Partial<typeof transactionsTable.$inferInsert> & { occurredOn: string; amount: string }) {
  const [t] = await db
    .insert(transactionsTable)
    .values({ userId: OWNER, householdId: HH, description: "ROW", source: "plaid:bank", plaidAccountId: CHECKING, ...o })
    .returning();
  return t!;
}

async function claimRow(id: string) {
  const [t] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, id));
  return t!;
}

async function bankToday(): Promise<number> {
  return Number((await computeCashSignal(HH, OWNER, { horizonDays: 90 })).bankToday);
}

describe("payment claims → confirmed by a bank row", () => {
  it("POST /debts/:id/payments writes a CLAIM and lowers the balance exactly as before", async () => {
    const visa = await addDebt({ name: "Visa" });
    const r = await request("POST", `/debts/${visa.id}/payments`, { amount: "250.00", occurredOn: TODAY });
    expect(r.status).toBe(201);
    const body = r.json as { debt: { balance: string }; transaction: { paymentState: string; debtId: string; amount: string } };
    expect(body.debt.balance).toBe("2750.00");
    expect(body.transaction).toMatchObject({ paymentState: "claimed", debtId: visa.id, amount: "-250.00" });
  });

  it("⭐ a bank row tagged to the debt confirms it — and cash counts the 250.00 once, not twice", async () => {
    const visa = await addDebt({ name: "Visa" });
    const before0 = await bankToday();
    expect(before0).toBe(5000);
    await request("POST", `/debts/${visa.id}/payments`, { amount: "250.00", occurredOn: TODAY });
    const claimedOnly = await bankToday();
    expect(claimedOnly).toBe(4750); // the claim alone: the payment, once
    // The bank's own debit arrives (a sync would run the pass; run it by hand).
    const bank = await addTxn({ occurredOn: addDaysISO(TODAY, -1), amount: "-250.00", description: "VISA ONLINE PMT", debtId: visa.id });
    // Pre-PR-D shape: both rows count — the same payment left cash twice.
    expect(await bankToday()).toBe(4500);
    const r = await confirmDebtPaymentClaims(HH);
    expect(r.confirmed).toHaveLength(1);
    expect(r.confirmed[0]).toMatchObject({ bankTxnId: bank.id, evidence: "debt_tag" });
    const [claim] = await db
      .select()
      .from(transactionsTable)
      .where(and(eq(transactionsTable.householdId, HH), eq(transactionsTable.paymentState, "confirmed")));
    expect(claim!.confirmedByTxnId).toBe(bank.id);
    // Confirmed: the bank row is the payment; the claim adds 0. +250.00 back,
    // never above the bank — the bank row still counts.
    expect(await bankToday()).toBe(4750);
  });

  it("logging a payment whose bank row is already in confirms it at once", async () => {
    const visa = await addDebt({ name: "Visa" });
    const bank = await addTxn({ occurredOn: TODAY, amount: "-120.00", description: "VISA PMT", debtId: visa.id });
    const r = await request("POST", `/debts/${visa.id}/payments`, { amount: "120.00", occurredOn: TODAY });
    const body = r.json as { transaction: { paymentState: string; confirmedByTxnId: string } };
    expect(body.transaction).toMatchObject({ paymentState: "confirmed", confirmedByTxnId: bank.id });
  });

  it("card-payment evidence: an untagged bank row that names the card", async () => {
    const disc = await addDebt({ name: "Discover" });
    const bank = await addTxn({
      occurredOn: addDaysISO(TODAY, -3),
      amount: "-310.00",
      description: "DISCOVER E-PAYMENT 4412",
      pfcDetailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
    });
    const claim = await addTxn({ occurredOn: TODAY, amount: "-310.00", source: "manual", plaidAccountId: null, debtId: disc.id, paymentState: "claimed", description: "Payment — Discover" });
    const r = await confirmDebtPaymentClaims(HH);
    expect(r.confirmed).toEqual([{ claimId: claim.id, bankTxnId: bank.id, evidence: "card_payment" }]);
  });

  it("no match: out of tolerance, more than 10 days, tagged to another debt, a card row", async () => {
    const visa = await addDebt({ name: "Visa" });
    const other = await addDebt({ name: "Car loan", type: "loan" });
    const claim = await addTxn({ occurredOn: TODAY, amount: "-250.00", source: "manual", plaidAccountId: null, debtId: visa.id, paymentState: "claimed" });
    await addTxn({ occurredOn: TODAY, amount: "-247.40", debtId: visa.id }); // gap 2.60 > max($1, 1%) = 2.50
    await addTxn({ occurredOn: addDaysISO(TODAY, -11), amount: "-250.00", debtId: visa.id }); // 11 days
    await addTxn({ occurredOn: TODAY, amount: "-250.00", debtId: other.id }); // another debt's tag
    await addTxn({ occurredOn: TODAY, amount: "-250.00", debtId: visa.id, plaidAccountId: CARD, source: "plaid:visa" }); // not a bank row
    const r = await confirmDebtPaymentClaims(HH);
    expect(r.confirmed).toEqual([]);
    expect((await claimRow(claim.id)).paymentState).toBe("claimed");
  });

  it("two candidates → the closest; the edge of tolerance ($1 or 1%) still pairs", async () => {
    const visa = await addDebt({ name: "Visa" });
    const claim = await addTxn({ occurredOn: TODAY, amount: "-250.00", source: "manual", plaidAccountId: null, debtId: visa.id, paymentState: "claimed" });
    await addTxn({ occurredOn: addDaysISO(TODAY, -6), amount: "-250.00", debtId: visa.id });
    const near = await addTxn({ occurredOn: addDaysISO(TODAY, -2), amount: "-247.50", debtId: visa.id });
    const r = await confirmDebtPaymentClaims(HH);
    expect(r.confirmed).toEqual([{ claimId: claim.id, bankTxnId: near.id, evidence: "debt_tag" }]);
  });

  it("a bank row confirms at most one claim; a claim whose bank row is deleted is a claim again", async () => {
    const visa = await addDebt({ name: "Visa" });
    const c1 = await addTxn({ occurredOn: TODAY, amount: "-80.00", source: "manual", plaidAccountId: null, debtId: visa.id, paymentState: "claimed" });
    await addTxn({ occurredOn: addDaysISO(TODAY, -1), amount: "-80.00", source: "manual", plaidAccountId: null, debtId: visa.id, paymentState: "claimed" });
    const bank = await addTxn({ occurredOn: TODAY, amount: "-80.00", debtId: visa.id });
    const r = await confirmDebtPaymentClaims(HH);
    expect(r.confirmed).toHaveLength(1);
    expect(r.confirmed[0]!.claimId).toBe(c1.id); // same day beats a day apart
    await db.delete(transactionsTable).where(eq(transactionsTable.id, bank.id));
    const again = await confirmDebtPaymentClaims(HH);
    expect(again.reverted).toBe(1);
    expect((await claimRow(c1.id)).paymentState).toBe("claimed");
  });

  it("payoffPct does not move when a claim is confirmed (no raw tag is replaced)", async () => {
    const visa = await addDebt({ name: "Visa" });
    await request("POST", `/debts/${visa.id}/payments`, { amount: "250.00", occurredOn: TODAY });
    const pct = async () =>
      payoffPct(await withPendingPayments(HH, await db.select().from(debtsTable).where(eq(debtsTable.householdId, HH))));
    const before = await pct();
    await addTxn({ occurredOn: TODAY, amount: "-250.00", debtId: visa.id });
    await confirmDebtPaymentClaims(HH);
    expect(await pct()).toBe(before);
  });
});

describe("the liability ledger", () => {
  it("classifies the card's own rows, idempotently; pending rows wait; a deleted row takes its event", async () => {
    const visa = await addDebt({ name: "Visa Feed", plaidAccountId: cardAcctId, balanceSource: "plaid" });
    const day = addDaysISO(TODAY, -4);
    const rows = await Promise.all([
      addTxn({ occurredOn: day, amount: "-84.12", plaidAccountId: CARD, source: "plaid:visa", description: "GROCERY 12", plaidTransactionId: `p-${randomUUID()}` }),
      addTxn({ occurredOn: day, amount: "500.00", plaidAccountId: CARD, source: "plaid:visa", description: "PAYMENT THANK YOU", plaidTransactionId: `p-${randomUUID()}` }),
      addTxn({ occurredOn: day, amount: "-61.22", plaidAccountId: CARD, source: "plaid:visa", description: "INTEREST", pfcDetailed: "BANK_FEES_INTEREST_CHARGE", plaidTransactionId: `p-${randomUUID()}` }),
      addTxn({ occurredOn: day, amount: "-9.99", plaidAccountId: CARD, source: "plaid:visa", description: "PENDING CAFE", pending: true, plaidTransactionId: `p-${randomUUID()}` }),
      addTxn({ occurredOn: day, amount: "-40.00", description: "CHECKING ROW", plaidTransactionId: `p-${randomUUID()}` }),
    ]);
    const first = await syncDebtLedgerEvents(HH);
    expect(first.written).toBe(3);
    const second = await syncDebtLedgerEvents(HH, { plaidTransactionIds: rows.map((r) => r.plaidTransactionId!) });
    expect(second.written).toBe(3);
    const events = await db.select().from(debtLedgerEventsTable).where(eq(debtLedgerEventsTable.householdId, HH));
    expect(events.map((e) => `${e.kind}:${e.amount}`).sort()).toEqual(["charge:84.12", "interest:61.22", "payment:500.00"]);
    expect(new Set(events.map((e) => e.debtId))).toEqual(new Set([visa.id]));
    await db.delete(transactionsTable).where(eq(transactionsTable.id, rows[0]!.id));
    const after = await db.select().from(debtLedgerEventsTable).where(eq(debtLedgerEventsTable.householdId, HH));
    expect(after).toHaveLength(2);
  });

  it("statement facts upsert one row per debt per statement date", async () => {
    const visa = await addDebt({ name: "Visa Feed", plaidAccountId: cardAcctId });
    const fact = { accountId: CARD, statementDate: "2026-09-15", statementBalance: 3120.4, minPayment: 85, dueDate: "2026-10-10" };
    expect(await recordDebtStatements(HH, [fact])).toBe(1);
    expect(await recordDebtStatements(HH, [{ ...fact, minPayment: 90 }])).toBe(1);
    expect(await recordDebtStatements(HH, [{ ...fact, accountId: "unlinked" }, { ...fact, statementDate: null }])).toBe(0);
    const rows = await db.select().from(debtStatementsTable).where(eq(debtStatementsTable.debtId, visa.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ statementBalance: "3120.40", minPayment: "90.00", dueDate: "2026-10-10", source: "plaid" });
  });
});

describe("daily progress snapshots", () => {
  async function history(debtId: string, day: string, balance: string) {
    await db.insert(debtBalanceHistoryTable).values({ userId: OWNER, householdId: HH, debtId, recordedOn: day, balance });
  }

  it("split a feed debt's day to the cent, upsert idempotently, and mark a transfer pair", async () => {
    const D = addDaysISO(TODAY, -2);
    const feed = await addDebt({ name: "Visa Feed", plaidAccountId: cardAcctId, balance: "4645.34" });
    const manual = await addDebt({ name: "Store card", balance: "1500.00", originalBalance: "3000.00" });
    await history(feed.id, addDaysISO(D, -1), "5000.00");
    await history(manual.id, addDaysISO(D, -1), "3000.00");
    await history(manual.id, D, "1500.00");
    const mk = (o: Partial<typeof transactionsTable.$inferInsert> & { amount: string; description: string }) =>
      addTxn({ occurredOn: D, plaidAccountId: CARD, source: "plaid:visa", plaidTransactionId: `p-${randomUUID()}`, ...o });
    await mk({ amount: "-84.12", description: "GROCERY" });
    await mk({ amount: "500.00", description: "PAYMENT THANK YOU" });
    await mk({ amount: "-61.22", description: "INTEREST CHARGE" });
    // A 1,500 cash advance on the feed card paid the store card: a transfer.
    const draw = await mk({ amount: "-1500.00", description: "CASH ADVANCE" });
    await history(feed.id, D, "6145.34"); // the creditor's balance after the draw
    const claim = await addTxn({ occurredOn: D, amount: "-1500.00", source: "manual", plaidAccountId: null, debtId: manual.id, paymentState: "claimed" });
    await addTxn({ occurredOn: D, amount: "-1500.00", debtId: manual.id });
    // The feed card's 500.00 payment was ALSO logged in the app and confirmed by
    // its bank debit. The card-side "PAYMENT THANK YOU" event already explains
    // it: counted once, from the feed — never again from the claim.
    const feedClaim = await addTxn({ occurredOn: D, amount: "-500.00", source: "manual", plaidAccountId: null, debtId: feed.id, paymentState: "claimed" });
    await addTxn({ occurredOn: D, amount: "-500.00", debtId: feed.id });
    await syncDebtLedgerEvents(HH);
    await confirmDebtPaymentClaims(HH);
    expect((await claimRow(claim.id)).paymentState).toBe("confirmed");
    expect((await claimRow(feedClaim.id)).paymentState).toBe("confirmed");

    const once = await writeDebtProgressSnapshots(HH, D);
    const twice = await writeDebtProgressSnapshots(HH, D);
    expect(once.written).toBe(2);
    expect(twice.written).toBe(2);
    const snaps = await db.select().from(debtProgressSnapshotsTable).where(eq(debtProgressSnapshotsTable.householdId, HH));
    expect(snaps).toHaveLength(2);
    const f = snaps.find((s) => s.debtId === feed.id)!;
    expect(f).toMatchObject({
      balanceEffective: "6145.34",
      delta: "1145.34",
      paymentsConfirmed: "-500.00",
      interest: "61.22",
      newCharges: "1584.12",
      unexplained: "0.00",
    });
    const m = snaps.find((s) => s.debtId === manual.id)!;
    expect(m).toMatchObject({ delta: "-1500.00", paymentsConfirmed: "-1500.00", unexplained: "0.00", transferPairTxnId: draw.id });
    for (const s of snaps) {
      const parts = [s.paymentsConfirmed, s.interest, s.fees, s.newCharges, s.credits, s.unexplained].map(Number);
      expect(Math.round(parts.reduce((a, b) => a + b, 0) * 100)).toBe(Math.round(Number(s.delta) * 100));
    }
  });
});

describe("milestones", () => {
  it("are insert-only: a balance that ticks back up never un-achieves one", async () => {
    const visa = await addDebt({ name: "Visa", balance: "3000.00", originalBalance: "5000.00" }); // 40% paid
    const paid = await addDebt({ name: "Old card", balance: "0.00", originalBalance: "900.00", status: "archived" });
    const first = await writeAchievedMilestones(HH, TODAY);
    expect(first.inserted.sort()).toEqual([`debt_zero:${paid.id}`, "first_card_zero", "pct_25"].sort());
    expect((await writeAchievedMilestones(HH, TODAY)).inserted).toEqual([]);
    await db.update(debtsTable).set({ balance: "5600.00" }).where(eq(debtsTable.id, visa.id)); // back under 25%
    expect((await writeAchievedMilestones(HH, addDaysISO(TODAY, 1))).inserted).toEqual([]);
    const rows = await db.select().from(debtMilestonesTable).where(eq(debtMilestonesTable.householdId, HH));
    expect(rows.map((r) => r.key).sort()).toEqual([`debt_zero:${paid.id}`, "first_card_zero", "pct_25"].sort());
    expect(rows.find((r) => r.key === "pct_25")!.achievedOn).toBe(TODAY);
  });

  it("POST /debt-plan/snapshot is owner-only and validates the date", async () => {
    current = { user: OTHER, hh: () => HH };
    expect((await request("POST", "/debt-plan/snapshot")).status).toBe(403);
    current = { user: OWNER, hh: () => HH };
    expect((await request("POST", "/debt-plan/snapshot?date=10/07/2026")).status).toBe(400);
    const ok = await request("POST", `/debt-plan/snapshot?date=${TODAY}`);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ asOf: TODAY, snapshotsWritten: 0, milestonesInserted: [] });
  });
});

type Json = Record<string, unknown>;

/** Every key of a payload, as a path, skipping the subtrees the law exempts. */
function keyPaths(v: unknown, path: string, skip: Set<string>, out: string[] = []): string[] {
  if (skip.has(path)) return out;
  if (Array.isArray(v)) v.forEach((x) => keyPaths(x, `${path}[]`, skip, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(`${path}.${k}`);
      keyPaths(x, `${path}.${k}`, skip, out);
    }
  }
  return out;
}

describe("GET /debt-plan", () => {
  it("shape: strategies, a month range, milestones, planned vs confirmed — and no balance outside `detail`", async () => {
    const visa = await addDebt({ name: "Visa", balance: "3000.00", originalBalance: "5000.00", apr: "0.2249", minPayment: "85.00" });
    await addDebt({ name: "Car loan", balance: "7250.40", originalBalance: "12000.00", apr: "0.0599", minPayment: "310.00", type: "loan" });
    await db.insert(avalancheSettingsTable).values({ userId: OWNER, householdId: HH, strategy: "avalanche", manualExtra: "200.00" });
    // A confirmed bank payment this month (tagged), and a transfer-pair pay-off we must not count.
    await addTxn({ occurredOn: TODAY, amount: "-150.00", debtId: visa.id, description: "VISA PMT" });
    const r = await request("GET", "/debt-plan");
    expect(r.status).toBe(200);
    const plan = r.json as Json & {
      strategy: string;
      extraMonthly: number;
      comparison: { avalanche: { debtFreeMonth: string }; detail: { debts: unknown[] } };
      range: { earliestMonth: string; latestMonth: string; assumptions: Array<{ key: string }> };
      milestones: { next: { label: string; estimatedMonth: string } | null };
      planned60d: Array<{ itemId: string; amount: number }>;
      confirmedMtd: number;
      paidDownGenuineMtd: number;
      newChargesMtd: number;
      assumptions: Array<{ key: string }>;
    };
    expect(Object.keys(plan).sort()).toEqual(
      // (V5) + newChargesMtd — the spine's `debt.newChargesMtd`, an amount charged, never a balance.
      ["asOf", "assumptions", "comparison", "confirmedMtd", "extraMonthly", "milestones", "newChargesMtd", "paidDownGenuineMtd", "planned60d", "range", "strategy"].sort(),
    );
    expect(plan.strategy).toBe("avalanche");
    expect(plan.extraMonthly).toBe(200);
    expect(plan.comparison.avalanche.debtFreeMonth).toMatch(/^\d{4}-\d{2}$/);
    expect(plan.range.earliestMonth <= plan.range.latestMonth).toBe(true);
    expect(plan.assumptions.map((a) => a.key)).toEqual([
      "interest_monthly",
      "payment_month_start",
      "minimums_as_stored",
      "new_charges_measured",
    ]);
    expect(plan.milestones.next).not.toBeNull();
    expect(plan.milestones.next!.estimatedMonth).toMatch(/^\d{4}-\d{2}$/);
    expect(plan.planned60d.some((p) => p.itemId === `debt:${visa.id}` && p.amount === 85)).toBe(true);
    expect(plan.confirmedMtd).toBe(150);
    expect(plan.paidDownGenuineMtd).toBe(150);
    expect(plan.comparison.detail.debts).toHaveLength(2);

    // ⚠️ THE NO-BALANCE LAW, /debt-plan edition: no key anywhere — but the one
    // documented exemption, `comparison.detail` — may look like a balance.
    const keys = keyPaths(plan, "$", new Set(["$.comparison.detail"]));
    expect(keys.length).toBeGreaterThan(30);
    expect(keys.filter((k) => /balance|owed|remaining/i.test(k.split(".").pop()!))).toEqual([]);
    // …and the exemption is real (so the walk above is not vacuous about it).
    expect(keyPaths(plan, "$", new Set()).some((k) => k.endsWith(".balance"))).toBe(true);
  });

  it("is household-scoped: another household's debts and payments never appear", async () => {
    const mine = await addDebt({ name: "Visa" });
    const theirs = await addDebt({ name: "Their card", balance: "900.00" }, HH_OTHER, OTHER);
    await db.insert(transactionsTable).values({
      userId: OTHER, householdId: HH_OTHER, occurredOn: TODAY, amount: "-77.00", description: "THEIR PMT", source: "plaid:bank", plaidAccountId: CHECKING, debtId: theirs.id,
    });
    const r = await request("GET", "/debt-plan");
    const text = JSON.stringify(r.json);
    expect(text).toContain(mine.id);
    expect(text).not.toContain(theirs.id);
    expect((r.json as { confirmedMtd: number }).confirmedMtd).toBe(0);
    current = { user: OTHER, hh: () => HH_OTHER };
    const t = JSON.stringify((await request("GET", "/debt-plan")).json);
    expect(t).toContain(theirs.id);
    expect(t).not.toContain(mine.id);
  });

  it("a transfer pair is confirmed but not genuine: paidDownGenuineMtd excludes it", async () => {
    const store = await addDebt({ name: "Store card" });
    const feed = await addDebt({ name: "Visa Feed", plaidAccountId: cardAcctId });
    await addTxn({ occurredOn: TODAY, amount: "-1500.00", debtId: store.id, description: "STORE CARD PMT" });
    await addTxn({ occurredOn: TODAY, amount: "-1500.00", plaidAccountId: CARD, source: "plaid:visa", description: "CASH ADVANCE", plaidTransactionId: `p-${randomUUID()}` });
    await addTxn({ occurredOn: TODAY, amount: "-40.00", debtId: store.id, description: "STORE CARD PMT 2" });
    await syncDebtLedgerEvents(HH);
    const plan = (await request("GET", "/debt-plan")).json as { confirmedMtd: number; paidDownGenuineMtd: number };
    expect(plan.confirmedMtd).toBe(1540);
    expect(plan.paidDownGenuineMtd).toBe(40);
    expect(feed.id).toBeTruthy();
  });

  it("POST /debt-plan/reconcile runs both passes for the owner only", async () => {
    current = { user: OTHER, hh: () => HH };
    expect((await request("POST", "/debt-plan/reconcile")).status).toBe(403);
    current = { user: OWNER, hh: () => HH };
    const visa = await addDebt({ name: "Visa", plaidAccountId: cardAcctId });
    await addTxn({ occurredOn: TODAY, amount: "-12.00", plaidAccountId: CARD, source: "plaid:visa", description: "CAFE", plaidTransactionId: `p-${randomUUID()}` });
    await addTxn({ occurredOn: TODAY, amount: "-60.00", source: "manual", plaidAccountId: null, debtId: visa.id, paymentState: "claimed" });
    await addTxn({ occurredOn: TODAY, amount: "-60.00", debtId: visa.id });
    const r = await request("POST", "/debt-plan/reconcile");
    expect(r.json).toEqual({ ledgerEventsWritten: 1, ledgerEventsCleared: 0, claimsConfirmed: 1, claimsReverted: 0 });
    const ids = (await db.select({ id: debtLedgerEventsTable.id }).from(debtLedgerEventsTable).where(inArray(debtLedgerEventsTable.debtId, [visa.id]))).length;
    expect(ids).toBe(1);
  });
});
