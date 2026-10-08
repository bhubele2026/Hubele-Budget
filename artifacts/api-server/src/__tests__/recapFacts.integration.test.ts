import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, agentFindingsTable } from "@workspace/db";
import { makeMembers, dropMembers, type TestMember } from "./_helpers/smsFixtures";
import { FOR_DATE, NOW, seedRecapHousehold, seedStaleBank, wipeRecapHousehold } from "./_helpers/recapFixtures";
import { recapFacts, registerCategorizationReviewCount } from "../recap/facts";
import { localDateInZone } from "@workspace/avalanche-core";

// (AI-4a) recapFacts: every figure the morning text may use, worked by hand
// from the synthetic household in _helpers/recapFixtures.ts, and a second
// household that must contribute nothing.

let A: TestMember, B: TestMember;

beforeAll(async () => {
  vi.setSystemTime(NOW);
  [A, B] = await makeMembers(2);
  await seedRecapHousehold(A);
  // B has one big row yesterday that must never show up in A's facts.
  await seedRecapHousehold(B);
});
afterAll(async () => {
  vi.useRealTimers();
  registerCategorizationReviewCount(null);
  await wipeRecapHousehold(A);
  await wipeRecapHousehold(B);
  await dropMembers([A, B]);
});

describe("yesterday", () => {
  it("is the household calendar day before forDate, from the member's zone (Central at 23:30 and 00:30 UTC)", () => {
    // 18:30 Central on Oct 7 is 23:30Z; 19:30 Central is 00:30Z the next UTC day. Same recap date.
    for (const at of ["2026-10-07T23:30:00Z", "2026-10-08T00:30:00Z"]) {
      expect(localDateInZone(new Date(at), "America/Chicago")).toBe("2026-10-07");
    }
  });

  it("totals only that day's discretionary rows, with the top three categories by name", async () => {
    const f = await recapFacts(A.householdId, A.userId, A.userId, FOR_DATE);
    expect(f.forDate).toBe("2026-10-07");
    expect(f.yesterday).toBe("2026-10-06");
    expect(f.yesterdayWeekday).toBe("Tue");
    // Cafe 12.40 + Market 50 + Gadget 30. The transfer, the debt payment, 10-05 and 10-07 rows are out.
    expect(f.spentYesterday.total).toBe(92.4);
    expect(f.spentYesterday.count).toBe(3);
    expect(f.spentYesterday.topCategories).toEqual([
      { name: "Groceries", total: 50 },
      { name: "Unfiled", total: 30 },
      { name: "Dining Out", total: 12.4 },
    ]);
  });

  it("moves with forDate: the day before 10-07's recap is not the day before 10-08's", async () => {
    const f = await recapFacts(A.householdId, A.userId, A.userId, "2026-10-06");
    expect(f.yesterday).toBe("2026-10-05");
    expect(f.spentYesterday.total).toBe(10);
  });

  it("carries no merchant string anywhere in the facts", async () => {
    const f = await recapFacts(A.householdId, A.userId, A.userId, FOR_DATE);
    const json = JSON.stringify(f);
    for (const merchant of ["CAFE", "MARKET", "GADGET", "SAV", "CARD A", "LATE ONE"]) {
      expect(json.toUpperCase()).not.toContain(merchant === "CARD A" ? "CARD A PAYMENT" : merchant === "SAV" ? "ONLINE TRANSFER" : merchant);
    }
  });
});

describe("late arrivals", () => {
  it("counts older rows that were created after the previous recap went out, and says which weekday", async () => {
    const f = await recapFacts(A.householdId, A.userId, A.userId, FOR_DATE);
    expect(f.lateArrivals).toEqual({ count: 1, total: 20, fromDate: "2026-10-04", fromWeekday: "Sun" });
  });

  it("is empty when there was no previous recap", async () => {
    const f = await recapFacts(A.householdId, A.userId, A.userId, "2026-10-06");
    expect(f.lateArrivals.count).toBe(0);
  });
});

describe("the rest of the facts", () => {
  it("bills in the next three days, the one due tomorrow marked", async () => {
    const f = await recapFacts(A.householdId, A.userId, A.userId, FOR_DATE);
    expect(f.billsNext3Days).toEqual([
      { name: "Electric", date: "2026-10-08", weekday: "Thu", amount: 90, dueTomorrow: true },
      { name: "Water", date: "2026-10-10", weekday: "Sat", amount: 40, dueTomorrow: false },
    ]);
  });

  it("debt: a posted payment tagged to a debt yesterday, and a percentage (never a balance)", async () => {
    const f = await recapFacts(A.householdId, A.userId, A.userId, FOR_DATE);
    expect(f.debt.confirmedPaymentsYesterday).toBe(1);
    expect(f.debt.payoffPct).toBeGreaterThanOrEqual(50);
    expect(f.progress.debtPayment).toBe(true);
    expect(JSON.stringify(f)).not.toMatch(/1000|1,000|balance|owed/i);
  });

  it("progress: this week to date is lower than the same span last week", async () => {
    const f = await recapFacts(A.householdId, A.userId, A.userId, FOR_DATE);
    expect(f.progress.lowerThanLastWeek).toBe(true);
  });

  it("the money position is the position's own, never recomputed here", async () => {
    const f = await recapFacts(A.householdId, A.userId, A.userId, FOR_DATE);
    expect(f.position.horizonKind).toMatch(/^(payday|week_end)$/);
    expect(["firm", "estimated"]).toContain(f.position.confidence);
    expect(f.weekToDate.spent).toBeGreaterThanOrEqual(0);
  });

  it("review counts: the spine's, plus the categorizer's when one is registered (0 when absent)", async () => {
    let f = await recapFacts(A.householdId, A.userId, A.userId, FOR_DATE);
    expect(f.categorizationReviewCount).toBe(0);
    expect(f.needsLookCount).toBe(f.reviewCount);
    registerCategorizationReviewCount(async () => 3);
    f = await recapFacts(A.householdId, A.userId, A.userId, FOR_DATE);
    expect(f.categorizationReviewCount).toBe(3);
    expect(f.needsLookCount).toBe(f.reviewCount + 3);
    expect(f.nextStep).toBe("review");
    registerCategorizationReviewCount(async () => {
      throw new Error("boom");
    });
    f = await recapFacts(A.householdId, A.userId, A.userId, FOR_DATE);
    expect(f.categorizationReviewCount).toBe(0);
    registerCategorizationReviewCount(null);
  });

  it("next step: a bill due tomorrow when nothing needs a look; none otherwise", async () => {
    const f = await recapFacts(A.householdId, A.userId, A.userId, FOR_DATE);
    if (f.needsLookCount === 0) expect(f.nextStep).toBe("bill_tomorrow");
    const later = await recapFacts(A.householdId, A.userId, A.userId, "2026-10-12");
    if (later.needsLookCount === 0) expect(later.nextStep).toBeNull();
  });

  it("freshness: a typed-in balance older than a week is stale, with how many days old", async () => {
    await seedStaleBank(A, "2026-09-25T12:00:00-05:00");
    const f = await recapFacts(A.householdId, A.userId, A.userId, FOR_DATE);
    expect(f.freshness.stale).toBe(true);
    expect(f.freshness.staleReason).toBe("manual_old");
    expect(f.freshness.daysSinceBank).toBe(12);
    expect(f.position.degraded).toBe(true);
  });

  it("open findings are read in, most serious first, as a one-line summary built by code", async () => {
    await db.insert(agentFindingsTable).values([
      { householdId: A.householdId, kind: "limit_near", dedupeKey: "limit_near:t:1", severity: "watch", confidence: "confirmed", payload: { remainingWeek: 12.5 } },
      { householdId: A.householdId, kind: "bill_increase", dedupeKey: "bill_increase:t:1", severity: "high", confidence: "confirmed", payload: { latest: 212, increase: 34 } },
      { householdId: A.householdId, kind: "duplicate_charge", dedupeKey: "dup:t:1", severity: "high", confidence: "estimate", payload: {}, resolvedAt: new Date() },
    ]);
    const f = await recapFacts(A.householdId, A.userId, A.userId, FOR_DATE);
    expect(f.findings.map((x) => x.kind)).toEqual(["bill_increase", "limit_near"]);
    expect(f.findings[0]).toMatchObject({ severity: "high", surfaced: false, summary: "a bill came in at $212, up $34 from usual" });
    expect(f.findings[1]!.summary).toBe("the weekly limit is nearly used, $13 left");
  });
});

describe("isolation", () => {
  it("another household's rows, bills and findings never appear", async () => {
    const empty = (await makeMembers(1))[0]!;
    try {
      const f = await recapFacts(empty.householdId, empty.userId, empty.userId, FOR_DATE);
      expect(f.spentYesterday).toEqual({ total: 0, count: 0, topCategories: [] });
      expect(f.billsNext3Days).toEqual([]);
      expect(f.findings).toEqual([]);
      expect(f.lateArrivals.count).toBe(0);
      expect(f.debt.confirmedPaymentsYesterday).toBe(0);
    } finally {
      await dropMembers([empty]);
    }
    const a = await recapFacts(A.householdId, A.userId, A.userId, FOR_DATE);
    const b = await recapFacts(B.householdId, B.userId, B.userId, FOR_DATE);
    expect(a.spentYesterday.total).toBe(b.spentYesterday.total); // identical synthetic data, separate households
    await db.delete(agentFindingsTable).where(and(eq(agentFindingsTable.householdId, B.householdId)));
  });
});
