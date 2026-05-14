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
  it("drag-to-today: pre-snapshot pending plans get pulled to TODAY (not fromDate, not snapshot date) when fromDate < today", async () => {
    // User's Real Scenario (#650): bank snapshot $3,248.68 on
    // May 13 from Plaid; two unmatched pending plans dated on/before
    // May 13 (Mortgage -$1,989.81 on 05-13, Capital One -$38.00 on
    // 05-10). The user views the chart with fromDate = May 1 (start
    // of month) and today = May 14.
    //
    // Wrong shapes we've shipped before:
    //   - dip on the SNAPSHOT date (May 13) → wrong: the snapshot IS
    //     the bank's truth for May 13, the line must be flat there.
    //   - dip on FROMDATE (May 1) → wrong: the snapshot proves the
    //     line was flat from May 1 through May 13.
    //
    // Right shape: line flat at $3,248.68 from May 1 through May 13,
    // drops to $1,220.87 on May 14 (today).
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

    // Starting balance reflects the snapshot — pre-snapshot plans were
    // NOT consumed by the pre-window roll-forward; they wait for today.
    expect(sig.startingBalance).toBe("3248.68");
    // Every day from fromDate (05-01) through the snapshot date
    // (05-13) is flat at the snapshot value.
    const daily = sig.daily ?? [];
    const flatRange = daily.filter(
      (d) => d.date >= "2026-05-01" && d.date <= "2026-05-13",
    );
    expect(flatRange.length).toBe(13);
    for (const d of flatRange) {
      expect(d.balance).toBe("3248.68");
    }
    // Today (05-14) takes the full hit: 3248.68 - 1989.81 - 38.00.
    const today = daily.find((d) => d.date === "2026-05-14");
    expect(today?.balance).toBe("1220.87");
    expect(sig.lowestProjected).toBe("1220.87");
    expect(sig.lowestDate).toBe("2026-05-14");
    // Both expense events surface as markers on TODAY, not on their
    // original pre-snapshot dates.
    const eventDates = (sig.events ?? []).map((e) => e.date);
    expect(eventDates.filter((d) => d === "2026-05-14").length).toBe(2);
    expect(eventDates).not.toContain("2026-05-13");
    expect(eventDates).not.toContain("2026-05-10");
    // (#650) Each dragged event keeps its pre-drag date in
    // `originalDate` so the chart tooltip can label them as "dragging
    // this day" instead of mixing them with bills naturally due today.
    const draggedEvents = (sig.events ?? []).filter(
      (e) => e.date === "2026-05-14",
    );
    const draggedOriginals = draggedEvents
      .map((e) => (e as { originalDate?: string }).originalDate)
      .sort();
    expect(draggedOriginals).toEqual(["2026-05-10", "2026-05-13"]);
    for (const e of draggedEvents) {
      expect(
        (e as { originalDate?: string }).originalDate,
      ).not.toBe(e.date);
    }
  });

  it("drag-to-today: when fromDate == today, pending plans still snap to today", async () => {
    // Sanity case for the existing "view chart starting today"
    // shape — drag target is MAX(today, fromISO) = today either way.
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
      balance: "1258.87",
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

  it("rolls the balance forward from anchor up to fromDate when fromDate > snapshot date", async () => {
    await setSettings({
      balance: "1000",
      at: new Date("2026-04-01T12:00:00Z"),
      cashBuffer: "0",
    });
    // One-time $300 bill on 04-15 — between snapshot (04-01) and the
    // chart's first day (05-01). Should be applied to startingBalance,
    // not the daily projection inside the window.
    await addRecurring({
      frequency: "onetime",
      anchorDate: "2026-04-15",
      amount: "300",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-05-01",
      horizonDays: 30,
    });

    // bankToday is the snapshot value at the anchor, not yet rolled forward.
    expect(sig.bankToday).toBe("1000.00");
    // startingBalance reflects the anchor balance after applying events
    // strictly between the anchor and the chart's first day.
    expect(sig.startingBalance).toBe("700.00");
    // The 04-15 event must NOT show up inside the window's projected
    // expenses — it was consumed by the roll-forward.
    expect(sig.projectedExpenses).toBe("0.00");
    expect(sig.endingBalance).toBe("700.00");
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
    await setSettings({
      balance: "1000",
      at: new Date("2026-04-01T12:00:00Z"),
      cashBuffer: "0",
    });
    // Monthly $200 on the 15th. Within the test window the expansion
    // produces 2026-04-15 and 2026-05-15.
    const item = await addRecurring({ dayOfMonth: 15, amount: "200" });

    // Reschedule the 04-15 occurrence to 04-25. The projection should
    // skip 04-15 and instead drop the balance on 04-25; 05-15 keeps
    // its place. A regression here would either double-count (apply
    // both 04-15 and 04-25) or silently skip the rescheduled hit.
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      recurringItemId: item.id,
      occurrenceDate: "2026-04-15",
      status: "rescheduled",
      rescheduledTo: "2026-04-25",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-04-01",
      horizonDays: 60, // covers 04-25 and 05-15
    });

    // Both events still hit (just one of them on a moved date):
    // 1000 - 200 (04-25) - 200 (05-15) = 600.
    expect(sig.endingBalance).toBe("600.00");
    expect(sig.projectedExpenses).toBe("400.00");
    // Lowest is reached at the second hit, 05-15.
    expect(sig.lowestProjected).toBe("600.00");
    expect(sig.lowestDate).toBe("2026-05-15");
    // The rescheduled date is surfaced in the chart's per-day events,
    // and the original 04-15 is NOT.
    const eventDates = (sig.events ?? []).map((e) => e.date);
    expect(eventDates).toContain("2026-04-25");
    expect(eventDates).toContain("2026-05-15");
    expect(eventDates).not.toContain("2026-04-15");
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

  it("control: without the skipped resolution, the same 04-15 occurrence IS included", async () => {
    // Same setup as the skip case, minus the resolution row. If the
    // skip filter regresses, the previous test would still pass when
    // the occurrence is silently kept — this control fails loudly to
    // prove the only difference between included and excluded is the
    // 'skipped' resolution row.
    await setSettings({
      balance: "1000",
      at: new Date("2026-04-01T12:00:00Z"),
      cashBuffer: "0",
    });
    await addRecurring({ dayOfMonth: 15, amount: "200" });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-04-01",
      horizonDays: 60,
    });

    // Both 04-15 and 05-15 apply: 1000 - 200 - 200 = 600.
    expect(sig.endingBalance).toBe("600.00");
    expect(sig.projectedExpenses).toBe("400.00");
    expect(sig.lowestProjected).toBe("600.00");
    expect(sig.lowestDate).toBe("2026-05-15");
    const eventDates = (sig.events ?? []).map((e) => e.date);
    expect(eventDates).toContain("2026-04-15");
    expect(eventDates).toContain("2026-05-15");
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
