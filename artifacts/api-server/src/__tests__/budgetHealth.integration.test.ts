// Engine test for the Budget Health score + daily snapshot/trend/deltas.
// The score is 100% computed in code (CLAUDE.md §1) — this exercises the real
// computeBudgetHealth + upsert/trend/delta path against a real Postgres. The
// Fable 5 narrative (healthAdvisorSummary) is NOT exercised here — it's an
// independent, fallback-guarded layer that needs no DB.
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createTestHousehold } from "./_helpers/testHousehold";
import { db, debtsTable, budgetHealthHistoryTable } from "@workspace/db";
import { computeBudgetHealth } from "../lib/healthScore";
import {
  upsertTodayHealth,
  getHealthTrend,
  computeDeltas,
  type HealthTrendPoint,
} from "../lib/healthSnapshot";

const TEST_USER = `health-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
let HH: string;

async function cleanup(): Promise<void> {
  await db.delete(budgetHealthHistoryTable).where(eq(budgetHealthHistoryTable.userId, TEST_USER));
  await db.delete(debtsTable).where(eq(debtsTable.userId, TEST_USER));
}

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  HH = (await createTestHousehold(TEST_USER)).householdId;
  await cleanup();
});
afterAll(cleanup);
beforeEach(cleanup);

describe("computeBudgetHealth", () => {
  it("returns a well-formed, debt-weighted score", async () => {
    await db.insert(debtsTable).values({
      userId: TEST_USER,
      householdId: HH,
      name: "Card A",
      balance: "2000.00",
      apr: "0.1800",
      minPayment: "150.00",
      status: "active",
    });

    const h = await computeBudgetHealth(HH, TEST_USER);

    expect(h.score).toBeGreaterThanOrEqual(0);
    expect(h.score).toBeLessThanOrEqual(100);
    expect(Number.isInteger(h.score)).toBe(true);
    // Four weighted dimensions, weights sum to 1, debt is the heaviest.
    expect(h.dimensions.map((d) => d.key).sort()).toEqual(["cash", "debt", "savings", "spending"]);
    const weightSum = h.dimensions.reduce((s, d) => s + d.weight, 0);
    expect(Math.abs(weightSum - 1)).toBeLessThan(1e-9);
    expect(h.dimensions.find((d) => d.key === "debt")!.weight).toBe(0.45);
    // status band + grade agree with the score.
    expect(h.status).toBe(h.score >= 75 ? "green" : h.score >= 50 ? "yellow" : "red");
    expect(["A", "B", "C", "D", "F"]).toContain(h.grade);
    expect(h.facts.totalDebt).toBeCloseTo(2000, 0);
  });

  it("an underwater debt tanks the debt dimension", async () => {
    // Monthly interest (~$250) far exceeds the $40 minimum → underwater.
    await db.insert(debtsTable).values({
      userId: TEST_USER,
      householdId: HH,
      name: "Underwater",
      balance: "10000.00",
      apr: "0.3000",
      minPayment: "40.00",
      status: "active",
    });

    const h = await computeBudgetHealth(HH, TEST_USER);
    expect(h.facts.underwater).toBe(true);
    const debtDim = h.dimensions.find((d) => d.key === "debt")!;
    expect(debtDim.score).toBeLessThanOrEqual(30);
  });

  it("no debt scores the debt dimension at the top", async () => {
    const h = await computeBudgetHealth(HH, TEST_USER); // no debts seeded
    expect(h.facts.totalDebt).toBe(0);
    expect(h.dimensions.find((d) => d.key === "debt")!.score).toBe(100);
  });
});

describe("daily snapshot + trend + deltas", () => {
  it("upserts today once per day and builds the trend", async () => {
    await upsertTodayHealth(HH, TEST_USER);
    await upsertTodayHealth(HH, TEST_USER); // idempotent — still one row today

    const rows = await db
      .select()
      .from(budgetHealthHistoryTable)
      .where(
        and(
          eq(budgetHealthHistoryTable.householdId, HH),
          eq(budgetHealthHistoryTable.recordedOn, new Date().toISOString().slice(0, 10)),
        ),
      );
    expect(rows).toHaveLength(1);

    const trend = await getHealthTrend(HH, 30);
    expect(trend.length).toBe(1);
    expect(trend[0].score).toBe(rows[0].score);
  });

  it("computes vs-yesterday / vs-last-week deltas and direction", async () => {
    // Seed history: 7 days ago = 40, yesterday = 50.
    await db.insert(budgetHealthHistoryTable).values([
      { userId: TEST_USER, householdId: HH, recordedOn: isoDaysAgo(7), score: 40, status: "red", grade: "F" },
      { userId: TEST_USER, householdId: HH, recordedOn: isoDaysAgo(1), score: 50, status: "yellow", grade: "F" },
    ]);
    // Today = 60 (via upsert with a forced value through the history read path).
    await db.insert(budgetHealthHistoryTable).values({
      userId: TEST_USER,
      householdId: HH,
      recordedOn: new Date().toISOString().slice(0, 10),
      score: 60,
      status: "yellow",
      grade: "D",
    });

    const trend = await getHealthTrend(HH, 30);
    const deltas = computeDeltas(60, trend);
    expect(deltas.vsYesterday).toBe(10); // 60 - 50
    expect(deltas.vsLastWeek).toBe(20); // 60 - 40
    expect(deltas.direction).toBe("improving");
  });

  it("computeDeltas reports 'new' when there is no prior history", () => {
    const todayOnly: HealthTrendPoint[] = [
      { recordedOn: new Date().toISOString().slice(0, 10), score: 55, status: "yellow", grade: "F" },
    ];
    const deltas = computeDeltas(55, todayOnly);
    expect(deltas.vsYesterday).toBeNull();
    expect(deltas.vsLastWeek).toBeNull();
    expect(deltas.direction).toBe("new");
  });
});
