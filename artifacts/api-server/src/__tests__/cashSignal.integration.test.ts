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

const TEST_USER = `cash-signal-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;

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

beforeAll(cleanup);
afterAll(cleanup);
beforeEach(cleanup);

async function setSettings(opts: {
  balance?: string | null;
  at?: Date | null;
  cashBuffer?: string;
  startingBalance?: string;
  daysAhead?: number;
} = {}): Promise<void> {
  await db.insert(forecastSettingsTable).values({
    userId: TEST_USER,
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
  it("skips events on or before the snapshot date (already baked into the snapshot balance)", async () => {
    await setSettings({
      balance: "1000",
      at: new Date("2026-04-15T12:00:00Z"),
      cashBuffer: "0",
    });
    // Monthly $200 on the 15th. Within the test window the expansion
    // produces 2026-04-15 and 2026-05-15. Only 05-15 should reduce the
    // projection — 04-15 is already accounted for in the $1,000
    // snapshot taken on the same day.
    await addRecurring({ dayOfMonth: 15, amount: "200" });

    const sig = await computeCashSignal(TEST_USER, {
      fromDate: "2026-04-15",
      horizonDays: 31,
    });

    expect(sig.bankToday).toBe("1000.00");
    expect(sig.startingBalance).toBe("1000.00");
    expect(sig.endingBalance).toBe("800.00");
    expect(sig.lowestProjected).toBe("800.00");
    expect(sig.lowestDate).toBe("2026-05-15");
    expect(sig.projectedExpenses).toBe("200.00");
    expect(sig.projectedIncome).toBe("0.00");
    expect(sig.snapshotAt).not.toBeNull();
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

    const sig = await computeCashSignal(TEST_USER, {
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
      recurringItemId: item.id,
      occurrenceDate: "2026-04-15",
      status: "matched",
    });

    const sig = await computeCashSignal(TEST_USER, {
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
      recurringItemId: item.id,
      occurrenceDate: "2026-04-15",
      status: "pending",
    });

    const sig = await computeCashSignal(TEST_USER, {
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

    const sig = await computeCashSignal(TEST_USER, {
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
    const sig = await computeCashSignal(TEST_USER, {
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
    const sig = await computeCashSignal(TEST_USER, {
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
    const sig = await computeCashSignal(TEST_USER, {
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

    const sig = await computeCashSignal(TEST_USER, {
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
    const sig = await computeCashSignal(TEST_USER, {
      fromDate: "2026-04-01",
      horizonDays: 30,
    });
    expect(sig.lowestProjected).toBe("700.00");
    expect(sig.status).toBe("ready");
    expect(sig.maxSafeExtra).toBe("200.00");
  });
});
