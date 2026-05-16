// (#47) Unit tests for the cash-signal projection math.
//
// computeCashSignal owns the safety net behind the "Avalanche Ready"
// cue — a regression in snapshot anchoring, matched-resolution
// suppression, or status thresholds could silently push extra
// payments into unsafe territory. These tests pin the contract.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import {
  db,
  forecastSettingsTable,
  recurringItemsTable,
  transactionsTable,
  forecastResolutionsTable,
  plaidAccountsTable,
  plaidItemsTable,
  debtsTable,
  avalancheSettingsTable,
} from "@workspace/db";
import { computeCashSignal } from "../lib/cashSignal";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `cash-signal-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

async function cleanup(): Promise<void> {
  await db
    .delete(forecastResolutionsTable)
    .where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db
    .delete(transactionsTable)
    .where(eq(transactionsTable.userId, TEST_USER));
  await db
    .delete(recurringItemsTable)
    .where(eq(recurringItemsTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
  await db
    .delete(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, TEST_USER));
  await db
    .delete(plaidAccountsTable)
    .where(eq(plaidAccountsTable.userId, TEST_USER));
  await db.delete(plaidItemsTable).where(eq(plaidItemsTable.userId, TEST_USER));
}

// (#650) Pin "now" so the drag-to-today rule is deterministic across
// CI runs. Without this, every test that has a snapshot/fromDate in
// the past silently behaves differently depending on what day the
// suite happens to run — and the production scenario regression below
// can only assert "today = 2026-05-14" if `new Date()` reports it.
const PINNED_NOW = new Date("2026-05-14T12:00:00Z");

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
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

async function setSettings(opts: {
  balance?: string | null;
  at?: Date | null;
  cashBuffer?: string;
  startingBalance?: string;
  daysAhead?: number;
} = {}): Promise<void> {
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
    householdId: TEST_HOUSEHOLD_ID,
    daysAhead: opts.daysAhead ?? 90,
    startingBalance: opts.startingBalance ?? "0",
    cashBuffer: opts.cashBuffer ?? "500",
    bankSnapshotBalance: opts.balance ?? null,
    bankSnapshotAt: opts.at ?? null,
    bankSnapshotSource: opts.balance != null ? "manual" : null,
  });
}

async function addRecurring(
  over: Partial<typeof recurringItemsTable.$inferInsert> = {},
) {
  const [r] = await db
    .insert(recurringItemsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Bill",
      kind: "expense",
      amount: "200",
      frequency: "monthly",
      dayOfMonth: 15,
      anchorDate: "2026-01-15",
      active: "true",
      ...over,
    })
    .returning();
  return r;
}

describe("computeCashSignal — snapshot anchoring", () => {
  it("(#666) pre-snapshot pending plans are dropped — snapshot is truth, not dragged onto today", async () => {
    // (#666) Inverted from the old (#650) assertion. The previous
    // semantic dragged pre-snapshot pending plans onto today, which
    // silently shifted the chart's first point up or down depending
    // on whether the dragged events happened to net positive or
    // negative. Real-world bug: bank $4,922.56, but the chart started
    // at $3,805 (drag negative) one day, then ~$8,000 (drag positive)
    // the next day after a partial fix. Both wrong.
    //
    // New semantic: the bank snapshot is the truth. Anything dated
    // on or before it is already reflected — drop it entirely. The
    // chart line is flat at the snapshot value from fromDate through
    // today, and stays at the snapshot value on today when nothing
    // is actionable.
    await setSettings({
      balance: "3248.68",
      at: new Date("2026-05-13T12:00:00Z"),
      cashBuffer: "500",
    });
    await addRecurring({
      frequency: "onetime",
      anchorDate: "2026-05-13",
      amount: "1989.81",
    });
    await addRecurring({
      frequency: "onetime",
      anchorDate: "2026-05-10",
      amount: "38.00",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-05-01",
      horizonDays: 30,
    });

    // Snapshot is truth — pre-snapshot plans are dropped, not dragged.
    expect(sig.startingBalance).toBe("3248.68");
    const daily = sig.daily ?? [];
    // Every day from fromDate through today is flat at the snapshot.
    const flatRange = daily.filter(
      (d) => d.date >= "2026-05-01" && d.date <= "2026-05-14",
    );
    for (const d of flatRange) {
      expect(d.balance).toBe("3248.68");
    }
    // No drag onto today; no markers for the pre-snapshot dates.
    const eventDates = (sig.events ?? []).map((e) => e.date);
    expect(eventDates).not.toContain("2026-05-14");
    expect(eventDates).not.toContain("2026-05-13");
    expect(eventDates).not.toContain("2026-05-10");
  });

  it("(#666) when fromDate == today, snapshot-day plans are dropped (chart starts at bank balance)", async () => {
    // Companion to the broader (#666) drop rule: a recurring plan
    // dated exactly on the snapshot date does NOT drag onto today.
    // The chart's first day equals the bank balance to the cent.
    await setSettings({
      balance: "3248.68",
      at: new Date("2026-05-13T12:00:00Z"),
      cashBuffer: "500",
    });
    await addRecurring({
      frequency: "onetime",
      anchorDate: "2026-05-13",
      amount: "1989.81",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-05-14",
      horizonDays: 14,
    });

    expect(sig.startingBalance).toBe("3248.68");
    expect(sig.daily?.[0]).toEqual({
      date: "2026-05-14",
      balance: "3248.68",
    });
  });

  it("(#666/#681) pre-snapshot income drops; pre-snapshot expense drags to today+1", async () => {
    // User's Forecast scenario: bank $4,922.56, real recurring
    // income dated <= snapshot, and a real recurring expense dated
    // <= snapshot. (#666) pinned that day-0 must equal the bank
    // balance — neither side double-counts. (#681) refines this:
    // past-due unresolved EXPENSE pendings drag to today+1 so the
    // user still sees the upcoming impact, while INCOME continues to
    // drop (a past-due deposit that didn't land is more likely a
    // real miss than a delayed-but-coming check).
    await setSettings({
      balance: "4922.56",
      at: new Date("2026-05-14T12:00:00Z"),
      cashBuffer: "0",
    });
    await addRecurring({
      kind: "expense",
      frequency: "onetime",
      anchorDate: "2026-05-12",
      amount: "1117.29",
    });
    await addRecurring({
      kind: "income",
      frequency: "onetime",
      anchorDate: "2026-05-13",
      amount: "3500.00",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-05-14",
      horizonDays: 30,
    });

    // Day 0 (today = 2026-05-14) still equals the bank snapshot.
    expect(sig.startingBalance).toBe("4922.56");
    expect(sig.daily?.[0]).toEqual({
      date: "2026-05-14",
      balance: "4922.56",
    });
    // Day 1 (today+1 = 2026-05-15) absorbs the dragged expense; the
    // pre-snapshot income stays dropped.
    expect(sig.daily?.[1]).toEqual({
      date: "2026-05-15",
      balance: "3805.27",
    });
    // Pre-snapshot dates do NOT appear as their own markers — the
    // dragged expense surfaces on today+1 instead.
    const eventDates = (sig.events ?? []).map((e) => e.date);
    expect(eventDates).not.toContain("2026-05-12");
    expect(eventDates).not.toContain("2026-05-13");
    expect(eventDates).not.toContain("2026-05-14");
    expect(eventDates).toContain("2026-05-15");
    // The marker for the dragged expense preserves its original date
    // for the "Pending plans dragging this day" UI.
    const dragged = (sig.events ?? []).find(
      (e) => e.date === "2026-05-15" && e.originalDate === "2026-05-12",
    );
    expect(dragged?.amount).toBe("-1117.29");
  });

  it("(#667) synthetic debt-min events dated before the snapshot do NOT drag onto today", async () => {
    // User's bug report: "All my pending is matched, no forecasted
    // pending, why is the bank off?" — bank $4,922.56, chart starts at
    // $3,805.27 (down $1,117) with the Pending list completely empty.
    //
    // Root cause: `expandDebtMin` (and `expandAvalancheExtra`) used to
    // emit events back to the prior-month start to mirror the recurring
    // expansion lookback. But synthetic events have NO Pending UI row
    // the user can match/skip/miss, so any pre-snapshot synthetic event
    // would silently drag onto today with no way for the user to
    // dismiss the dip. Snapshot is the truth — anything dated on or
    // before it is already reflected in the bank balance.
    //
    // This test pins the fix: a debt-min that would naturally land on
    // a pre-snapshot date is suppressed entirely and does NOT pull the
    // chart down on today.
    await setSettings({
      balance: "4922.56",
      at: new Date("2026-05-13T12:00:00Z"),
      cashBuffer: "0",
    });
    // Debt with dueDay=10 → would emit 04-10 and 05-10 events back at
    // expandStart=2026-04-01 under the old behavior. Both fall on/before
    // the snapshot date (05-13) and would drag onto today (05-14).
    await db.insert(debtsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Capital One Platinum",
      kind: "credit_card",
      balance: "1000",
      minPayment: "38",
      dueDay: 10,
      active: "true",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-05-14",
      horizonDays: 30,
    });

    // Chart starts AT the bank snapshot — no silent drag from the
    // pre-snapshot synthetic debt-min.
    expect(sig.startingBalance).toBe("4922.56");
    expect(sig.daily?.[0]).toEqual({
      date: "2026-05-14",
      balance: "4922.56",
    });
    // Future debt-min events (06-10, 07-10, ...) still project normally.
    const eventDates = (sig.events ?? []).map((e) => e.date).sort();
    expect(eventDates).not.toContain("2026-04-10");
    expect(eventDates).not.toContain("2026-05-10");
    expect(eventDates.some((d) => d >= "2026-05-14")).toBe(true);
  });

  it("(#667) synthetic Avalanche extra payment dated before the snapshot does NOT drag", async () => {
    // Companion to the debt-min regression: the avalanche extra series
    // is also synthetic (no Pending UI row) and must respect the same
    // snapshot anchor. Snapshot=2026-05-13, today=05-14, fromDate=05-14.
    // The 04-30 month-end avalanche extra would otherwise expand back
    // to expandStart=2026-04-01 and drag onto today.
    await setSettings({
      balance: "4922.56",
      at: new Date("2026-05-13T12:00:00Z"),
      cashBuffer: "0",
    });
    await db.insert(debtsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Capital One Platinum",
      kind: "credit_card",
      balance: "1000",
      minPayment: "38",
      dueDay: 25, // post-snapshot, so debt-min isn't the noise here
      active: "true",
    });
    await db.insert(avalancheSettingsTable).values({
      userId: TEST_USER,
      manualExtra: "200",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-05-14",
      horizonDays: 30,
    });

    expect(sig.startingBalance).toBe("4922.56");
    expect(sig.daily?.[0]).toEqual({
      date: "2026-05-14",
      balance: "4922.56",
    });
    // 04-30 avalanche extra is suppressed; 05-31 still appears.
    const eventDates = (sig.events ?? []).map((e) => e.date);
    expect(eventDates).not.toContain("2026-04-30");
    expect(eventDates).toContain("2026-05-31");
  });

  it("(#667/#681) boundary: synthetic event dated exactly on today drags to today+1", async () => {
    // Snapshot=2026-05-13, today=2026-05-14 (PINNED_NOW), dueDay=14
    // → first synthetic debt-min lands on 2026-05-14 = today. It is
    // NOT suppressed (#667), but because it is past-due-as-of-today
    // (#681) the projection hops it to today+1 = 2026-05-15 so the
    // chart's day-0 point still equals the bank snapshot.
    await setSettings({
      balance: "1000",
      at: new Date("2026-05-13T12:00:00Z"),
      cashBuffer: "0",
    });
    await db.insert(debtsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      name: "Edge Card",
      kind: "credit_card",
      balance: "500",
      minPayment: "38",
      dueDay: 14,
      active: "true",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-05-14",
      horizonDays: 30,
    });

    const eventDates = (sig.events ?? []).map((e) => e.date);
    // Dragged to today+1, not on today itself.
    expect(eventDates).not.toContain("2026-05-14");
    expect(eventDates).toContain("2026-05-15");
    // Day 0 equals the bank snapshot; day 1 absorbs the drag.
    expect(sig.daily?.[0]).toEqual({
      date: "2026-05-14",
      balance: "1000.00",
    });
    expect(sig.daily?.[1]).toEqual({
      date: "2026-05-15",
      balance: "962.00",
    });
  });

  it("drag-to-today: with no pending plans, the chart stays flat at the snapshot value", async () => {
    await setSettings({
      balance: "3248.68",
      at: new Date("2026-05-13T12:00:00Z"),
      cashBuffer: "0",
    });
    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-05-14",
      horizonDays: 14,
    });
    expect(sig.startingBalance).toBe("3248.68");
    expect(sig.daily?.[0]).toEqual({
      date: "2026-05-14",
      balance: "3248.68",
    });
    expect(sig.lowestProjected).toBe("3248.68");
  });

  it("drag-to-today: when fromDate > today, post-snapshot pre-from plans flow to roll-forward (NOT to today, NOT to fromDate)", async () => {
    // Locks the "view chart starting from a future date" branch.
    // Setup: snapshot on 04-01, today=05-14 (pinned), fromDate=06-01.
    // A plan dated 04-15 is AFTER the snapshot but BEFORE fromDate;
    // it must be consumed by the pre-window roll-forward into
    // startingBalance, not dragged to today (05-14) or fromDate (06-01).
    await setSettings({
      balance: "1000",
      at: new Date("2026-04-01T12:00:00Z"),
      cashBuffer: "0",
    });
    await addRecurring({
      frequency: "onetime",
      anchorDate: "2026-04-15",
      amount: "300",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-06-01",
      horizonDays: 30,
    });

    // Plan was consumed by the pre-window roll-forward → starting
    // balance is reduced, no day-0 dip, no today (05-14) dip.
    expect(sig.startingBalance).toBe("700.00");
    expect(sig.daily?.[0]).toEqual({
      date: "2026-06-01",
      balance: "700.00",
    });
    expect(sig.projectedExpenses).toBe("0.00");
    const eventDates = (sig.events ?? []).map((e) => e.date);
    expect(eventDates).not.toContain("2026-04-15");
    expect(eventDates).not.toContain("2026-05-14");
    expect(eventDates).not.toContain("2026-06-01");
  });

  it("(#681) production May-15/May-16 scenario: two past-due pendings drag to today+1", async () => {
    // User's production screenshot: today=2026-05-16, bank=$4,871.20
    // (snapshot dated today), Verizon -$400 and PlayStation -$18.98
    // both planned 2026-05-15 with no resolution. Day-0 must equal
    // the bank balance, day-1 must drop by $418.98.
    vi.setSystemTime(new Date("2026-05-16T12:00:00Z"));
    await setSettings({
      balance: "4871.20",
      at: new Date("2026-05-16T12:00:00Z"),
      cashBuffer: "0",
    });
    await addRecurring({
      kind: "expense",
      frequency: "onetime",
      anchorDate: "2026-05-15",
      amount: "400.00",
      name: "Verizon Wireless",
    });
    await addRecurring({
      kind: "expense",
      frequency: "onetime",
      anchorDate: "2026-05-15",
      amount: "18.98",
      name: "PlayStation Network",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-05-16",
      horizonDays: 30,
    });

    expect(sig.startingBalance).toBe("4871.20");
    expect(sig.daily?.[0]).toEqual({
      date: "2026-05-16",
      balance: "4871.20",
    });
    expect(sig.daily?.[1]).toEqual({
      date: "2026-05-17",
      balance: "4452.22",
    });
    expect(sig.lowestDate).toBe("2026-05-17");
    expect(sig.lowestProjected).toBe("4452.22");
    // Both dragged events surface on 05-17 with their original 05-15
    // date preserved for the "Pending plans dragging this day" UI.
    const draggedOn17 = (sig.events ?? []).filter(
      (e) => e.date === "2026-05-17" && e.originalDate === "2026-05-15",
    );
    expect(draggedOn17.length).toBe(2);
  });

  it("(#681) the hop target follows real time — same plans land on day after today", async () => {
    // Same two pendings as the May-15/16 scenario, but one real-world
    // day later: today=05-17 (snapshot unchanged at 05-16=$4871.20).
    // The dip must roll forward to today+1 = 2026-05-18.
    vi.setSystemTime(new Date("2026-05-17T12:00:00Z"));
    await setSettings({
      balance: "4871.20",
      at: new Date("2026-05-16T12:00:00Z"),
      cashBuffer: "0",
    });
    await addRecurring({
      kind: "expense",
      frequency: "onetime",
      anchorDate: "2026-05-15",
      amount: "400.00",
      name: "Verizon Wireless",
    });
    await addRecurring({
      kind: "expense",
      frequency: "onetime",
      anchorDate: "2026-05-15",
      amount: "18.98",
      name: "PlayStation Network",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-05-17",
      horizonDays: 30,
    });

    // Day 0 still equals the bank; the dip is on today+1, NOT today.
    expect(sig.daily?.[0]).toEqual({
      date: "2026-05-17",
      balance: "4871.20",
    });
    expect(sig.daily?.[1]).toEqual({
      date: "2026-05-18",
      balance: "4452.22",
    });
    const eventDates = (sig.events ?? []).map((e) => e.date);
    expect(eventDates).not.toContain("2026-05-17");
    expect(eventDates.filter((d) => d === "2026-05-18").length).toBe(2);
  });

  it("(#681) marking a past-due pending 'missed' clears its drag", async () => {
    // Same May-15/16 scenario, but the Verizon plan now has a
    // 'missed' resolution. Only PlayStation continues to drag onto
    // today+1; the day-1 dip is $18.98, not $418.98.
    vi.setSystemTime(new Date("2026-05-16T12:00:00Z"));
    await setSettings({
      balance: "4871.20",
      at: new Date("2026-05-16T12:00:00Z"),
      cashBuffer: "0",
    });
    const verizon = await addRecurring({
      kind: "expense",
      frequency: "onetime",
      anchorDate: "2026-05-15",
      amount: "400.00",
      name: "Verizon Wireless",
    });
    await addRecurring({
      kind: "expense",
      frequency: "onetime",
      anchorDate: "2026-05-15",
      amount: "18.98",
      name: "PlayStation Network",
    });
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      recurringItemId: verizon.id,
      occurrenceDate: "2026-05-15",
      status: "missed",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-05-16",
      horizonDays: 30,
    });

    expect(sig.daily?.[0]).toEqual({
      date: "2026-05-16",
      balance: "4871.20",
    });
    expect(sig.daily?.[1]).toEqual({
      date: "2026-05-17",
      balance: "4852.22",
    });
    const draggedOn17 = (sig.events ?? []).filter(
      (e) => e.date === "2026-05-17",
    );
    expect(draggedOn17.length).toBe(1);
    expect(draggedOn17[0].amount).toBe("-18.98");
  });

  it("(#681) past-due unresolved income is dropped, never landing on day 0", async () => {
    // snapshot=2026-05-15 ($1000), today=2026-05-16. An unresolved
    // income of +$500 planned for 2026-05-15 (or even for today) is
    // past-due. It must NOT land on day-0 — that would push the
    // chart's first point above the bank balance and break the
    // bank=day-0 invariant. It also does NOT drag forward, because
    // not-yet-landed paychecks shouldn't inflate tomorrow's
    // projection either.
    vi.setSystemTime(new Date("2026-05-16T12:00:00Z"));
    await setSettings({
      balance: "1000",
      at: new Date("2026-05-15T12:00:00Z"),
      cashBuffer: "0",
    });
    await addRecurring({
      kind: "income",
      frequency: "onetime",
      anchorDate: "2026-05-15",
      amount: "500.00",
      name: "Paycheck",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-05-16",
      horizonDays: 30,
    });

    expect(sig.startingBalance).toBe("1000.00");
    expect(sig.daily?.[0]).toEqual({
      date: "2026-05-16",
      balance: "1000.00",
    });
    expect(sig.daily?.[1]).toEqual({
      date: "2026-05-17",
      balance: "1000.00",
    });
    expect(sig.endingBalance).toBe("1000.00");
    const eventDates = (sig.events ?? []).map((e) => e.date);
    expect(eventDates).not.toContain("2026-05-15");
    expect(eventDates).not.toContain("2026-05-16");
    expect(eventDates).not.toContain("2026-05-17");
  });

  it("(#681) when today is in-window, past-due expenses drag to today+1 instead of rolling forward", async () => {
    // snapshot=04-01, today=05-14 (PINNED_NOW), fromDate=05-01,
    // horizon=30 → toDate=05-31, so today is INSIDE the window.
    // A 04-15 expense is past-due-as-of-today; under (#681) it must
    // drag to today+1 (05-15) so the user can still see it weighing
    // on the projection, rather than being silently consumed into
    // startingBalance by the pre-window roll-forward.
    await setSettings({
      balance: "1000",
      at: new Date("2026-04-01T12:00:00Z"),
      cashBuffer: "0",
    });
    await addRecurring({
      frequency: "onetime",
      anchorDate: "2026-04-15",
      amount: "300",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-05-01",
      horizonDays: 30,
    });

    expect(sig.bankToday).toBe("1000.00");
    // No roll-forward consumption — the past-due expense drags into
    // the window instead.
    expect(sig.startingBalance).toBe("1000.00");
    expect(sig.projectedExpenses).toBe("300.00");
    expect(sig.endingBalance).toBe("700.00");
    expect(sig.lowestDate).toBe("2026-05-15");
    const eventDates = (sig.events ?? []).map((e) => e.date);
    expect(eventDates).toContain("2026-05-15");
    expect(eventDates).not.toContain("2026-04-15");
  });
});

describe("computeCashSignal — matched resolution suppression", () => {
  it("a same-day-as-snapshot occurrence with a 'matched' resolution does NOT drag (no double-count)", async () => {
    // Regression for the drag-until-matched fix: when the user matches
    // the snapshot-day plan to a real bank txn (the snapshot already
    // reflects), matchedPlanKeys must suppress the drag so we don't
    // double-count the same outflow.
    await setSettings({
      balance: "1000",
      at: new Date("2026-04-15T12:00:00Z"),
      cashBuffer: "0",
    });
    const item = await addRecurring({ dayOfMonth: 15, amount: "200" });
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      recurringItemId: item.id,
      occurrenceDate: "2026-04-15",
      status: "matched",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-04-15",
      horizonDays: 31,
    });

    // 04-15 suppressed by match; only 05-15 drags.
    expect(sig.endingBalance).toBe("800.00");
    expect(sig.projectedExpenses).toBe("200.00");
    expect(sig.lowestProjected).toBe("800.00");
    expect(sig.lowestDate).toBe("2026-05-15");
  });

  it("removes plan items whose forecast_resolutions row is 'matched'", async () => {
    await setSettings({
      balance: "1000",
      at: new Date("2026-04-01T12:00:00Z"),
      cashBuffer: "0",
    });
    // Two events expected in the window: 04-15 and 05-15, $200 each.
    const item = await addRecurring({ dayOfMonth: 15, amount: "200" });

    // Mark the 04-15 occurrence as matched. Without the suppression
    // it would double-count alongside whatever real bank txn the user
    // already saw.
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      recurringItemId: item.id,
      occurrenceDate: "2026-04-15",
      status: "matched",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-04-01",
      horizonDays: 60, // covers both 04-15 and 05-15
    });

    // Only 05-15 should hit the projection; 04-15 is suppressed.
    expect(sig.endingBalance).toBe("800.00");
    expect(sig.projectedExpenses).toBe("200.00");
    expect(sig.lowestProjected).toBe("800.00");
    expect(sig.lowestDate).toBe("2026-05-15");
  });

  it("does not suppress unmatched ('pending'/other status) resolutions", async () => {
    await setSettings({
      balance: "1000",
      at: new Date("2026-04-01T12:00:00Z"),
      cashBuffer: "0",
    });
    const item = await addRecurring({ dayOfMonth: 15, amount: "200" });

    // A resolution row exists but is not 'matched' — projection must
    // still apply the planned event.
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      recurringItemId: item.id,
      occurrenceDate: "2026-04-15",
      status: "pending",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-04-01",
      horizonDays: 60,
    });

    // Both 04-15 and 05-15 should apply: 1000 - 200 - 200 = 600.
    expect(sig.endingBalance).toBe("600.00");
    expect(sig.projectedExpenses).toBe("400.00");
  });
});

describe("computeCashSignal — status thresholds", () => {
  it("returns 'no_data' when there is no bank snapshot, falling back to startingBalance", async () => {
    await setSettings({
      balance: null,
      startingBalance: "750",
      cashBuffer: "500",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-04-01",
      horizonDays: 30,
    });

    expect(sig.status).toBe("no_data");
    // No-snapshot fallback uses startingBalance for both bankToday and
    // the chart's starting balance.
    expect(sig.bankToday).toBe("750.00");
    expect(sig.startingBalance).toBe("750.00");
    expect(sig.snapshotAt).toBeNull();
    expect(sig.snapshotSource).toBeNull();
  });

  it("returns 'ready' when lowest >= cashBuffer + 200", async () => {
    await setSettings({
      balance: "1000",
      at: new Date("2026-04-01T12:00:00Z"),
      cashBuffer: "300",
    });
    // No bills: lowest stays at 1000 ≥ 300 + 200 → ready.
    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-04-01",
      horizonDays: 30,
    });
    expect(sig.lowestProjected).toBe("1000.00");
    expect(sig.status).toBe("ready");
    expect(sig.maxSafeExtra).toBe("700.00");
  });

  it("returns 'tight' when lowest is in [cashBuffer, cashBuffer + 200)", async () => {
    await setSettings({
      balance: "650",
      at: new Date("2026-04-01T12:00:00Z"),
      cashBuffer: "500",
    });
    // No bills: lowest = 650, in [500, 700) → tight.
    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-04-01",
      horizonDays: 30,
    });
    expect(sig.lowestProjected).toBe("650.00");
    expect(sig.status).toBe("tight");
    expect(sig.maxSafeExtra).toBe("150.00");
  });

  it("returns 'tight' exactly at the cashBuffer boundary", async () => {
    await setSettings({
      balance: "500",
      at: new Date("2026-04-01T12:00:00Z"),
      cashBuffer: "500",
    });
    // lowest == cashBuffer is the boundary case — still 'tight',
    // never 'not_yet'.
    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-04-01",
      horizonDays: 30,
    });
    expect(sig.lowestProjected).toBe("500.00");
    expect(sig.status).toBe("tight");
    expect(sig.maxSafeExtra).toBe("0.00");
  });

  it("returns 'not_yet' when lowest falls below cashBuffer", async () => {
    await setSettings({
      balance: "600",
      at: new Date("2026-04-01T12:00:00Z"),
      cashBuffer: "500",
    });
    // 04-15 bill of $200 drops the balance to 400 < 500.
    await addRecurring({ dayOfMonth: 15, amount: "200" });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-04-01",
      horizonDays: 30,
    });
    expect(sig.lowestProjected).toBe("400.00");
    expect(sig.lowestDate).toBe("2026-04-15");
    expect(sig.status).toBe("not_yet");
    // headroom is clamped at 0 — we never recommend extra payments
    // when we're already below the buffer.
    expect(sig.maxSafeExtra).toBe("0.00");
  });

  it("returns 'ready' exactly at the cashBuffer + 200 boundary", async () => {
    await setSettings({
      balance: "700",
      at: new Date("2026-04-01T12:00:00Z"),
      cashBuffer: "500",
    });
    // lowest == cashBuffer + 200 is the boundary case — must be 'ready'.
    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-04-01",
      horizonDays: 30,
    });
    expect(sig.lowestProjected).toBe("700.00");
    expect(sig.status).toBe("ready");
    expect(sig.maxSafeExtra).toBe("200.00");
  });
});

describe("computeCashSignal — rescheduled resolutions", () => {
  it("moves a plan item from its original date to rescheduledTo", async () => {
    // PINNED_NOW = 2026-05-14. Use post-today one-time expenses so
    // the (#681) drag-to-today+1 rule does not fire — this test
    // isolates the rescheduledTo mechanism.
    await setSettings({
      balance: "1000",
      at: new Date("2026-05-14T12:00:00Z"),
      cashBuffer: "0",
    });
    const item = await addRecurring({
      frequency: "onetime",
      anchorDate: "2026-05-20",
      amount: "200",
      name: "First",
    });
    await addRecurring({
      frequency: "onetime",
      anchorDate: "2026-06-15",
      amount: "200",
      name: "Second",
    });

    // Reschedule the 05-20 occurrence to 05-25. The projection should
    // skip 05-20 and instead drop the balance on 05-25; 06-15 keeps
    // its place.
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      recurringItemId: item.id,
      occurrenceDate: "2026-05-20",
      status: "rescheduled",
      rescheduledTo: "2026-05-25",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-05-14",
      horizonDays: 60, // covers 05-25 and 06-15
    });

    // Both events still hit (just one of them on a moved date):
    // 1000 - 200 (05-25) - 200 (06-15) = 600.
    expect(sig.endingBalance).toBe("600.00");
    expect(sig.projectedExpenses).toBe("400.00");
    // Lowest is reached at the second hit, 06-15.
    expect(sig.lowestProjected).toBe("600.00");
    expect(sig.lowestDate).toBe("2026-06-15");
    // The rescheduled date is surfaced in the chart's per-day events,
    // and the original 05-20 is NOT.
    const eventDates = (sig.events ?? []).map((e) => e.date);
    expect(eventDates).toContain("2026-05-25");
    expect(eventDates).toContain("2026-06-15");
    expect(eventDates).not.toContain("2026-05-20");
  });
});

describe("computeCashSignal — skipped resolutions", () => {
  // (#480 / #490) A 'skipped' resolution must remove the occurrence
  // from BOTH the projected balance and the per-day `events` markers.
  // Pin both behaviors here so a future refactor of the projection
  // can't quietly bring the skipped occurrence back.
  it("drops a skipped occurrence from the projection AND from expenseEvents", async () => {
    await setSettings({
      balance: "1000",
      at: new Date("2026-04-01T12:00:00Z"),
      cashBuffer: "0",
    });
    // Two events expected in the window: 04-15 and 05-15, $200 each.
    const item = await addRecurring({ dayOfMonth: 15, amount: "200" });

    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      recurringItemId: item.id,
      occurrenceDate: "2026-04-15",
      status: "skipped",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-04-01",
      horizonDays: 60, // covers both 04-15 and 05-15
    });

    // Only 05-15 hits: 1000 - 200 = 800. Skipped 04-15 must NOT
    // contribute to projectedExpenses or drag the balance down.
    expect(sig.endingBalance).toBe("800.00");
    expect(sig.projectedExpenses).toBe("200.00");
    expect(sig.lowestProjected).toBe("800.00");
    expect(sig.lowestDate).toBe("2026-05-15");
    // The chart's per-day events list must omit 04-15 entirely (no
    // marker), while 05-15 is still present.
    const eventDates = (sig.events ?? []).map((e) => e.date);
    expect(eventDates).not.toContain("2026-04-15");
    expect(eventDates).toContain("2026-05-15");
  });

  it("control: without the skipped resolution, the same occurrence IS included", async () => {
    // Same setup as the skip case, minus the resolution row. Uses
    // post-today one-time expenses so neither hit is reshaped by the
    // (#681) drag-to-today+1 rule — the only difference between this
    // test and the previous one is the 'skipped' resolution row.
    await setSettings({
      balance: "1000",
      at: new Date("2026-05-14T12:00:00Z"),
      cashBuffer: "0",
    });
    await addRecurring({
      frequency: "onetime",
      anchorDate: "2026-05-20",
      amount: "200",
      name: "First",
    });
    await addRecurring({
      frequency: "onetime",
      anchorDate: "2026-06-15",
      amount: "200",
      name: "Second",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-05-14",
      horizonDays: 60,
    });

    // Both 05-20 and 06-15 apply: 1000 - 200 - 200 = 600.
    expect(sig.endingBalance).toBe("600.00");
    expect(sig.projectedExpenses).toBe("400.00");
    expect(sig.lowestProjected).toBe("600.00");
    expect(sig.lowestDate).toBe("2026-06-15");
    const eventDates = (sig.events ?? []).map((e) => e.date);
    expect(eventDates).toContain("2026-05-20");
    expect(eventDates).toContain("2026-06-15");
  });
});

describe("computeCashSignal — matched-txn bank filtering", () => {
  async function addPlaidAccount(opts: {
    externalId: string;
    name: string;
    institutionSlug?: string;
  }): Promise<{ id: string; externalId: string }> {
    const [item] = await db
      .insert(plaidItemsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: `item-${randomUUID()}`,
        accessToken: "test-token",
        institutionSlug: opts.institutionSlug ?? "chase",
      })
      .returning();
    const [acct] = await db
      .insert(plaidAccountsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        itemId: item.id,
        accountId: opts.externalId,
        name: opts.name,
      })
      .returning();
    return { id: acct.id, externalId: acct.accountId };
  }

  async function addTxn(opts: {
    occurredOn: string;
    amount: string;
    plaidAccountId?: string | null;
    source?: string;
  }): Promise<string> {
    const [t] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: opts.occurredOn,
        description: "matched",
        amount: opts.amount,
        plaidAccountId: opts.plaidAccountId ?? null,
        source: opts.source ?? "manual",
      })
      .returning({ id: transactionsTable.id });
    return t.id;
  }

  it("suppresses the plan item when matched_txn_id belongs to the configured Chase account", async () => {
    const chase = await addPlaidAccount({
      externalId: "chase-ext-1",
      name: "Chase Checking",
      institutionSlug: "chase",
    });
    await setSettings({
      balance: "1000",
      at: new Date("2026-04-01T12:00:00Z"),
      cashBuffer: "0",
    });
    // Wire the snapshot to the Chase account so isBankRow recognizes
    // its external id.
    await db
      .update(forecastSettingsTable)
      .set({ bankSnapshotAccountId: chase.id })
      .where(eq(forecastSettingsTable.userId, TEST_USER));

    const item = await addRecurring({ dayOfMonth: 15, amount: "200" });
    // Real bank withdrawal already in the snapshot (dated before
    // anchor so it doesn't itself add to projected items).
    const chaseTxnId = await addTxn({
      occurredOn: "2026-03-30",
      amount: "-200",
      plaidAccountId: chase.externalId,
      source: "plaid:chase",
    });
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      recurringItemId: item.id,
      occurrenceDate: "2026-04-15",
      status: "matched",
      matchedTxnId: chaseTxnId,
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-04-01",
      horizonDays: 60, // covers 04-15 and 05-15
    });

    // Chase match → 04-15 plan item is suppressed; only 05-15 hits.
    expect(sig.endingBalance).toBe("800.00");
    expect(sig.projectedExpenses).toBe("200.00");
    expect(sig.lowestDate).toBe("2026-05-15");
  });

  it("ignores a 'matched' resolution whose matched txn is on a non-Chase (Amex) account", async () => {
    const chase = await addPlaidAccount({
      externalId: "chase-ext-2",
      name: "Chase Checking",
      institutionSlug: "chase",
    });
    const amex = await addPlaidAccount({
      externalId: "amex-ext-1",
      name: "Amex Card",
      institutionSlug: "amex",
    });
    await setSettings({
      balance: "1000",
      at: new Date("2026-04-01T12:00:00Z"),
      cashBuffer: "0",
    });
    await db
      .update(forecastSettingsTable)
      .set({ bankSnapshotAccountId: chase.id })
      .where(eq(forecastSettingsTable.userId, TEST_USER));

    const item = await addRecurring({ dayOfMonth: 15, amount: "200" });
    // Legacy resolution: someone matched the planned bill against an
    // Amex charge. The bank projection MUST ignore this match — the
    // bill still has to come out of Chase.
    const amexTxnId = await addTxn({
      occurredOn: "2026-03-30",
      amount: "-200",
      plaidAccountId: amex.externalId,
      source: "plaid:amex",
    });
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      recurringItemId: item.id,
      occurrenceDate: "2026-04-15",
      status: "matched",
      matchedTxnId: amexTxnId,
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-04-01",
      horizonDays: 60,
    });

    // Amex match is filtered out → both 04-15 and 05-15 apply:
    // 1000 - 200 - 200 = 600.
    expect(sig.endingBalance).toBe("600.00");
    expect(sig.projectedExpenses).toBe("400.00");
    expect(sig.lowestDate).toBe("2026-05-15");
  });
});
