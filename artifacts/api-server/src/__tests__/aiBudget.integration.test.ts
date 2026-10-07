import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { db, aiUsageTable, aiBudgetTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  assertBudget,
  getBudgetState,
  callsToday,
  startOfUtcMonth,
  startOfUtcDay,
  DEFAULT_DAILY_CAPS,
} from "../ai/budget";
import { recordUsage } from "../ai/usage";
import { createTestHousehold } from "./_helpers/testHousehold";

// (AI-0) Budget math: month-to-date by UTC calendar month, soft cap stops
// chat-class tasks, hard cap stops everything, daily call caps per task,
// blocked rows never count as calls.

const OWNER = `test-aib-${process.pid}-${randomUUID().slice(0, 8)}`;
let HH: string;

beforeAll(async () => {
  HH = (await createTestHousehold(OWNER)).householdId;
});
afterAll(async () => {
  await db.delete(aiUsageTable).where(eq(aiUsageTable.householdId, HH));
  await db.delete(aiBudgetTable).where(eq(aiBudgetTable.householdId, HH));
});
beforeEach(async () => {
  await db.delete(aiUsageTable).where(eq(aiUsageTable.householdId, HH));
  await db.delete(aiBudgetTable).where(eq(aiBudgetTable.householdId, HH));
});

const spend = (usd: number, at: string, task: "chat" | "categorize" | "recap" = "categorize", status: "ok" | "budget_exceeded" = "ok") =>
  recordUsage({ householdId: HH, task, model: "claude-opus-5-5", costUsd: usd, status, createdAt: new Date(at) });

async function verdict(task: "chat" | "categorize" | "recap" | "sms_question" | "receipt", now: string): Promise<string> {
  try {
    await assertBudget(HH, task, new Date(now));
    return "ok";
  } catch (err) {
    return (err as { kind?: string }).kind ?? "threw";
  }
}

describe("UTC periods", () => {
  it("month and day start at UTC midnight, whatever the server zone", () => {
    expect(startOfUtcMonth(new Date("2026-11-01T03:00:00-05:00")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    // 2026-10-31 22:30 in Chicago is already November 1st in UTC.
    expect(startOfUtcMonth(new Date("2026-10-31T22:30:00-05:00")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(startOfUtcDay(new Date("2026-10-07T23:59:59.999Z")).toISOString()).toBe("2026-10-07T00:00:00.000Z");
  });
});

describe("month-to-date and the month boundary", () => {
  it("spend from the last second of the previous UTC month does not count", async () => {
    await spend(30, "2026-09-30T23:59:59Z");
    await spend(1.5, "2026-10-01T00:00:00Z");
    await spend(2.25, "2026-10-15T12:00:00Z");
    const s = await getBudgetState(HH, new Date("2026-10-20T00:00:00Z"));
    expect(s.monthToDateUsd).toBeCloseTo(3.75, 6);
    expect(s.monthlyCapUsd).toBe(25);
    expect(s.hardCapUsd).toBe(40);
    // On the first instant of November, October's spend is gone.
    expect((await getBudgetState(HH, new Date("2026-11-01T00:00:00Z"))).monthToDateUsd).toBeCloseTo(0, 6);
  });

  it("$30 spent on Sep 30 blocks chat on Sep 30 but not on Oct 1 (UTC)", async () => {
    await spend(30, "2026-09-30T10:00:00Z");
    expect(await verdict("chat", "2026-09-30T23:00:00Z")).toBe("budget_exceeded");
    expect(await verdict("chat", "2026-10-01T00:00:01Z")).toBe("ok");
  });
});

describe("soft and hard caps", () => {
  it("the soft cap ($25) stops chat-class tasks only; the hard cap ($40) stops everything", async () => {
    await spend(25, "2026-10-02T00:00:00Z");
    const now = "2026-10-03T00:00:00Z";
    expect(await verdict("chat", now)).toBe("budget_exceeded");
    expect(await verdict("sms_question", now)).toBe("budget_exceeded");
    expect(await verdict("categorize", now)).toBe("ok");
    expect(await verdict("recap", now)).toBe("ok");
    await spend(15, "2026-10-02T01:00:00Z");
    expect(await verdict("categorize", now)).toBe("budget_exceeded");
    expect(await verdict("recap", now)).toBe("budget_exceeded");
  });

  it("per-household caps in ai_budget replace the defaults", async () => {
    await db.insert(aiBudgetTable).values({ householdId: HH, monthlyCapUsd: "5", hardCapUsd: "6" });
    await spend(5, "2026-10-02T00:00:00Z");
    expect(await verdict("chat", "2026-10-03T00:00:00Z")).toBe("budget_exceeded");
    expect(await verdict("categorize", "2026-10-03T00:00:00Z")).toBe("ok");
    await spend(1, "2026-10-02T00:00:01Z");
    expect(await verdict("categorize", "2026-10-03T00:00:00Z")).toBe("budget_exceeded");
  });

  it("paused_until is a per-household kill switch that ends on time", async () => {
    await db.insert(aiBudgetTable).values({ householdId: HH, pausedUntil: new Date("2026-10-05T00:00:00Z") });
    expect(await verdict("categorize", "2026-10-04T23:59:59Z")).toBe("budget_exceeded");
    expect(await verdict("categorize", "2026-10-05T00:00:01Z")).toBe("ok");
  });

  it("a household-less call is refused except for eval_judge", async () => {
    await expect(assertBudget(null, "chat")).rejects.toMatchObject({ kind: "budget_exceeded" });
    await expect(assertBudget(null, "eval_judge")).resolves.toBeUndefined();
  });
});

describe("daily call caps", () => {
  it("defaults are chat 40, categorize 20, recap 3, receipt 15, sms_question 10", () => {
    expect(DEFAULT_DAILY_CAPS).toEqual({ chat: 40, categorize: 20, recap: 3, receipt: 15, sms_question: 10 });
  });

  it("recap stops at its 3rd call of the UTC day; yesterday's and blocked calls do not count", async () => {
    await spend(0, "2026-10-06T23:59:59Z", "recap");
    await spend(0, "2026-10-07T00:00:00Z", "recap");
    await spend(0, "2026-10-07T08:00:00Z", "recap");
    await spend(0, "2026-10-07T08:01:00Z", "recap", "budget_exceeded");
    expect(await callsToday(HH, "recap", new Date("2026-10-07T12:00:00Z"))).toBe(2);
    expect(await verdict("recap", "2026-10-07T12:00:00Z")).toBe("ok");
    await spend(0, "2026-10-07T09:00:00Z", "recap");
    expect(await verdict("recap", "2026-10-07T12:00:00Z")).toBe("budget_exceeded");
    // Other tasks have their own count.
    expect(await verdict("categorize", "2026-10-07T12:00:00Z")).toBe("ok");
    // A new UTC day starts fresh.
    expect(await verdict("recap", "2026-10-08T00:00:00Z")).toBe("ok");
  });

  it("daily_caps in ai_budget override one task and keep the other defaults", async () => {
    await db.insert(aiBudgetTable).values({ householdId: HH, dailyCaps: { categorize: 1, recap: "nonsense" } });
    const s = await getBudgetState(HH, new Date("2026-10-07T12:00:00Z"));
    expect(s.dailyCaps.categorize).toBe(1);
    expect(s.dailyCaps.recap).toBe(3);
    await spend(0, "2026-10-07T01:00:00Z", "categorize");
    expect(await verdict("categorize", "2026-10-07T12:00:00Z")).toBe("budget_exceeded");
  });
});
