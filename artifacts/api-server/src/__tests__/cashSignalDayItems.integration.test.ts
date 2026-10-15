// ⭐ (T3) `CashSignal.dayItems` — every item the walk applied, read back.
//
// The Forecast day panel says "opening + money in − money out = close" for a
// day. Before T3 it could not: `events` carries planned expenses only, so a
// payday or a bank row moved the close without a line to show for it. The
// walk itself is untouched (`walkLedger` reports each applied item through
// `onApply`); `dayItems` is that list, mapped. This suite proves, on every
// horizon the route allows, that the list IS the walk:
//   ∀d daily[d-1] + Σ dayItems[d] = daily[d]   (startingBalance before day 1)
//   Σ in = projectedIncome · Σ out = projectedExpenses · start + in − out = end
// and pins the window edges (an item on the first and last day is listed; one
// the day before is already in the starting balance; one the day after is not
// walked). Synthetic household; today is pinned to Thursday 2026-05-14.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  db,
  forecastSettingsTable,
  recurringItemsTable,
  transactionsTable,
  forecastResolutionsTable,
  plaidAccountsTable,
  plaidItemsTable,
} from "@workspace/db";
import { computeCashSignal } from "../lib/cashSignal";
import { createTestHousehold } from "./_helpers/testHousehold";
import { createdAtStartOfHouseholdDay } from "./_helpers/ledgerCreatedAt";
import { expectDayItemsReconcile } from "./_helpers/dayItemsReconcile";

const TEST_USER = `day-items-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let HOUSEHOLD: string;
const PINNED_NOW = new Date("2026-05-14T12:00:00Z");
const CHASE = "day-items-chase";
/** The route's horizon whitelist (`ALLOWED_HORIZON_DAYS`, routes/forecast.ts). */
const HORIZONS = [7, 30, 90, 120, 183, 365] as const;

async function cleanup(): Promise<void> {
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(recurringItemsTable).where(eq(recurringItemsTable.userId, TEST_USER));
  await db.delete(forecastSettingsTable).where(eq(forecastSettingsTable.userId, TEST_USER));
  await db.delete(plaidAccountsTable).where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

beforeAll(async () => {
  HOUSEHOLD = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
});
afterAll(cleanup);
beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(PINNED_NOW);
  await cleanup();
});
afterEach(() => {
  vi.useRealTimers();
});

async function snapshotOnChase(balance: string, at: Date, cashBuffer = "500"): Promise<void> {
  const [item] = await db
    .insert(plaidItemsTable)
    .values({ userId: TEST_USER, householdId: HOUSEHOLD, itemId: `item-${randomUUID()}`, accessToken: "test-token", institutionSlug: "chase" })
    .returning();
  const [acct] = await db
    .insert(plaidAccountsTable)
    .values({
      userId: TEST_USER,
      householdId: HOUSEHOLD,
      itemId: item!.id,
      accountId: CHASE,
      name: "Test Checking",
      mask: "0000",
      subtype: "checking",
      type: "depository",
    })
    .returning();
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: HOUSEHOLD,
    daysAhead: 90,
    startingBalance: "0",
    cashBuffer,
    bankSnapshotBalance: balance,
    bankSnapshotAt: at,
    bankSnapshotSource: "plaid",
    bankSnapshotAccountId: acct!.id,
    bankSnapshotMask: "0000",
  });
}

async function recurring(over: Partial<typeof recurringItemsTable.$inferInsert>) {
  const [r] = await db
    .insert(recurringItemsTable)
    .values({
      userId: TEST_USER,
      householdId: HOUSEHOLD,
      name: "Bill",
      kind: "expense",
      amount: "100",
      frequency: "monthly",
      dayOfMonth: 15,
      anchorDate: "2026-01-15",
      active: "true",
      ...over,
    })
    .returning();
  return r!;
}

/** A posted checking row; `at` (the bank's own time, also when it reached the ledger) places it after a same-day read. */
async function chaseRow(occurredOn: string, amount: string, at?: Date) {
  const [t] = await db
    .insert(transactionsTable)
    .values({
      userId: TEST_USER,
      householdId: HOUSEHOLD,
      occurredOn,
      description: `row ${occurredOn} ${amount}`,
      amount,
      plaidAccountId: CHASE,
      source: "plaid:chase",
      pending: false,
      forecastFlag: false,
      plaidTransactionId: `di-${randomUUID()}`,
      createdAt: at ?? createdAtStartOfHouseholdDay(occurredOn),
      occurredAt: at ? at.toISOString() : null,
    })
    .returning();
  return t!;
}

/**
 * Read at 06:00 CT today ($1,000.00). After the read, today: a −$42.17 charge,
 * a +$250.00 deposit and a −$30.00 row matched to Water's 05-20 occurrence.
 * Rent on the 1st, Water on the 20th, a biweekly $2,000.00 paycheck from 05-15,
 * and Phone (due 05-12, unresolved) carried to the next business day.
 */
async function household(): Promise<{ waterRowId: string }> {
  await snapshotOnChase("1000", new Date("2026-05-14T11:00:00Z"));
  await recurring({ name: "Rent", amount: "1500", dayOfMonth: 1, anchorDate: "2026-01-01" });
  await recurring({ name: "Paycheck", kind: "income", amount: "2000", frequency: "biweekly", dayOfMonth: null, anchorDate: "2026-05-15" });
  await recurring({ name: "Phone", amount: "95", dayOfMonth: 12, anchorDate: "2026-01-12" });
  const water = await recurring({ name: "Water", amount: "30", dayOfMonth: 20, anchorDate: "2026-01-20" });
  const afterRead = new Date("2026-05-14T11:30:00Z");
  await chaseRow("2026-05-14", "-42.17", afterRead);
  await chaseRow("2026-05-14", "250", afterRead);
  const paid = await chaseRow("2026-05-14", "-30", afterRead);
  await db.insert(forecastResolutionsTable).values({
    userId: TEST_USER,
    householdId: HOUSEHOLD,
    recurringItemId: water.id,
    occurrenceDate: "2026-05-20",
    status: "matched",
    matchedTxnId: paid.id,
  } as typeof forecastResolutionsTable.$inferInsert);
  return { waterRowId: paid.id };
}

describe("cash signal dayItems — the walk, read back", () => {
  it("reconciles to the cent on every allowed horizon", async () => {
    await household();
    for (const horizonDays of HORIZONS) {
      const sig = await computeCashSignal(HOUSEHOLD, TEST_USER, { horizonDays });
      expect(sig.horizonDays).toBe(horizonDays);
      expectDayItemsReconcile(sig, `${horizonDays} days`);
    }
  });

  it("lists the bank rows after the reading, the payday and the carried bill on their days", async () => {
    const { waterRowId } = await household();
    const sig = await computeCashSignal(HOUSEHOLD, TEST_USER, { horizonDays: 30 });
    expectDayItemsReconcile(sig);
    const items = sig.dayItems!;

    // Today's bank rows: on the curve's first day, signed, the matched one flagged.
    const today = items.filter((i) => i.date === "2026-05-14");
    expect(today.every((i) => i.kind === "bank_row")).toBe(true);
    expect(today.map((i) => i.amount).sort()).toEqual(["-30.00", "-42.17", "250.00"]);
    const matched = today.filter((i) => i.kind === "bank_row" && i.matched);
    expect(matched).toHaveLength(1);
    expect(matched[0]!.kind === "bank_row" && matched[0]!.txnId).toBe(waterRowId);
    expect(sig.acceptedImpact).toBe("-30.00");

    // The payday is income (never in `events`), on its own day.
    const pay = items.filter((i) => i.kind === "income");
    expect(pay.map((i) => [i.date, i.amount])).toEqual([
      ["2026-05-15", "2000.00"],
      ["2026-05-29", "2000.00"],
      ["2026-06-12", "2000.00"],
    ]);
    expect((sig.events ?? []).some((e) => Number(e.amount) > 0)).toBe(false);

    // Phone, due 05-12 and unresolved, lands on Fri 05-15 with its reason and key.
    const phone = items.find((i) => i.kind === "expense" && i.label === "Phone" && i.date === "2026-05-15");
    expect(phone).toMatchObject({ amount: "-95.00", originalDate: "2026-05-12", occurrenceDate: "2026-05-12", assumption: "overdue_assumed_unpaid" });

    // Water's 05-20 occurrence was matched to today's row: it is not walked again.
    expect(items.some((i) => i.kind === "expense" && i.label === "Water" && i.date === "2026-05-20")).toBe(false);
  });

  it("window edges: the first and last day are listed, the day before is in the start, the day after is not walked", async () => {
    await snapshotOnChase("800", new Date("2026-05-14T11:00:00Z"), "100");
    await recurring({ name: "Before", amount: "11", dayOfMonth: 19, anchorDate: "2026-01-19" });
    await recurring({ name: "First", amount: "22", dayOfMonth: 20, anchorDate: "2026-01-20" });
    await recurring({ name: "Last", amount: "33", dayOfMonth: 27, anchorDate: "2026-01-27" });
    await recurring({ name: "After", amount: "44", dayOfMonth: 28, anchorDate: "2026-01-28" });
    const sig = await computeCashSignal(HOUSEHOLD, TEST_USER, { fromDate: "2026-05-20", horizonDays: 7 });
    expectDayItemsReconcile(sig);
    expect([sig.fromDate, sig.toDate]).toEqual(["2026-05-20", "2026-05-27"]);
    expect(sig.dayItems!.map((i) => [i.date, i.kind !== "bank_row" ? i.label : i.txnId])).toEqual([
      ["2026-05-20", "First"],
      ["2026-05-27", "Last"],
    ]);
    // "Before" (05-19) is already inside the starting balance: 800 − 11.
    expect(sig.startingBalance).toBe("789.00");
  });

  it("no bank reading, a window after today: the plan before the window lands on its first day, and still reconciles", async () => {
    await db.insert(forecastSettingsTable).values({
      userId: TEST_USER,
      householdId: HOUSEHOLD,
      daysAhead: 90,
      startingBalance: "1800",
      cashBuffer: "200",
    });
    await recurring({ name: "Mid-month bill", amount: "65", dayOfMonth: 16, anchorDate: "2026-01-16" });
    await recurring({ name: "Paycheck", kind: "income", amount: "1500", frequency: "biweekly", dayOfMonth: null, anchorDate: "2026-05-22" });
    const sig = await computeCashSignal(HOUSEHOLD, TEST_USER, { fromDate: "2026-05-20", horizonDays: 20 });
    expect(sig.status).toBe("no_data");
    expectDayItemsReconcile(sig);
    const first = sig.dayItems!.find((i) => i.kind === "expense" && i.label === "Mid-month bill");
    expect(first).toMatchObject({ date: "2026-05-20", assumption: "pre_window_on_first_day" });
    expect(sig.dayItems!.filter((i) => i.kind === "income").map((i) => i.date)).toEqual(["2026-05-22", "2026-06-05"]);
  });
});

/**
 * (T3) The horizons the web asks for are the ones the route allows: the cash
 * signal answers 400 to any other (the dashboard once offered 180). Read from
 * the sources themselves, so a change on either side fails here.
 */
describe("horizon whitelist mirror", () => {
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const numbers = (text: string) => (text.match(/\d+/g) ?? []).map(Number);

  it("the route's whitelist is this suite's, and every web horizon is in it", () => {
    const route = src("../routes/forecast.ts").match(/ALLOWED_HORIZON_DAYS = new Set\(\[([^\]]+)\]\)/);
    expect(route).not.toBeNull();
    const allowed = numbers(route![1]!);
    expect(allowed).toEqual([...HORIZONS]);

    const dash = src("../../../h2budget/src/pages/next/dashboard/ForecastPanel.tsx").match(/export const HORIZONS = \[([^\]]+)\]/);
    expect(dash).not.toBeNull();
    const page = src("../../../h2budget/src/pages/forecast.tsx").match(/const HORIZON_OPTS: HorizonOpt\[\] = \[([\s\S]*?)\n\];/);
    expect(page).not.toBeNull();
    const pageDays = [...page![1]!.matchAll(/days: (\d+)/g)].map((m) => Number(m[1]));
    expect(pageDays.length).toBeGreaterThan(0);
    for (const h of [...numbers(dash![1]!), ...pageDays]) expect(allowed, `web horizon ${h}`).toContain(h);
  });
});
