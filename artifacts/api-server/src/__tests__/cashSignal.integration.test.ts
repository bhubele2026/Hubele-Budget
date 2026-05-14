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

beforeAll(async () => {
  const _h = await createTestHousehold(TEST_USER);
  TEST_HOUSEHOLD_ID = _h.householdId;
  await cleanup();
});
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
  it("snapshot wins: plan occurrences dated on/before the bank snapshot do NOT drag the projection", async () => {
    // User's Real Scenario (#h2budget): bank snapshot $3,248.68 on
    // May 13 from Plaid; chart was showing "Lowest $2,507 · May 13"
    // because four unmatched pending plans dated <= May 13 were being
    // subtracted from the snapshot value. The snapshot IS the truth
    // for its date; plans dated on/before the snapshot must not drag
    // the chart line below the actual bank balance. Pre-snapshot
    // pending plans remain visible in the planned-items register so
    // the user can match / mark missed / skip them — but they no
    // longer synthesize a fake past trajectory.
    await setSettings({
      balance: "1000",
      at: new Date("2026-04-15T12:00:00Z"),
      cashBuffer: "0",
    });
    // Monthly $200 on the 15th. Expansion in this window produces
    // 2026-04-15 (snapshot day) and 2026-05-15 (post-snapshot). Only
    // 05-15 should drag — 04-15 is suppressed by snapshot-wins.
    await addRecurring({ dayOfMonth: 15, amount: "200" });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-04-15",
      horizonDays: 31,
    });

    expect(sig.bankToday).toBe("1000.00");
    // On the snapshot day (chart's first day here), balance equals the
    // snapshot — pre/same-day plans are suppressed.
    expect(sig.startingBalance).toBe("1000.00");
    expect(sig.daily?.[0]).toEqual({ date: "2026-04-15", balance: "1000.00" });
    // Only the post-snapshot 05-15 occurrence drags.
    expect(sig.endingBalance).toBe("800.00");
    expect(sig.lowestProjected).toBe("800.00");
    expect(sig.lowestDate).toBe("2026-05-15");
    expect(sig.projectedExpenses).toBe("200.00");
    expect(sig.projectedIncome).toBe("0.00");
    expect(sig.snapshotAt).not.toBeNull();
  });

  it("snapshot wins even when fromDate is BEFORE the snapshot (chart's pre-snapshot section is flat at snapshot value)", async () => {
    // Reproduces the production chart shape: fromDate = May 1, snapshot
    // = May 13. The pre-snapshot section (May 1 - May 13) was being
    // synthesized by walking the May-13 snapshot value backwards and
    // subtracting unmatched pre-snapshot pending plans, producing a
    // fictional dip. Now the chart line stays flat at the snapshot
    // value through the snapshot date, then projects forward from
    // there.
    await setSettings({
      balance: "3248.68",
      at: new Date("2026-05-13T12:00:00Z"),
      cashBuffer: "500",
    });
    // A pre-snapshot pending plan on 05-10 (still unmatched) — the
    // bug was that this dragged the May 1-13 line down by $741.
    await addRecurring({
      frequency: "onetime",
      anchorDate: "2026-05-10",
      amount: "741.12",
    });

    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-05-01",
      horizonDays: 60,
    });

    // Pre-snapshot pending plan must NOT drag the projection.
    expect(sig.startingBalance).toBe("3248.68");
    // Every day from fromDate through the snapshot date equals the
    // snapshot value — no fake dip below it.
    const through13 = (sig.daily ?? []).filter((d) => d.date <= "2026-05-13");
    expect(through13.length).toBeGreaterThan(0);
    for (const d of through13) {
      expect(d.balance).toBe("3248.68");
    }
    // The chart's lowest must not be below the snapshot value when no
    // post-snapshot plans drag it.
    expect(Number(sig.lowestProjected)).toBeGreaterThanOrEqual(3248.68);

    // PARALLEL "with pending" branch line: pre-snapshot dates equal
    // the main line; on/after snapshot date the pending impact is
    // applied so the user sees "if pending posts, you'd land here".
    expect(sig.pendingPreSnapshotImpact).toBe("-741.12");
    const wp = sig.dailyWithPending ?? [];
    expect(wp.length).toBe((sig.daily ?? []).length);
    const wpBeforeSnap = wp.filter((d) => d.date < "2026-05-13");
    for (const d of wpBeforeSnap) expect(d.balance).toBe("3248.68");
    const wpOnSnap = wp.find((d) => d.date === "2026-05-13");
    expect(wpOnSnap?.balance).toBe("2507.56"); // 3248.68 - 741.12
    expect(Number(sig.lowestProjectedWithPending)).toBeCloseTo(2507.56, 2);
    expect(sig.lowestDateWithPending).toBe("2026-05-13");
  });

  it("when there are no pre-snapshot pending plans, dailyWithPending equals daily and pendingPreSnapshotImpact is 0", async () => {
    await setSettings({
      balance: "1000",
      at: new Date("2026-04-15T12:00:00Z"),
      cashBuffer: "0",
    });
    const sig = await computeCashSignal(TEST_HOUSEHOLD_ID, TEST_USER, {
      fromDate: "2026-04-15",
      horizonDays: 14,
    });
    expect(sig.pendingPreSnapshotImpact).toBe("0.00");
    expect(sig.dailyWithPending).toEqual(sig.daily);
    expect(sig.lowestProjectedWithPending).toBe(sig.lowestProjected);
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
