// ⭐ (WP8) THE FORECAST NEVER COUNTS A CARD PURCHASE AND ITS PAYMENT TWICE.
//
// By construction only checking rows move cash, card purchases reach the curve
// through the everyday hook's payoff, and a payoff leaves the curve on evidence
// of its payment. These cases pin that, through the real routes, to the cent.
//
// The household: Wed 2026-10-07 12:00 CT. Chase checking, snapshot $2,000.00
// read Sun 10/4 08:00 CT — BEFORE the card payment. Amex Platinum. "Weekly
// Spend", stored at $450 every Saturday, is the weekly everyday hook; the
// weekly allowance plan is $250.
//   last week (9/27–10/3): TARGET −120.00 on the card (filed, weekly);
//   this week (10/4–10/10): KROGER −40.00 (filed, weekly) and WALGREENS −25.00
//     (UNFILED) on the card;
//   10/6 on checking: AMERICAN EXPRESS ACH PMT −120.00 (after the snapshot) —
//     last week's payoff, paid.
// Hand-worked: bank today 2,000 − 120 = 1,880.00. This week's charges (every
// coverage) 40 + 25 = 65; spent from the allowance 65; left 185; Saturday
// 10/10 payoff 65 + 185 = 250.00; each later Saturday 250.00. Last week's 120
// is paid on evidence and off the curve.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";

const RUN = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
const TEST_USER = `wp8-nodouble-${RUN}`;
const OTHER_USER = `wp8-nodouble-other-${RUN}`;
const householdOf = new Map<string, string>();
let actingUser = TEST_USER;

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { userId?: string; actualUserId?: string; householdId?: string; householdOwnerId?: string },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = actingUser;
    req.actualUserId = actingUser;
    req.householdId = householdOf.get(actingUser);
    req.householdOwnerId = actingUser;
    next();
  },
}));

import {
  db,
  allowancePlansTable,
  budgetCategoriesTable,
  forecastResolutionsTable,
  forecastSettingsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import apiRouter from "../routes/index";
import {
  countDuplicateTransactionsForUser,
  dedupeTransactionsAcrossAccountsForUser,
  dedupeTransactionsForAccount,
  dedupeTransactionsForUser,
} from "../lib/dedupeTransactions";
import { createTestApp } from "./_helpers/createTestApp";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const routes = Router();
routes.use((req, _res, next) => {
  (req as { log?: unknown }).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  next();
});
routes.use(apiRouter);
const { request } = createTestApp(routes);

const NOW = new Date("2026-10-07T17:00:00Z"); // Wed 12:00 CT
const THIS_WEEK = "2026-10-04";
const CHASE = `wp8-chase-${RUN}`;
const PLAT = `wp8-plat-${RUN}`;
const ORPHAN = `wp8-closed-amex-${RUN}`;
const SATURDAYS = ["2026-10-10", "2026-10-17", "2026-10-24", "2026-10-31"];
let weeklySpendId = "";
let groceriesId = "";
let paymentId = "";

type Event = { date: string; label: string; amount: string; itemId?: string; occurrenceKey?: string; originalDate?: string; assumption?: string | null };
type Signal = {
  bankToday: string;
  events: Event[];
  overdueAssumedPaid?: Array<{ planKey: string; txnId: string; confidence: string; unpaidRemainder: string; planAmount: string }>;
  hookAmountIgnored?: Array<{ itemId: string; storedAmount: string }>;
};

async function get<T>(path: string): Promise<T> {
  const r = await request("GET", path);
  expect(r.status, `${path} → ${JSON.stringify(r.json)}`).toBe(200);
  return r.json as T;
}
const signal = () => get<Signal>("/forecast/cash-signal?horizonDays=30");
const hookEvents = (s: Signal) => s.events.filter((e) => e.itemId === weeklySpendId);
const cents = (v: string | number) => Math.round(Number(v) * 100);

async function cleanup(user: string): Promise<void> {
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.userId, user));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, user));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, user));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, user));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, user));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, user));
  await db.delete(settingsTable).where(eq(settingsTable.userId, user));
  await db.delete(budgetCategoriesTable).where(eq(budgetCategoriesTable.userId, user));
  const hh = householdOf.get(user);
  if (hh) await db.delete(allowancePlansTable).where(eq(allowancePlansTable.householdId, hh));
}

async function txn(t: {
  on: string;
  amount: string;
  desc: string;
  account: string | null;
  source: string;
  weekly?: boolean;
  categoryId?: string | null;
  plaidTxnId?: string | null;
}): Promise<string> {
  const [r] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: householdOf.get(TEST_USER)!,
      occurredOn: t.on,
      description: t.desc,
      amount: t.amount,
      plaidAccountId: t.account,
      plaidTransactionId: t.plaidTxnId === undefined ? `ptx-${RUN}-${randomUUID().slice(0, 8)}` : t.plaidTxnId,
      source: t.source,
      weeklyAllowance: t.weekly ?? false,
      categoryId: t.categoryId ?? null,
      forecastFlag: t.account === CHASE,
      createdAt: createdAtStartOfHouseholdDay(t.on),
    })
    .returning({ id: transactionsTable.id });
  return r!.id;
}

/** The base household; `payment` replaces the $120.00 card payment (null: none). */
async function seed(payment: string | null = "-120.00"): Promise<void> {
  const hh = householdOf.get(TEST_USER)!;
  await cleanup(TEST_USER);
  const [chaseItem] = await db
    .insert(plaidItemsTable)
    .values({ userId: TEST_USER, householdId: hh, itemId: `item-${randomUUID()}`, accessToken: "t", institutionName: "Chase", institutionSlug: "chase" })
    .returning();
  const [amexItem] = await db
    .insert(plaidItemsTable)
    .values({ userId: TEST_USER, householdId: hh, itemId: `item-${randomUUID()}`, accessToken: "t", institutionName: "American Express", institutionSlug: "amex" })
    .returning();
  const [chase] = await db
    .insert(plaidAccountsTable)
    .values({ userId: TEST_USER, householdId: hh, itemId: chaseItem!.id, accountId: CHASE, name: "Chase Checking", mask: "5526", type: "depository", subtype: "checking" })
    .returning();
  await db
    .insert(plaidAccountsTable)
    .values({ userId: TEST_USER, householdId: hh, itemId: amexItem!.id, accountId: PLAT, name: "Amex Platinum", mask: "1005", type: "credit", subtype: "credit card" });
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: hh,
    daysAhead: 30,
    startingBalance: "0",
    cashBuffer: "0",
    bankSnapshotBalance: "2000",
    bankSnapshotAt: new Date("2026-10-04T13:00:00Z"), // Sun 08:00 CT, before the payment
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: chase!.id,
  });
  const [cat] = await db
    .insert(budgetCategoriesTable)
    .values({ userId: TEST_USER, householdId: hh, name: `Groceries ${RUN.slice(-6)}`, kind: "expense", groupName: "Living" })
    .returning();
  groceriesId = cat!.id;
  const [ws] = await db
    .insert(recurringItemsTable)
    .values({ userId: TEST_USER, householdId: hh, name: "Weekly Spend", kind: "bill", amount: "450", frequency: "weekly", anchorDate: "2026-10-10", active: "true" })
    .returning();
  weeklySpendId = ws!.id;
  await db.insert(allowancePlansTable).values({ householdId: hh, memberUserId: null, period: "weekly", amount: "250.00", effectiveFrom: "2026-05-01", source: "owner" });
  await db
    .insert(settingsTable)
    .values({ userId: TEST_USER, householdId: hh, preferences: { everydayHooks: { weekly: { recurringItemId: weeklySpendId }, monthly: null } } })
    .onConflictDoUpdate({
      target: settingsTable.userId,
      set: { preferences: { everydayHooks: { weekly: { recurringItemId: weeklySpendId }, monthly: null } } },
    });
  await txn({ on: "2026-09-29", amount: "-120.00", desc: "TARGET T-0812", account: PLAT, source: "plaid:amex", weekly: true, categoryId: groceriesId });
  await txn({ on: "2026-10-05", amount: "-40.00", desc: "KROGER #442", account: PLAT, source: "plaid:amex", weekly: true, categoryId: groceriesId });
  await txn({ on: "2026-10-06", amount: "-25.00", desc: "WALGREENS #2231", account: PLAT, source: "plaid:amex" });
  paymentId = payment ? await txn({ on: "2026-10-06", amount: payment, desc: "AMERICAN EXPRESS ACH PMT", account: CHASE, source: "plaid:chase" }) : "";
}

beforeAll(async () => {
  for (const u of [TEST_USER, OTHER_USER]) householdOf.set(u, (await createTestHousehold(u)).householdId);
});
afterAll(async () => {
  await cleanup(TEST_USER);
  await cleanup(OTHER_USER);
});
beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  vi.setSystemTime(NOW);
  actingUser = TEST_USER;
  await seed();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("(WP8) case 1 — the card payment counts once, the card purchase never, in cash", () => {
  it("explain's since-anchor counts the payment once and no card row; spine, cash signal and explain agree on today's balance to the cent", async () => {
    const [spine, sig, explain] = await Promise.all([
      get<{ bank: { balance: string } }>("/spine"),
      signal(),
      get<{ displayed: { bankToday: string }; ledger: { sinceAnchor: { rowCount: number; net: string } | null; recentRows: Array<{ description: string }> } }>(
        "/forecast/bank-balance-explain",
      ),
    ]);
    expect(explain.ledger.sinceAnchor).toEqual({ rowCount: 1, net: "-120.00" });
    expect(explain.ledger.recentRows.map((r) => r.description).join(" | ")).not.toMatch(/KROGER|WALGREENS|TARGET/);
    expect(sig.bankToday).toBe("1880.00");
    expect(spine.bank.balance).toBe(sig.bankToday);
    expect(explain.displayed.bankToday).toBe(sig.bankToday);
  });
});

describe("(WP8) case 2 — the curve names plans, one hook per Saturday, and this Saturday is the week's charges plus what is left", () => {
  it("no event names a purchase or a payment; exactly one hook event per Saturday; this week's = combinedWeekCharges + max(0, cap − spent)", async () => {
    const sig = await signal();
    for (const e of sig.events) {
      expect(e.label, JSON.stringify(e)).not.toMatch(/KROGER|WALGREENS|TARGET|AMERICAN EXPRESS ACH/i);
    }
    const perSaturday = new Map<string, number>();
    for (const e of hookEvents(sig)) {
      const occ = (e.occurrenceKey ?? "").split("|")[1] ?? e.originalDate ?? e.date;
      perSaturday.set(occ, (perSaturday.get(occ) ?? 0) + 1);
    }
    expect(Object.fromEntries(perSaturday)).toEqual(Object.fromEntries(SATURDAYS.map((d) => [d, 1])));

    const [payoff, position] = await Promise.all([
      get<{ combinedWeekCharges: number; cards: Array<{ accountId: string; weekCharges: number; chargeCount: number }> }>(
        `/amex/weekly-payoff?weekStart=${THIS_WEEK}`,
      ),
      get<{ weekCap: string | null; remainingWeek: string | null; spentWeekDiscretionary: string }>("/money/position"),
    ]);
    // (Owner's decision) the card page's "this week's charges" bills every charge on the card, the unfiled WALGREENS included.
    expect(payoff.combinedWeekCharges).toBe(65);
    expect(payoff.cards.find((c) => c.accountId === PLAT)).toMatchObject({ weekCharges: 65, chargeCount: 2 });
    expect(position.remainingWeek).toBe("185.00");
    const thisSaturday = hookEvents(sig).find((e) => e.date === "2026-10-10")!;
    const expected = cents(payoff.combinedWeekCharges) + Math.max(0, cents(position.remainingWeek!));
    expect(cents(thisSaturday.amount)).toBe(-expected);
    expect(thisSaturday.amount).toBe("-250.00");
    // Every later Saturday: nothing charged yet, the whole allowance left.
    expect(hookEvents(sig).filter((e) => e.date > "2026-10-10").map((e) => e.amount)).toEqual(["-250.00", "-250.00", "-250.00"]);
    // The plan the curve ignores, said so.
    expect(sig.hookAmountIgnored).toEqual([{ itemId: weeklySpendId, cadence: "weekly", storedAmount: "450.00" }]);
  });
});

describe("(WP8) case 3 — last week's payoff leaves the curve on evidence of its payment, and only then", () => {
  it("the $120.00 payment pays last week's occurrence: listed in overdueAssumedPaid (card_payment), off the curve", async () => {
    const sig = await signal();
    expect(sig.overdueAssumedPaid?.find((p) => p.planKey === `${weeklySpendId}|2026-10-03`)).toMatchObject({
      txnId: paymentId,
      planAmount: "-120.00",
      confidence: "card_payment",
      unpaidRemainder: "0.00",
    });
    expect(hookEvents(sig).some((e) => e.occurrenceKey === `${weeklySpendId}|2026-10-03`)).toBe(false);
  });

  it("a $50.00 payment proves nothing: last week's $120.00 stays on the curve (next business day), not listed paid", async () => {
    await seed("-50.00");
    const sig = await signal();
    expect(sig.bankToday).toBe("1950.00");
    expect(sig.overdueAssumedPaid?.find((p) => p.planKey === `${weeklySpendId}|2026-10-03`)).toBeUndefined();
    const last = hookEvents(sig).find((e) => e.occurrenceKey === `${weeklySpendId}|2026-10-03`);
    expect(last).toMatchObject({ date: "2026-10-08", amount: "-120.00", assumption: "overdue_assumed_unpaid" });
  });
});

describe("(WP8) case 4 — a split part of a card charge stays on the card", () => {
  it("POST /transactions with the charge's plaidAccountId keeps the part on the card: cash, the card's charges and the payoff do not move; both dedupe passes keep equal parts", async () => {
    const parent = await txn({ on: "2026-10-05", amount: "-70.00", desc: "TRADER JOE S #712", account: PLAT, source: "plaid:amex", weekly: true, categoryId: groceriesId });
    const before = {
      bank: (await get<{ bank: { balance: string } }>("/spine")).bank.balance,
      charges: (await get<{ combinedWeekCharges: number }>(`/amex/weekly-payoff?weekStart=${THIS_WEEK}`)).combinedWeekCharges,
      saturday: hookEvents(await signal()).find((e) => e.date === "2026-10-10")!.amount,
    };
    expect(before.charges).toBe(135);

    // The split dialog's writes: the part first (with the charge's source and account), then the parent reshaped.
    const created = await request("POST", "/transactions", {
      occurredOn: "2026-10-05",
      description: "TRADER JOE S #712",
      amount: "-35.00",
      categoryId: groceriesId,
      weeklyAllowance: true,
      weeklyBucket: "alcohol",
      source: "plaid:amex",
      plaidAccountId: PLAT,
      notes: "Split from TRADER JOE S #712",
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const part = created.json as { id: string; plaidAccountId: string | null; source: string; plaidTransactionId: string | null };
    expect(part).toMatchObject({ plaidAccountId: PLAT, source: "plaid:amex", plaidTransactionId: null });
    const patched = await request("PATCH", `/transactions/${parent}`, { amount: "-35.00", weeklyAllowance: true, weeklyBucket: "groceries" });
    expect(patched.status, JSON.stringify(patched.json)).toBe(200);

    // On the card: its own list has both halves.
    const onCard = await get<Array<{ id: string; amount: string }>>(`/transactions?from=${THIS_WEEK}&to=2026-10-10&plaidAccountId=${PLAT}&limit=100`);
    expect(onCard.filter((t) => t.id === parent || t.id === part.id).map((t) => t.amount).sort()).toEqual(["-35.00", "-35.00"]);
    // Nothing moved: cash (the part is not a checking row), the card's charges, the payoff.
    expect((await get<{ bank: { balance: string } }>("/spine")).bank.balance).toBe(before.bank);
    expect((await get<{ combinedWeekCharges: number }>(`/amex/weekly-payoff?weekStart=${THIS_WEEK}`)).combinedWeekCharges).toBe(before.charges);
    expect(hookEvents(await signal()).find((e) => e.date === "2026-10-10")!.amount).toBe(before.saturday);

    // Equal halves on one card, same day and words: never a re-link duplicate.
    await txn({ on: "2026-09-20", amount: "-9.99", desc: "OLD CARD ROW", account: ORPHAN, source: "plaid:amex" }); // wakes the cross-account pass
    expect((await countDuplicateTransactionsForUser(TEST_USER)).duplicateCount).toBe(0);
    await dedupeTransactionsForAccount(TEST_USER, PLAT);
    await dedupeTransactionsForUser(TEST_USER);
    await dedupeTransactionsAcrossAccountsForUser(TEST_USER);
    const left = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(and(eq(transactionsTable.userId, TEST_USER), inArray(transactionsTable.id, [parent, part.id])));
    expect(left.map((r) => r.id).sort()).toEqual([parent, part.id].sort());
  });

  it("a plaidAccountId that is not the household's is a 400 and writes nothing; empty is no account", async () => {
    const count = async () => (await db.select({ id: transactionsTable.id }).from(transactionsTable).where(eq(transactionsTable.userId, TEST_USER))).length;
    const n = await count();
    for (const plaidAccountId of [`acct-nobody-${RUN}`, `other-household-${RUN}`]) {
      const r = await request("POST", "/transactions", { occurredOn: "2026-10-05", description: "PART", amount: "-1.00", source: "plaid:amex", plaidAccountId });
      expect(r.status, plaidAccountId).toBe(400);
      expect(r.json).toMatchObject({ code: "invalid_plaid_account" });
    }
    expect(await count()).toBe(n);
    const empty = await request("POST", "/transactions", { occurredOn: "2026-10-05", description: "MANUAL PART", amount: "-1.00", source: "manual", plaidAccountId: "" });
    expect(empty.status).toBe(201);
    expect((empty.json as { plaidAccountId: string | null }).plaidAccountId).toBeNull();
  });

  it("another household's account id is refused even though it exists", async () => {
    const otherHh = householdOf.get(OTHER_USER)!;
    const [item] = await db
      .insert(plaidItemsTable)
      .values({ userId: OTHER_USER, householdId: otherHh, itemId: `item-${randomUUID()}`, accessToken: "t", institutionName: "American Express", institutionSlug: "amex" })
      .returning();
    const theirs = `wp8-theirs-${RUN}`;
    await db
      .insert(plaidAccountsTable)
      .values({ userId: OTHER_USER, householdId: otherHh, itemId: item!.id, accountId: theirs, name: "Their Amex", mask: "2002", type: "credit", subtype: "credit card" });
    // (WP8b) …and so is one only their rows carry: the rows read are this household's.
    await db.insert(transactionsTable).values({
      userId: OTHER_USER,
      householdId: otherHh,
      occurredOn: "2026-10-05",
      description: "THEIR CHARGE",
      amount: "-5.00",
      source: "plaid:amex",
      plaidAccountId: theirs,
      plaidTransactionId: `ptx-theirs-${RUN}`,
    });
    const r = await request("POST", "/transactions", { occurredOn: "2026-10-05", description: "PART", amount: "-1.00", source: "plaid:amex", plaidAccountId: theirs });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ code: "invalid_plaid_account" });
  });
});

describe("(WP8b) a split part names its charge, and the server puts it where the charge is", () => {
  const bank = async () => (await get<{ bank: { balance: string } }>("/spine")).bank.balance;
  const partOf = (parent: string, extra: Record<string, unknown> = {}) =>
    request("POST", "/transactions", {
      occurredOn: "2026-10-05",
      description: "TRADER JOE S #712",
      amount: "-35.00",
      categoryId: groceriesId,
      weeklyAllowance: true,
      weeklyBucket: "alcohol",
      notes: "Split from TRADER JOE S #712",
      splitOf: parent,
      ...extra,
    });

  it("a charge whose card connection was removed (its account id is only on its rows) still splits, and the part stays on that card", async () => {
    // DELETE /plaid/items deletes the plaid_accounts row and keeps the rows with their account id: ORPHAN is that id.
    const parent = await txn({ on: "2026-10-05", amount: "-70.00", desc: "TRADER JOE S #712", account: ORPHAN, source: "plaid:amex", weekly: true, categoryId: groceriesId });
    const before = await bank();
    // What the body says about the part's place is ignored: the charge decides.
    const created = await partOf(parent, { source: "manual", plaidAccountId: null });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(created.json).toMatchObject({ source: "plaid:amex", plaidAccountId: ORPHAN, plaidTransactionId: null });
    // Not a checking row: cash does not move.
    expect(await bank()).toBe(before);
    // A client that still names the account (the WP8 body) is accepted too: the household's rows carry the id.
    const legacy = await request("POST", "/transactions", {
      occurredOn: "2026-10-05",
      description: "TRADER JOE S #712",
      amount: "-1.00",
      source: "plaid:amex",
      plaidAccountId: ORPHAN,
    });
    expect(legacy.status, JSON.stringify(legacy.json)).toBe(201);
    expect(legacy.json).toMatchObject({ source: "plaid:amex", plaidAccountId: ORPHAN });
    expect(await bank()).toBe(before);
  });

  it("a part of a statement-imported card row keeps that row's source (off the checking ledger); a part of a checking row stays a checking row", async () => {
    const csvCard = await txn({ on: "2026-10-05", amount: "-70.00", desc: "AMEX STATEMENT ROW", account: null, source: "amex", plaidTxnId: null });
    const manual = await txn({ on: "2026-10-05", amount: "-70.00", desc: "CASH AT MARKET", account: null, source: "manual", plaidTxnId: null });
    const before = await bank();
    const a = await partOf(csvCard);
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    expect(a.json).toMatchObject({ source: "amex", plaidAccountId: null });
    expect(await bank()).toBe(before);
    const b = await partOf(manual, { source: "plaid:amex", plaidAccountId: PLAT });
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    expect(b.json).toMatchObject({ source: "manual", plaidAccountId: null });
    // A checking part is a checking row: −35.00 on the ledger.
    expect(cents(await bank())).toBe(cents(before) - 3500);
  });

  it("splitOf that is not one of the household's transactions is a 400 and writes nothing", async () => {
    const count = async () => (await db.select({ id: transactionsTable.id }).from(transactionsTable).where(eq(transactionsTable.userId, TEST_USER))).length;
    const otherHh = householdOf.get(OTHER_USER)!;
    const [theirs] = await db
      .insert(transactionsTable)
      .values({ userId: OTHER_USER, householdId: otherHh, occurredOn: "2026-10-05", description: "THEIR ROW", amount: "-5.00", source: "manual" })
      .returning({ id: transactionsTable.id });
    const n = await count();
    for (const splitOf of [randomUUID(), "not-a-uuid", theirs!.id]) {
      const r = await partOf(splitOf);
      expect(r.status, splitOf).toBe(400);
      expect(r.json).toMatchObject({ code: "invalid_split_parent" });
    }
    expect(await count()).toBe(n);
  });
});

describe("(WP8) gaps deferred with reasons (plan, WP8 'Deferred')", () => {
  it.todo("(ii) a card payment to a non-Amex card is evidence for its hook — `namesCardIssuer` knows only Amex today");
  it.todo("(iii) a prepaid or overpaid hook period carries the difference into the next payoff");
  it.todo("(iv) purchases on non-Amex cards and Amex workbook rows reach the forecast — the hook bills Amex Plaid cards only");
  it.todo("(vi) the Review badge leaves out the row that paid a hook on evidence");
  it.todo("(vii) Budget's own double counts (card payments filed to an expense line) — a parity row in the reconciliation table instead");
});
