// ⭐ (PR-B2, owner decision 7) THE EVERYDAY HOOKS ON THE FORECAST.
//
// The "Weekly Spend" bill is a DATE: each occurrence is the Amex payoff for its
// week — the week's charges on the weekly-cadence cards plus what is left of
// the allowance while the week is open — and the bill's stored $300 is
// ignored. Wed 2026-10-07 12:00 CT; balance 2,000.00 read Sun 10/4 08:00;
// buffer 0; weekly allowance plan $250; Weekly Spend stored at $300 on
// Saturdays. Last week (9/27–10/3) Amex Platinum $120; this week $40 so far.
//
// Hand-worked base (T1): last week closed unpaid → −120 on the next business
// day (Thu 10/8); this week 40 + (250 − 40) = 250 on Sat 10/10; each later
// week 0 + 250. Daily: 10/7 2,000 · 10/8 1,880 · 10/10 1,630 · 10/17 1,380.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  allowancePlansTable,
  forecastSettingsTable,
  forecastResolutionsTable,
  householdsTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import { computeCashSignal, type CashSignal } from "../lib/cashSignal";
import { buildMoneyPosition } from "../lib/moneyPosition";
import { keepServerOwnedPreferences, SERVER_OWNED_PREFERENCE_KEYS } from "../routes/settings";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";

const TEST_USER = `everyday-hooks-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let HH: string;
const NOW = new Date("2026-10-07T17:00:00Z"); // Wed 12:00 CT
const CHASE = `hooks-chase-${randomUUID().slice(0, 6)}`;
const PLAT = `hooks-plat-${randomUUID().slice(0, 6)}`;
let weeklySpendId = "";

async function cleanup(user = TEST_USER): Promise<void> {
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.userId, user));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, user));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, user));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, user));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, user));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, user));
  await db.delete(settingsTable).where(eq(settingsTable.userId, user));
}

beforeAll(async () => {
  HH = (await createTestHousehold(TEST_USER)).householdId;
});
afterAll(async () => {
  await cleanup();
  if (HH) await db.delete(allowancePlansTable).where(eq(allowancePlansTable.householdId, HH));
});
afterEach(() => {
  vi.useRealTimers();
});

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  await cleanup();
  await db.delete(allowancePlansTable).where(eq(allowancePlansTable.householdId, HH));
  const [chaseItem] = await db
    .insert(plaidItemsTable)
    .values({ userId: TEST_USER, householdId: HH, itemId: `item-${randomUUID()}`, accessToken: "t", institutionSlug: "chase" })
    .returning();
  const [amexItem] = await db
    .insert(plaidItemsTable)
    .values({ userId: TEST_USER, householdId: HH, itemId: `item-${randomUUID()}`, accessToken: "t", institutionSlug: "amex" })
    .returning();
  const [chase] = await db
    .insert(plaidAccountsTable)
    .values({ userId: TEST_USER, householdId: HH, itemId: chaseItem!.id, accountId: CHASE, name: "Chase Checking", mask: "5526", type: "depository", subtype: "checking" })
    .returning();
  await db
    .insert(plaidAccountsTable)
    .values({ userId: TEST_USER, householdId: HH, itemId: amexItem!.id, accountId: PLAT, name: "Amex Platinum", mask: "1001", type: "credit", subtype: "credit card" });
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: HH,
    daysAhead: 30,
    startingBalance: "0",
    cashBuffer: "0",
    bankSnapshotBalance: "2000",
    bankSnapshotAt: new Date("2026-10-04T13:00:00Z"),
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: chase!.id,
  });
  const [ws] = await db
    .insert(recurringItemsTable)
    .values({ userId: TEST_USER, householdId: HH, name: "Weekly Spend", kind: "bill", amount: "300", frequency: "weekly", anchorDate: "2026-10-10", active: "true" })
    .returning();
  weeklySpendId = ws!.id;
  await db.insert(allowancePlansTable).values({ householdId: HH, memberUserId: null, period: "weekly", amount: "250.00", effectiveFrom: "2026-05-01", source: "owner" });
  await setHooks({ weekly: { recurringItemId: weeklySpendId }, monthly: null });
  await txn({ on: "2026-09-29", amount: "-120.00", desc: "TARGET", account: PLAT, source: "plaid:amex", weekly: true });
  await txn({ on: "2026-10-05", amount: "-40.00", desc: "HEB GROCERY", account: PLAT, source: "plaid:amex", weekly: true });
});

async function setHooks(hooks: unknown, extra: Record<string, unknown> = {}): Promise<void> {
  await db
    .insert(settingsTable)
    .values({ userId: TEST_USER, householdId: HH, preferences: hooks === undefined ? {} : { everydayHooks: hooks }, ...extra })
    .onConflictDoUpdate({ target: settingsTable.userId, set: { preferences: hooks === undefined ? {} : { everydayHooks: hooks }, ...extra } });
}

async function txn(t: {
  on: string;
  amount: string;
  desc: string;
  account: string;
  source: string;
  weekly?: boolean;
  unplanned?: boolean;
  reimbursable?: boolean;
  forecastFlag?: boolean;
}): Promise<string> {
  const [r] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: HH,
      occurredOn: t.on,
      description: t.desc,
      amount: t.amount,
      plaidAccountId: t.account,
      source: t.source,
      weeklyAllowance: t.weekly ?? false,
      unplannedAllowance: t.unplanned ?? false,
      reimbursable: t.reimbursable ?? false,
      forecastFlag: t.forecastFlag ?? t.account === CHASE,
      createdAt: createdAtStartOfHouseholdDay(t.on),
    })
    .returning({ id: transactionsTable.id });
  return r!.id;
}

const signal = () => computeCashSignal(HH, TEST_USER, { horizonDays: 30 });
const hookEvents = (sig: CashSignal) =>
  (sig.events ?? []).filter((e) => e.itemId === weeklySpendId).map((e) => [e.date, e.amount, e.originalDate, e.assumption]);
const balanceOn = (sig: CashSignal, date: string) => sig.daily?.find((d) => d.date === date)?.balance;

describe("(PR-B2, decision 7) a hook occurrence is its card payoff", () => {
  it("T1 the stored $300 is ignored: last week's $120 lands Thu 10/8; this week 40 + 210 = 250 on Sat 10/10; later weeks 250", async () => {
    const sig = await signal();
    expect(sig.bankToday).toBe("2000.00");
    expect(hookEvents(sig)).toEqual([
      ["2026-10-08", "-120.00", "2026-10-03", "overdue_assumed_unpaid"],
      ["2026-10-10", "-250.00", "2026-10-10", null],
      ["2026-10-17", "-250.00", "2026-10-17", null],
      ["2026-10-24", "-250.00", "2026-10-24", null],
      ["2026-10-31", "-250.00", "2026-10-31", null],
    ]);
    expect([balanceOn(sig, "2026-10-07"), balanceOn(sig, "2026-10-08"), balanceOn(sig, "2026-10-10"), balanceOn(sig, "2026-10-17")]).toEqual([
      "2000.00",
      "1880.00",
      "1630.00",
      "1380.00",
    ]);
    expect(sig.hookAmountIgnored).toEqual([{ itemId: weeklySpendId, cadence: "weekly", storedAmount: "300.00" }]);
    // (S2) Each occurrence's reserve and what it was sized from: the plan.
    // (F1) Sized from the first of last month (an unpaid week stays owed past
    // the 14-day drag floor), so 9/5 – 9/19 are listed too (nothing charged).
    expect(sig.hookReserves?.map((r) => [r.occurrenceDate, r.amount, r.basis])).toEqual([
      ["2026-09-05", "0.00", "plan"],
      ["2026-09-12", "0.00", "plan"],
      ["2026-09-19", "0.00", "plan"],
      ["2026-09-26", "0.00", "plan"],
      ["2026-10-03", "120.00", "plan"],
      ["2026-10-10", "250.00", "plan"],
      ["2026-10-17", "250.00", "plan"],
      ["2026-10-24", "250.00", "plan"],
      ["2026-10-31", "250.00", "plan"],
    ]);
    // A hook never enters the bill matcher.
    expect((sig.matches ?? []).filter((m) => m.planItemId === weeklySpendId)).toEqual([]);
  });

  it("T2 a Chase debit tagged weekly shrinks this week's payoff by exactly its amount (250 → 220)", async () => {
    await txn({ on: "2026-10-06", amount: "-30.00", desc: "SHELL OIL", account: CHASE, source: "plaid:chase", weekly: true });
    const sig = await signal();
    expect(sig.bankToday).toBe("1970.00");
    expect(hookEvents(sig)[1]).toEqual(["2026-10-10", "-220.00", "2026-10-10", null]);
    // Cash and payoff together: the $30 is counted once.
    expect(balanceOn(sig, "2026-10-10")).toBe("1630.00");
  });

  it("T3 a weekly-flagged card charge moves money from remaining to charges: the payoff stays 250", async () => {
    await txn({ on: "2026-10-06", amount: "-25.00", desc: "QT FUEL", account: PLAT, source: "plaid:amex", weekly: true });
    const sig = await signal();
    expect(hookEvents(sig)[1]).toEqual(["2026-10-10", "-250.00", "2026-10-10", null]);
  });

  it("T4 an unplanned card charge sits on top of the allowance: 275", async () => {
    await txn({ on: "2026-10-06", amount: "-25.00", desc: "HOME DEPOT", account: PLAT, source: "plaid:amex", unplanned: true });
    const sig = await signal();
    expect(hookEvents(sig)[1]).toEqual(["2026-10-10", "-275.00", "2026-10-10", null]);
  });

  it("T5 (reimbursable precedence, quantified) a reimbursable charge flagged weekly is owed to Amex but leaves the allowance: payoff 275, remaining this week 210 (before PR-B2: 250 and 185)", async () => {
    await txn({ on: "2026-10-06", amount: "-25.00", desc: "URGENT CARE", account: PLAT, source: "plaid:amex", weekly: true, reimbursable: true });
    const sig = await signal();
    expect(hookEvents(sig)[1]).toEqual(["2026-10-10", "-275.00", "2026-10-10", null]);
    const pos = await buildMoneyPosition(HH, TEST_USER);
    expect(pos.remainingWeek).toBe("210.00");
  });

  it("T5b an UNFILED card charge is owed too (every coverage): it counts against the allowance AND in the charges — 250, never 200", async () => {
    await txn({ on: "2026-10-06", amount: "-50.00", desc: "WALGREENS", account: PLAT, source: "plaid:amex" });
    const sig = await signal();
    expect(hookEvents(sig)[1]).toEqual(["2026-10-10", "-250.00", "2026-10-10", null]);
    const pos = await buildMoneyPosition(HH, TEST_USER);
    expect([pos.remainingWeek, pos.needsClassificationWeek]).toEqual(["160.00", "50.00"]);
  });

  it("T6 last week paid by an Amex payment of that amount: off the curve, listed as paid (never silent)", async () => {
    const paid = await txn({ on: "2026-10-06", amount: "-120.00", desc: "AMERICAN EXPRESS ACH PMT", account: CHASE, source: "plaid:chase" });
    const sig = await signal();
    expect(sig.bankToday).toBe("1880.00");
    expect(hookEvents(sig)[0]).toEqual(["2026-10-10", "-250.00", "2026-10-10", null]);
    expect(sig.overdueAssumedPaid?.find((p) => p.planKey === `${weeklySpendId}|2026-10-03`)).toMatchObject({
      txnId: paid,
      planAmount: "-120.00",
      confidence: "card_payment",
      unpaidRemainder: "0.00",
    });
    expect(balanceOn(sig, "2026-10-08")).toBe("1880.00");
  });

  it("T7 (F1) an Amex payment of less than owed pays that much: last week's other $20 stays on the curve, listed paid in part (before F1: the whole $120 stayed on top of the $100 already out of cash — 1,780 on 10/8)", async () => {
    const paid = await txn({ on: "2026-10-06", amount: "-100.00", desc: "AMERICAN EXPRESS ACH PMT", account: CHASE, source: "plaid:chase" });
    const sig = await signal();
    expect(hookEvents(sig)[0]).toEqual(["2026-10-08", "-20.00", "2026-10-03", "overdue_remainder_assumed_unpaid"]);
    expect(sig.overdueAssumedPaid?.find((p) => p.planKey === `${weeklySpendId}|2026-10-03`)).toMatchObject({
      txnId: paid,
      planAmount: "-120.00",
      txnAmount: "-100.00",
      unpaidRemainder: "-20.00",
    });
    expect(balanceOn(sig, "2026-10-08")).toBe("1880.00");
  });

  it("T7b (round 2) an Amex payment covering MORE than owed (the statement in full) pays last week: off the curve, listed", async () => {
    const paid = await txn({ on: "2026-10-06", amount: "-150.00", desc: "AMERICAN EXPRESS ACH PMT", account: CHASE, source: "plaid:chase" });
    const sig = await signal();
    expect(sig.bankToday).toBe("1850.00");
    expect(hookEvents(sig)[0]).toEqual(["2026-10-10", "-250.00", "2026-10-10", null]);
    expect(sig.overdueAssumedPaid?.find((p) => p.planKey === `${weeklySpendId}|2026-10-03`)).toMatchObject({
      txnId: paid,
      planAmount: "-120.00",
      txnAmount: "-150.00",
      confidence: "card_payment",
    });
  });

  it("T8 confirming last week's occurrence in Review takes it off the curve, as for any plan", async () => {
    const paid = await txn({ on: "2026-10-06", amount: "-100.00", desc: "AMEX EPAYMENT", account: CHASE, source: "plaid:chase" });
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: HH,
      recurringItemId: weeklySpendId,
      occurrenceDate: "2026-10-03",
      status: "matched",
      matchedTxnId: paid,
    });
    const sig = await signal();
    expect(hookEvents(sig)[0]).toEqual(["2026-10-10", "-250.00", "2026-10-10", null]);
  });

  it("T9 (S2, one 'no plan' rule; F1) hooks, no allowance plan, a settings amount ($200): settings is NOT a plan — the open week keeps the stored $300 (40 charged + 260 left), a closed week owes its card purchases (before F1: the stored $300 for every closed week)", async () => {
    await db.delete(allowancePlansTable).where(eq(allowancePlansTable.householdId, HH));
    await setHooks({ weekly: { recurringItemId: weeklySpendId }, monthly: null }, { weeklyAllowanceAmount: "200" });
    const sig = await signal();
    expect(hookEvents(sig).slice(0, 4)).toEqual([
      ["2026-10-08", "-120.00", "2026-10-03", "overdue_assumed_unpaid"],
      ["2026-10-10", "-300.00", "2026-10-10", null],
      ["2026-10-17", "-300.00", "2026-10-17", null],
      ["2026-10-24", "-300.00", "2026-10-24", null],
    ]);
    expect(sig.hookAmountIgnored).toBeUndefined();
    // The money position says the same: no cap.
    expect((await buildMoneyPosition(HH, TEST_USER)).weekCap).toBeNull();
    // ...and the reserve says what it is: the stored amount, no plan set.
    expect(sig.hookReserves?.find((r) => r.occurrenceDate === "2026-10-10")).toEqual({
      hook: "weekly",
      recurringItemId: weeklySpendId,
      planKey: `${weeklySpendId}|2026-10-10`,
      occurrenceDate: "2026-10-10",
      label: "Weekly Spend",
      amount: "300.00",
      basis: "stored_amount",
      // (F1) The split: 40 charged on the card so far + 260 of the stored reserve left.
      storedAmount: "300.00",
      incurred: "40.00",
      paid: "0.00",
      carried: "0.00",
      carriedFrom: [],
      carriedTo: null,
      allowanceLeft: "260.00",
      cards: [{ accountId: PLAT, name: "Amex Platinum", mask: "1001", mode: "in_full", amount: "40.00" }],
    });
  });

  it("T9c (S2) a $0 override for this week is no plan too — the position reads no cap, and the hook keeps the stored $300 (before S2: a $0 cap, payoff = charges 40)", async () => {
    await setHooks({ weekly: { recurringItemId: weeklySpendId }, monthly: null }, { preferences: { everydayHooks: { weekly: { recurringItemId: weeklySpendId }, monthly: null }, weeklyAllowanceOverrides: { "2026-10-04": "0" } } });
    const sig = await signal();
    expect(hookEvents(sig)[1]).toEqual(["2026-10-10", "-300.00", "2026-10-10", null]);
    expect(sig.hookReserves?.find((r) => r.occurrenceDate === "2026-10-10")).toMatchObject({ amount: "300.00", basis: "stored_amount" });
    // Next week has the $250 plan again.
    expect(hookEvents(sig)[2]).toEqual(["2026-10-17", "-250.00", "2026-10-17", null]);
    expect(sig.hookReserves?.find((r) => r.occurrenceDate === "2026-10-17")).toMatchObject({ amount: "250.00", basis: "plan" });
    expect((await buildMoneyPosition(HH, TEST_USER)).weekCap).toBeNull();
  });

  it("T9b (round 2; F1) hooks with NO allowance at all (no plan, settings $0): the open and later weeks keep the stored $300 — never $0 — and no banner; a closed week owes its card purchases (before F1: $300 for each of the two closed weeks)", async () => {
    await db.delete(allowancePlansTable).where(eq(allowancePlansTable.householdId, HH));
    const sig = await signal();
    // The closed weeks owe what was charged and not paid: 9/26 nothing (off the curve), 10/3 the $120.
    expect(hookEvents(sig).slice(0, 4)).toEqual([
      ["2026-10-08", "-120.00", "2026-10-03", "overdue_assumed_unpaid"],
      ["2026-10-10", "-300.00", "2026-10-10", null],
      ["2026-10-17", "-300.00", "2026-10-17", null],
      ["2026-10-24", "-300.00", "2026-10-24", null],
    ]);
    expect(sig.hookAmountIgnored).toBeUndefined();
  });

  it("T10 no hooks: the Weekly Spend bill is a plain bill — $300 on Saturdays, no payoff, no banner (no funding bill = no reserve event)", async () => {
    await setHooks(undefined);
    const sig = await signal();
    expect(hookEvents(sig).slice(0, 2)).toEqual([
      ["2026-10-10", "-300.00", "2026-10-10", null],
      ["2026-10-17", "-300.00", "2026-10-17", null],
    ]);
    expect(sig.hookAmountIgnored).toBeUndefined();
  });

  it("T11 a paused hook item puts nothing on the curve and raises no banner", async () => {
    await db.update(recurringItemsTable).set({ active: "false" }).where(eq(recurringItemsTable.id, weeklySpendId));
    const sig = await signal();
    expect(hookEvents(sig)).toEqual([]);
    expect(sig.hookAmountIgnored).toBeUndefined();
  });
});

describe("(F1) the kill switch — HOOK_OBLIGATIONS=off puts the pre-F1 card-band model back", () => {
  afterEach(() => {
    delete process.env.HOOK_OBLIGATIONS;
  });

  it("T1 off: the same curve as before F1 — sized from the drag floor, last week's $120 on Thu 10/8, this week 250", async () => {
    process.env.HOOK_OBLIGATIONS = "off";
    const sig = await signal();
    expect(hookEvents(sig).slice(0, 2)).toEqual([
      ["2026-10-08", "-120.00", "2026-10-03", "overdue_assumed_unpaid"],
      ["2026-10-10", "-250.00", "2026-10-10", null],
    ]);
    expect(sig.hookReserves?.map((r) => r.occurrenceDate)[0]).toBe("2026-09-26");
  });

  it("T7 off: an Amex payment of less than owed proves nothing, as before F1 (the whole $120 stays: 1,780 on 10/8)", async () => {
    await txn({ on: "2026-10-06", amount: "-100.00", desc: "AMERICAN EXPRESS ACH PMT", account: CHASE, source: "plaid:chase" });
    process.env.HOOK_OBLIGATIONS = "off";
    const sig = await signal();
    expect(hookEvents(sig)[0]).toEqual(["2026-10-08", "-120.00", "2026-10-03", "overdue_assumed_unpaid"]);
    expect(balanceOn(sig, "2026-10-08")).toBe("1780.00");
  });
});

describe("(PR-B2) everydayHooks is server-owned", () => {
  it("a settings PUT can neither write nor clear it", () => {
    expect(SERVER_OWNED_PREFERENCE_KEYS).toContain("everydayHooks");
    const stored = { everydayHooks: { weekly: { recurringItemId: "a" }, monthly: null }, theme: "dark" };
    expect(keepServerOwnedPreferences(stored, { everydayHooks: { weekly: { recurringItemId: "b" } }, theme: "light" })).toEqual({
      theme: "light",
      everydayHooks: { weekly: { recurringItemId: "a" }, monthly: null },
    });
    expect(keepServerOwnedPreferences({ theme: "dark" }, { everydayHooks: { weekly: { recurringItemId: "b" } } })).toEqual({});
  });
});

// The backfill is the REAL file, run against this database.
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../lib/db/migrations");
describe("0042_everyday_hooks.sql — the one-time backfill", () => {
  const owners = ["a", "b", "c", "d"].map((k) => `${TEST_USER}-bf-${k}`);
  const ids: Record<string, string> = {};
  const hhOf: Record<string, string> = {};
  afterAll(async () => {
    for (const o of owners) await cleanup(o);
    await db.delete(householdsTable).where(inArray(householdsTable.ownerUserId, owners));
  });

  it("hooks the active items named exactly 'Weekly Spend' / 'Monthly Spend', leaves everyone else alone, and is idempotent", async () => {
    for (const o of owners) hhOf[o] = (await createTestHousehold(o)).householdId;
    const [a, b, c, d] = owners as [string, string, string, string];
    const item = async (owner: string, name: string, active = "true") => {
      const [r] = await db
        .insert(recurringItemsTable)
        .values({ userId: owner, householdId: hhOf[owner]!, name, kind: "bill", amount: "300", frequency: "weekly", anchorDate: "2026-10-10", active })
        .returning();
      return r!.id;
    };
    ids.aw = await item(a, "Weekly Spend");
    ids.am = await item(a, "Monthly Spend");
    await item(b, "weekly spend"); // not the exact name
    await item(b, "Weekly Spend", "false"); // paused
    ids.cw = await item(c, "Weekly Spend");
    ids.dw = await item(d, "Weekly Spend");
    await db.insert(settingsTable).values([
      { userId: a, householdId: hhOf[a]!, preferences: { theme: "dark" } },
      { userId: b, householdId: hhOf[b]!, preferences: null },
      // The owner (or a later package) already chose: never overwritten.
      { userId: c, householdId: hhOf[c]!, preferences: { everydayHooks: { weekly: null, monthly: null } } },
      // Preferences that are not an object read as {}.
      { userId: d, householdId: hhOf[d]!, preferences: [] as unknown as Record<string, unknown> },
    ]);
    const prefsOf = async () =>
      Object.fromEntries(
        (await db.select().from(settingsTable).where(inArray(settingsTable.userId, owners))).map((r) => [r.userId, r.preferences]),
      );

    const sql = readFileSync(join(MIGRATIONS, "0042_everyday_hooks.sql"), "utf8");
    await pool.query(sql);
    const first = await prefsOf();
    expect(first[a]).toEqual({ theme: "dark", everydayHooks: { weekly: { recurringItemId: ids.aw }, monthly: { recurringItemId: ids.am } } });
    expect(first[b]).toBeNull();
    expect(first[c]).toEqual({ everydayHooks: { weekly: null, monthly: null } });
    expect(first[d]).toEqual({ everydayHooks: { weekly: { recurringItemId: ids.dw }, monthly: null } });

    await pool.query(sql);
    expect(await prefsOf()).toEqual(first);
    void and;
  });
});
