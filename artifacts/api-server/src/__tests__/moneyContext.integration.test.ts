// (PR-H) `loadMoneyContext` — the shared server read for the household money
// model. Two things are new here and load-bearing for PR8r/PR10:
//   - `weeklyAllowanceOverrides` read SERVER-SIDE for the first time (today
//     only the web app reads them, straight off `useSettings()`);
//   - confirmed bill matches bounded to a date range, by the MATCHED
//     TRANSACTION's own date, not the bill's `occurrence_date`.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, forecastResolutionsTable, settingsTable, transactionsTable } from "@workspace/db";
import { everydayPlan } from "@workspace/avalanche-core";
import { loadMoneyContext } from "../lib/moneyContext";
import { createTestHousehold } from "./_helpers/testHousehold";

const TEST_USER = `pr-h-money-context-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let TEST_HOUSEHOLD_ID: string;

beforeAll(async () => {
  TEST_HOUSEHOLD_ID = (await createTestHousehold(TEST_USER)).householdId;
  await db
    .insert(settingsTable)
    .values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      weeklyAllowanceAmount: "150.00",
      monthlyAllowanceAmount: "400.00",
      unplannedAllowanceAmount: "75.00",
      preferences: {
        weeklyAllowanceOverrides: { "2026-09-06": "200.00" },
      },
    })
    .onConflictDoUpdate({
      target: settingsTable.userId,
      set: {
        weeklyAllowanceAmount: "150.00",
        monthlyAllowanceAmount: "400.00",
        unplannedAllowanceAmount: "75.00",
        preferences: { weeklyAllowanceOverrides: { "2026-09-06": "200.00" } },
        updatedAt: new Date(),
      },
    });
});

afterAll(async () => {
  await db.delete(transactionsTable).where(eq(transactionsTable.userId, TEST_USER));
  await db.delete(forecastResolutionsTable).where(eq(forecastResolutionsTable.userId, TEST_USER));
  await db.delete(settingsTable).where(eq(settingsTable.userId, TEST_USER));
});

describe("loadMoneyContext — settings and weeklyAllowanceOverrides", () => {
  it("reads the standing amounts and the overrides map", async () => {
    const ctx = await loadMoneyContext(TEST_HOUSEHOLD_ID, { start: "2026-09-01", end: "2026-09-30" });
    expect(ctx.settings.weeklyAllowanceAmount).toBe("150.00");
    expect(ctx.settings.monthlyAllowanceAmount).toBe("400.00");
    expect(ctx.settings.unplannedAllowanceAmount).toBe("75.00");
    expect(ctx.settings.weeklyAllowanceOverrides).toEqual({ "2026-09-06": "200.00" });
  });

  it("an override for the week changes everydayPlan; a week without one uses the default", async () => {
    const ctx = await loadMoneyContext(TEST_HOUSEHOLD_ID, { start: "2026-09-01", end: "2026-09-30" });

    // 2026-09-06 (Sunday) has an override.
    const overriddenWeek = everydayPlan(
      "2026-09-06",
      ctx.settings,
      ctx.settings.weeklyAllowanceOverrides,
    );
    expect(overriddenWeek.weeklyCents).toBe(20000);

    // 2026-08-30 (Sunday, no override) falls back to the standing amount.
    const plainWeek = everydayPlan(
      "2026-08-30",
      ctx.settings,
      ctx.settings.weeklyAllowanceOverrides,
    );
    expect(plainWeek.weeklyCents).toBe(15000);

    // Monthly is never overridden.
    expect(overriddenWeek.monthlyCents).toBe(40000);
    expect(plainWeek.monthlyCents).toBe(40000);
  });
});

describe("loadMoneyContext — confirmed bill matches, bounded to the range", () => {
  it("includes a matched transaction dated in range, by its OWN date", async () => {
    const [txn] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-09-15",
        description: "STATE FARM AUTO",
        amount: "-120.00",
      })
      .returning({ id: transactionsTable.id });
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      recurringItemId: "rec-1",
      // The bill's own occurrence date is OUTSIDE the range we'll query —
      // matchedTxnIds must still find it, because it bounds by the matched
      // transaction's date, not this one.
      occurrenceDate: "2026-08-01",
      status: "matched",
      matchedTxnId: txn!.id,
    });

    const inRange = await loadMoneyContext(TEST_HOUSEHOLD_ID, {
      start: "2026-09-01",
      end: "2026-09-30",
    });
    expect(inRange.matchedTxnIds.has(txn!.id)).toBe(true);

    const outOfRange = await loadMoneyContext(TEST_HOUSEHOLD_ID, {
      start: "2026-10-01",
      end: "2026-10-31",
    });
    expect(outOfRange.matchedTxnIds.has(txn!.id)).toBe(false);
  });

  it("excludes a resolution that is not matched or partial", async () => {
    const [txn] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-09-20",
        description: "GENERIC CHARGE",
        amount: "-40.00",
      })
      .returning({ id: transactionsTable.id });
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      recurringItemId: "rec-2",
      occurrenceDate: "2026-09-20",
      status: "skipped",
      matchedTxnId: txn!.id,
    });

    const ctx = await loadMoneyContext(TEST_HOUSEHOLD_ID, { start: "2026-09-01", end: "2026-09-30" });
    expect(ctx.matchedTxnIds.has(txn!.id)).toBe(false);
  });

  it("a 'partial' match counts the same as 'matched'", async () => {
    const [txn] = await db
      .insert(transactionsTable)
      .values({
        userId: TEST_USER,
        householdId: TEST_HOUSEHOLD_ID,
        occurredOn: "2026-09-22",
        description: "PARTIAL PAYMENT",
        amount: "-30.00",
      })
      .returning({ id: transactionsTable.id });
    await db.insert(forecastResolutionsTable).values({
      userId: TEST_USER,
      householdId: TEST_HOUSEHOLD_ID,
      recurringItemId: "rec-3",
      occurrenceDate: "2026-09-22",
      status: "partial",
      matchedTxnId: txn!.id,
    });

    const ctx = await loadMoneyContext(TEST_HOUSEHOLD_ID, { start: "2026-09-01", end: "2026-09-30" });
    expect(ctx.matchedTxnIds.has(txn!.id)).toBe(true);
  });
});

describe("loadMoneyContext — shape", () => {
  it("returns a supersede result and a filing context ready for effectiveFiling", async () => {
    const ctx = await loadMoneyContext(TEST_HOUSEHOLD_ID, { start: "2026-09-01", end: "2026-09-30" });
    expect(ctx.supersede.replacedIds).toBeInstanceOf(Set);
    expect(ctx.supersede.replacedBy).toBeInstanceOf(Map);
    expect(ctx.filingCtx.uncategorizedIds).toBeInstanceOf(Set);
  });

  it("resolves to no checking account and an empty Amex cadence map for a household with no linked Plaid accounts", async () => {
    const ctx = await loadMoneyContext(TEST_HOUSEHOLD_ID, { start: "2026-09-01", end: "2026-09-30" });
    expect(ctx.checkingAccountExternalId).toBeNull();
    expect(ctx.amexCardCadence.size).toBe(0);
  });
});
