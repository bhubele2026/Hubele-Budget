// ⭐ (AVAL-W) "WE PAID IT" — POST /avalanche/weekly/pay and its undo, through
// the real plan, ledger and database.
//
// A household paid every other Friday from 11/13, rent on the 1st, bills on the
// 15th, a $500 buffer, weekly on Fridays, and three invented debts: Card A
// (manual, highest APR), Card B (its balance comes from the bank) and a store
// loan (manual). Asserted:
//   - the pay answers the week `matched` (the plan's next open week is the next
//     Friday), lowers each manual debt by exactly what the week paid it, archives
//     one that reaches $0 and reports it paid off, leaves the bank's debt alone,
//     writes one claim per manual debt and the day's history, and shows up as
//     `lastPaid`;
//   - the undo puts back the answers (the replaced one with its own id), the
//     balances, statuses and as-of, removes the claims and the history day;
//   - refused, nothing written: a balance edited since (changed_since), a second
//     press (already_answered), the monthly cadence (not_weekly), nothing due,
//     a week too old to undo, another household's record (not_found);
//   - a member may press it.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";

const OWNER = `aval-pay-${process.pid}-${randomUUID().slice(0, 8)}`;
const MEMBER = `${OWNER}-member`;
const OTHER = `${OWNER}-other`;
let HH = "";
let OTHER_HH = "";
let ACTOR = OWNER;
let AUTH_HH = "";
let AUTH_OWNER = OWNER;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = ACTOR;
    req.actualUserId = ACTOR;
    req.householdId = AUTH_HH;
    req.householdOwnerId = AUTH_OWNER;
    next();
  },
}));

import {
  db,
  avalancheSettingsTable,
  avalancheWeekPaymentsTable,
  budgetCategoriesTable,
  budgetLinesTable,
  budgetMonthsTable,
  debtBalanceHistoryTable,
  debtsTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  transactionsTable,
} from "@workspace/db";
import avalancheRouter from "../routes/avalanche";
import { AVALANCHE_EXTRA_EVENT_ITEM_ID } from "../lib/debtMinSchedule";
import { createTestHousehold } from "./_helpers/testHousehold";

// Tuesday 2026-11-10, midday in Chicago.
const NOW = new Date("2026-11-10T18:00:00Z");
const TODAY = "2026-11-10";
const FRIDAY = "2026-11-13";

const app = express();
app.use(express.json());
app.use((req: { log?: unknown }, _res, next) => {
  req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
app.use(avalancheRouter);
let server: Server;
let baseUrl = "";

async function call<T = any>(method: string, p: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(`${baseUrl}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: (await r.json()) as T };
}

async function cleanupHousehold(hh: string, owner: string): Promise<void> {
  await db.delete(avalancheWeekPaymentsTable).where(eq(avalancheWeekPaymentsTable.householdId, hh));
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.householdId, hh));
  await db.delete(transactionsTable).where(eq(transactionsTable.householdId, hh));
  await db.delete(debtBalanceHistoryTable).where(eq(debtBalanceHistoryTable.householdId, hh));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.householdId, hh));
  await db.delete(debtsTable).where(eq(debtsTable.householdId, hh));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.householdId, hh));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.householdId, hh));
  await db.delete(avalancheSettingsTable).where(eq(avalancheSettingsTable.userId, owner));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, owner));
  await db.delete(budgetLinesTable).where(eq(budgetLinesTable.householdId, hh));
  await db.delete(budgetMonthsTable).where(eq(budgetMonthsTable.householdId, hh));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.householdId, hh));
}

const ids: Record<string, string> = {};

type Seed = {
  cadence?: "weekly" | "monthly";
  cashBuffer?: number;
  /** Card A's balance: small enough to pay off this Friday by default. */
  cardA?: string;
};

async function seed(opts: Seed = {}, hh = HH, owner = OWNER): Promise<void> {
  await db.insert(forecastSettingsTable).values({
    userId: owner,
    householdId: hh,
    daysAhead: 90,
    cashBuffer: String(opts.cashBuffer ?? 500),
    bankSnapshotBalance: "2500",
    bankSnapshotAt: new Date("2026-11-10T15:00:00Z"),
    bankSnapshotSource: "manual",
  });
  const item = (over: Partial<typeof recurringItemsTable.$inferInsert>) => ({
    userId: owner,
    householdId: hh,
    kind: "expense",
    frequency: "monthly",
    active: "true",
    createdAt: new Date("2026-01-01T18:00:00Z"),
    ...over,
  });
  await db.insert(recurringItemsTable).values([
    item({ name: "Paycheck", kind: "income", amount: "4000", frequency: "biweekly", anchorDate: FRIDAY }),
    item({ name: "Rent", amount: "2600", dayOfMonth: 1, anchorDate: "2026-12-01" }),
    item({ name: "Mid-month bills", amount: "1450", dayOfMonth: 15, anchorDate: "2026-11-15" }),
  ] as Array<typeof recurringItemsTable.$inferInsert>);
  // Card B's balance comes from the bank.
  const [plaidItem] = await db
    .insert(plaidItemsTable)
    .values({ userId: owner, householdId: hh, itemId: `item-${randomUUID()}`, accessToken: "test-token", institutionSlug: "test-bank" })
    .returning();
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: owner,
      householdId: hh,
      itemId: plaidItem!.id,
      accountId: `ext-card-b-${randomUUID().slice(0, 8)}`,
      name: "Card B",
      mask: "0002",
      type: "credit",
      subtype: "credit card",
    })
    .returning();
  const debts = [
    // Due on the 20th: no interest or minimum between today and Friday, so the week pays its stored balance.
    { key: "a", name: "Card A", balance: opts.cardA ?? "1000.00", apr: "0.2900", minPayment: "50", dueDay: 20, plaidAccountId: null },
    { key: "b", name: "Card B", balance: "8000.00", apr: "0.2500", minPayment: "200", dueDay: 5, plaidAccountId: acct!.id },
    { key: "store", name: "Store loan", balance: "2400.00", apr: "0.1500", minPayment: "120", dueDay: 8, plaidAccountId: null },
  ];
  for (const d of debts) {
    const [row] = await db
      .insert(debtsTable)
      .values({
        userId: owner,
        householdId: hh,
        name: d.name,
        type: "credit_card",
        balance: d.balance,
        apr: d.apr,
        minPayment: d.minPayment,
        dueDay: d.dueDay,
        status: "active",
        plaidAccountId: d.plaidAccountId,
        balanceSource: d.plaidAccountId ? "plaid" : "manual",
        createdAt: new Date("2026-11-10T15:00:00Z"),
      })
      .returning();
    ids[d.key] = row!.id;
  }
  await db.insert(avalancheSettingsTable).values({
    userId: owner,
    householdId: hh,
    manualExtra: "2600",
    extraCadence: opts.cadence ?? "weekly",
    extraWeekday: 5,
    updatedAt: new Date("2026-11-01T18:00:00Z"),
  });
}

const debtRow = async (key: string) => (await db.select().from(debtsTable).where(eq(debtsTable.id, ids[key]!)))[0]!;
const answersFor = (date: string) =>
  db
    .select()
    .from(forecastResolutionsTable)
    .where(
      and(
        eq(forecastResolutionsTable.householdId, HH),
        eq(forecastResolutionsTable.recurringItemId, AVALANCHE_EXTRA_EVENT_ITEM_ID),
        eq(forecastResolutionsTable.occurrenceDate, date),
      ),
    );
const claims = () =>
  db
    .select()
    .from(transactionsTable)
    .where(and(eq(transactionsTable.householdId, HH), inArray(transactionsTable.debtId, [ids.a!, ids.b!, ids.store!])));
const history = () => db.select().from(debtBalanceHistoryTable).where(eq(debtBalanceHistoryTable.householdId, HH));
const cents = (v: string | number) => Math.round(Number(v) * 100);

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
  OTHER_HH = (await createTestHousehold(OTHER)).householdId;
  await cleanupHousehold(HH, OWNER);
  await cleanupHousehold(OTHER_HH, OTHER);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await cleanupHousehold(HH, OWNER);
  await cleanupHousehold(OTHER_HH, OTHER);
  await new Promise<void>((res) => server.close(() => res()));
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  ACTOR = OWNER;
  AUTH_HH = HH;
  AUTH_OWNER = OWNER;
  await cleanupHousehold(HH, OWNER);
  await cleanupHousehold(OTHER_HH, OTHER);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("POST /avalanche/weekly/pay", () => {
  it("closes the week, pays off the manual card (archived, PAID OFF), leaves the bank's card alone, and shows lastPaid", async () => {
    await seed();
    const { body: before } = await call("GET", "/avalanche/weekly");
    expect(before.lastPaid).toBeNull();
    const week = before.weeks[0];
    expect(week).toMatchObject({ date: FRIDAY, answered: false });
    expect(week.due).toBeGreaterThan(1000);
    // This Friday clears Card A and puts the rest on Card B (the bank's).
    expect(week.targets.map((t: { name: string }) => t.name)).toEqual(["Card A", "Card B"]);
    expect(week.targets[0]).toMatchObject({ debtId: ids.a, amount: 1000, paidOff: true });
    const toB = week.targets[1].amount as number;

    const res = await call("POST", "/avalanche/weekly/pay", { date: FRIDAY });
    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({
      date: FRIDAY,
      total: week.due,
      createdBy: OWNER,
      undoneAt: null,
      undoable: true,
      targets: [
        { debtId: ids.a, name: "Card A", amount: 1000, linked: false, paidOff: true },
        { debtId: ids.b, name: "Card B", amount: toB, linked: true, paidOff: false },
      ],
    });

    // The week is answered; the next open week is the next Friday.
    const plan = res.body.plan;
    expect(plan.weeks.find((w: { date: string }) => w.date === FRIDAY)).toMatchObject({ answered: true, paid: 0 });
    expect(plan.weeks.find((w: { answered: boolean }) => !w.answered).date).toBe("2026-11-20");
    const answers = await answersFor(FRIDAY);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ status: "matched", matchedTxnId: null, userId: OWNER });

    // Card A: $0 and archived; the claim says so. Card B (the bank's): untouched, no claim.
    const a = await debtRow("a");
    expect(a).toMatchObject({ balance: "0.00", status: "archived" });
    const b = await debtRow("b");
    expect(b).toMatchObject({ balance: "8000.00", status: "active", lastBalanceUpdate: null });
    const store = await debtRow("store");
    expect(store.balance).toBe("2400.00");
    const cs = await claims();
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({
      debtId: ids.a,
      amount: "-1000.00",
      occurredOn: TODAY,
      paymentState: "claimed",
      source: "manual",
      description: "Payment — Card A (PAID OFF)",
    });
    const hist = await history();
    expect(hist.map((h) => [h.debtId, h.recordedOn, h.balance])).toEqual([[ids.a, TODAY, "0.00"]]);

    // Card A is gone from the plan; lastPaid names the payment.
    expect(plan.weeks.flatMap((w: { targets: Array<{ debtId: string }> }) => w.targets).some((t: { debtId: string }) => t.debtId === ids.a)).toBe(false);
    const { body: after } = await call("GET", "/avalanche/weekly");
    expect(after.lastPaid).toEqual({
      id: res.body.payment.id,
      date: FRIDAY,
      total: week.due,
      targets: res.body.payment.targets,
      undoable: true,
    });
  });

  it("a manual debt drops by exactly what the week paid it", async () => {
    await seed({ cardA: "20000.00" });
    const { body: before } = await call("GET", "/avalanche/weekly");
    const week = before.weeks[0];
    expect(week.targets).toHaveLength(1);
    expect(week.targets[0]).toMatchObject({ debtId: ids.a, paidOff: false });
    const res = await call("POST", "/avalanche/weekly/pay", { date: FRIDAY });
    expect(res.status).toBe(201);
    const a = await debtRow("a");
    expect(cents(a.balance)).toBe(cents(20000) - cents(week.targets[0].amount));
    expect(a.status).toBe("active");
    expect(a.lastBalanceUpdate).not.toBeNull();
    expect(res.body.payment.targets[0]).toMatchObject({ amount: week.targets[0].amount, linked: false, paidOff: false });
    const [claim] = await claims();
    expect(claim).toMatchObject({ description: "Payment — Card A", amount: (-week.targets[0].amount).toFixed(2) });
  });

  it("undo puts back the answers (the replaced one with its id), balances, statuses and as-of, and removes the claims and the history day", async () => {
    await seed();
    // An earlier answer on the week that the pay replaces: a move to the same day.
    const [moved] = await db
      .insert(forecastResolutionsTable)
      .values({
        userId: OWNER,
        householdId: HH,
        recurringItemId: AVALANCHE_EXTRA_EVENT_ITEM_ID,
        occurrenceDate: FRIDAY,
        status: "rescheduled",
        rescheduledTo: FRIDAY,
        createdAt: new Date("2026-11-09T15:00:00Z"),
      })
      .returning();
    const debtsBefore = await db.select().from(debtsTable).where(eq(debtsTable.householdId, HH));
    const paid = await call("POST", "/avalanche/weekly/pay", { date: FRIDAY });
    expect(paid.status).toBe(201);
    expect((await answersFor(FRIDAY)).map((r) => r.status)).toEqual(["matched"]);

    const undo = await call("POST", `/avalanche/weekly/pay/${paid.body.payment.id}/undo`);
    expect(undo.status).toBe(200);
    expect(undo.body.payment).toMatchObject({ id: paid.body.payment.id, undoable: false });
    expect(undo.body.payment.undoneAt).toBeTruthy();
    expect(undo.body.plan.lastPaid).toBeNull();
    expect(undo.body.plan.weeks[0]).toMatchObject({ date: FRIDAY, answered: false });

    const answers = await answersFor(FRIDAY);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ id: moved!.id, status: "rescheduled", rescheduledTo: FRIDAY, userId: OWNER });
    expect(answers[0]!.createdAt.toISOString()).toBe("2026-11-09T15:00:00.000Z");
    const debtsAfter = await db.select().from(debtsTable).where(eq(debtsTable.householdId, HH));
    const shape = (rows: typeof debtsBefore) =>
      rows
        .map((d) => [d.id, d.balance, d.status, d.lastBalanceUpdate?.toISOString() ?? null] as const)
        .sort((x, y) => x[0].localeCompare(y[0]));
    expect(shape(debtsAfter)).toEqual(shape(debtsBefore));
    expect(await claims()).toHaveLength(0);
    expect(await history()).toHaveLength(0);

    // The week can be paid again, and a second undo of the first is refused.
    expect((await call("POST", `/avalanche/weekly/pay/${paid.body.payment.id}/undo`)).body).toMatchObject({ code: "already_undone" });
    expect((await call("POST", "/avalanche/weekly/pay", { date: FRIDAY })).status).toBe(201);
  });

  it("undo is refused, nothing written, when a balance was edited since", async () => {
    await seed({ cardA: "20000.00" });
    const paid = await call("POST", "/avalanche/weekly/pay", { date: FRIDAY });
    expect(paid.status).toBe(201);
    await db.update(debtsTable).set({ balance: "15000.00" }).where(eq(debtsTable.id, ids.a!));
    const { body: plan } = await call("GET", "/avalanche/weekly");
    expect(plan.lastPaid).toMatchObject({ id: paid.body.payment.id, undoable: false });

    const undo = await call("POST", `/avalanche/weekly/pay/${paid.body.payment.id}/undo`);
    expect(undo.status).toBe(409);
    expect(undo.body).toMatchObject({ code: "changed_since" });
    expect((await debtRow("a")).balance).toBe("15000.00");
    expect((await answersFor(FRIDAY)).map((r) => r.status)).toEqual(["matched"]);
    expect(await claims()).toHaveLength(1);
    const [rec] = await db.select().from(avalancheWeekPaymentsTable).where(eq(avalancheWeekPaymentsTable.householdId, HH));
    expect(rec!.undoneAt).toBeNull();
  });

  it("undo is refused when the week's answer was changed on the Forecast since", async () => {
    await seed();
    const paid = await call("POST", "/avalanche/weekly/pay", { date: FRIDAY });
    await db.update(forecastResolutionsTable).set({ status: "skipped" }).where(eq(forecastResolutionsTable.id, (await answersFor(FRIDAY))[0]!.id));
    const undo = await call("POST", `/avalanche/weekly/pay/${paid.body.payment.id}/undo`);
    expect(undo).toMatchObject({ status: 409, body: { code: "changed_since" } });
    expect((await debtRow("a")).balance).toBe("0.00");
  });

  it("a second press for the same week is refused, and so is a week answered on the Forecast", async () => {
    await seed();
    expect((await call("POST", "/avalanche/weekly/pay", { date: FRIDAY })).status).toBe(201);
    const again = await call("POST", "/avalanche/weekly/pay", { date: FRIDAY });
    expect(again).toMatchObject({ status: 409, body: { code: "already_answered" } });
    expect(await claims()).toHaveLength(1);
    expect(await db.select().from(avalancheWeekPaymentsTable).where(eq(avalancheWeekPaymentsTable.householdId, HH))).toHaveLength(1);

    // Two presses at once: one pays, one is refused.
    await cleanupHousehold(HH, OWNER);
    await seed();
    const both = await Promise.all([
      call("POST", "/avalanche/weekly/pay", { date: FRIDAY }),
      call("POST", "/avalanche/weekly/pay", { date: FRIDAY }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await claims()).toHaveLength(1);

    // Skipped on the Forecast: nothing to mark.
    await cleanupHousehold(HH, OWNER);
    await seed();
    await db.insert(forecastResolutionsTable).values({
      userId: OWNER,
      householdId: HH,
      recurringItemId: AVALANCHE_EXTRA_EVENT_ITEM_ID,
      occurrenceDate: FRIDAY,
      status: "skipped",
    });
    expect(await call("POST", "/avalanche/weekly/pay", { date: FRIDAY })).toMatchObject({ status: 409, body: { code: "already_answered" } });
  });

  it("refuses the monthly cadence, a day that is not a payment day, a missing date and a week with nothing due", async () => {
    await seed({ cadence: "monthly" });
    expect(await call("POST", "/avalanche/weekly/pay", { date: FRIDAY })).toMatchObject({ status: 409, body: { code: "not_weekly" } });
    expect((await call("GET", "/avalanche/weekly")).body).toMatchObject({ cadence: "monthly", weeks: [], lastPaid: null });
    await cleanupHousehold(HH, OWNER);
    await seed();
    expect(await call("POST", "/avalanche/weekly/pay", { date: "2026-11-12" })).toMatchObject({ status: 400, body: { code: "unknown_week" } });
    expect(await call("POST", "/avalanche/weekly/pay", {})).toMatchObject({ status: 400, body: { code: "invalid_date" } });
    expect(await call("POST", "/avalanche/weekly/pay", { date: "11/13/2026" })).toMatchObject({ status: 400, body: { code: "invalid_date" } });
    // A buffer above everything checking will hold: nothing is safe.
    await cleanupHousehold(HH, OWNER);
    await seed({ cashBuffer: 100000 });
    const { body: plan } = await call("GET", "/avalanche/weekly");
    expect(plan.weeks[0]).toMatchObject({ date: FRIDAY, due: 0 });
    expect(await call("POST", "/avalanche/weekly/pay", { date: FRIDAY })).toMatchObject({ status: 409, body: { code: "nothing_due" } });
    expect(await claims()).toHaveLength(0);
    expect(await answersFor(FRIDAY)).toHaveLength(0);
  });

  it("a member may press it and undo it", async () => {
    await seed();
    ACTOR = MEMBER;
    const paid = await call("POST", "/avalanche/weekly/pay", { date: FRIDAY });
    expect(paid.status).toBe(201);
    expect(paid.body.payment.createdBy).toBe(MEMBER);
    const [claim] = await claims();
    expect(claim!.userId).toBe(MEMBER);
    const undo = await call("POST", `/avalanche/weekly/pay/${paid.body.payment.id}/undo`);
    expect(undo.status).toBe(200);
    expect((await debtRow("a")).balance).toBe("1000.00");
  });

  it("another household cannot see or undo it", async () => {
    await seed();
    const paid = await call("POST", "/avalanche/weekly/pay", { date: FRIDAY });
    expect(paid.status).toBe(201);
    ACTOR = OTHER;
    AUTH_HH = OTHER_HH;
    AUTH_OWNER = OTHER;
    expect((await call("GET", "/avalanche/weekly")).body.lastPaid).toBeNull();
    const undo = await call("POST", `/avalanche/weekly/pay/${paid.body.payment.id}/undo`);
    expect(undo).toMatchObject({ status: 404, body: { code: "not_found" } });
    expect(await call("POST", "/avalanche/weekly/pay/not-an-id/undo")).toMatchObject({ status: 404, body: { code: "not_found" } });
    ACTOR = OWNER;
    AUTH_HH = HH;
    AUTH_OWNER = OWNER;
    expect((await debtRow("a")).balance).toBe("0.00");
    expect((await call("GET", "/avalanche/weekly")).body.lastPaid).toMatchObject({ id: paid.body.payment.id, undoable: true });
  });

  it("past 14 days after its week the Undo is gone, and the undo is refused", async () => {
    await seed();
    const paid = await call("POST", "/avalanche/weekly/pay", { date: FRIDAY });
    expect(paid.status).toBe(201);
    vi.setSystemTime(new Date("2026-11-27T18:00:00Z"));
    expect((await call("GET", "/avalanche/weekly")).body.lastPaid).toMatchObject({ id: paid.body.payment.id, undoable: true });
    vi.setSystemTime(new Date("2026-11-28T18:00:00Z"));
    expect((await call("GET", "/avalanche/weekly")).body.lastPaid).toMatchObject({ id: paid.body.payment.id, undoable: false });
    const undo = await call("POST", `/avalanche/weekly/pay/${paid.body.payment.id}/undo`);
    expect(undo).toMatchObject({ status: 409, body: { code: "too_late" } });
    expect((await debtRow("a")).balance).toBe("0.00");
  });
});
