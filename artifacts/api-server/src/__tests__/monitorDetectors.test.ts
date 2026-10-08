import { describe, it, expect } from "vitest";
import { runDetectors } from "../monitor/detectors";
import { detectBillIncrease, medianCents } from "../monitor/detectors/billIncrease";
import { detectCategoryAcceleration } from "../monitor/detectors/categoryAcceleration";
import { detectShortfall } from "../monitor/detectors/shortfall";
import { detectDuplicateCharge } from "../monitor/detectors/duplicateCharge";
import { detectLimitNear } from "../monitor/detectors/limitNear";
import { detectBankStale } from "../monitor/detectors/bankStale";
import { REFIRE_AFTER_MS, decideFinding } from "../monitor/store";
import type { BillPayment, RecentRow } from "../monitor/types";
import { calmFacts, calmPosition } from "./_helpers/monitorFacts";

// (AI-3) Every detector on synthetic fixtures: fires, and does not fire one
// step inside the boundary. Pure functions — no database, no clock.

const ITEM = "00000000-0000-4000-8000-00000000b111";
const pay = (date: string, amount: number, source: BillPayment["source"] = "matched", n = 0): BillPayment => ({
  date,
  amount,
  source,
  txnId: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`,
});
// 50, 50, 50 before the latest.
const history = (latest: BillPayment): BillPayment[] => [
  latest,
  pay("2026-09-08", 50, "matched", 1),
  pay("2026-08-08", 50, "matched", 2),
  pay("2026-07-08", 50, "matched", 3),
];
const billFacts = (payments: BillPayment[], over: Record<string, unknown> = {}) =>
  calmFacts({ bills: [{ itemId: ITEM, active: true, debtLinked: false, payments, ...over }] });

describe("bill_increase", () => {
  it("fires above 10% and above $5, confirmed when the latest is a matched row", () => {
    // 100 vs median 50: +100%, +$50.
    const [f] = detectBillIncrease(billFacts(history(pay("2026-10-08", 100))));
    expect(f).toMatchObject({ kind: "bill_increase", severity: "watch", confidence: "confirmed" });
    expect(f!.dedupeKey).toBe(`bill_increase:${ITEM}:10000`);
    expect(f!.payload).toMatchObject({ itemId: ITEM, latest: 100, median: 50, increase: 50, previousCount: 3 });
  });
  it("is an estimate when the latest is a tier-2 pair", () => {
    const [f] = detectBillIncrease(billFacts(history(pay("2026-10-08", 100, "paired", 9))));
    expect(f!.confidence).toBe("estimate");
  });
  it("10% boundary: exactly 1.10 x median does not fire, one cent more does ($5 floor met)", () => {
    const prev = [pay("2026-09-08", 100, "matched", 1), pay("2026-08-08", 100, "matched", 2), pay("2026-07-08", 100, "matched", 3)];
    expect(detectBillIncrease(billFacts([pay("2026-10-08", 110, "matched", 9), ...prev]))).toHaveLength(0);
    expect(detectBillIncrease(billFacts([pay("2026-10-08", 110.01, "matched", 9), ...prev]))).toHaveLength(1);
  });
  it("$5 boundary: exactly $5 more does not fire, $5.01 more does (10% met)", () => {
    const prev = [pay("2026-09-08", 20, "matched", 1), pay("2026-08-08", 20, "matched", 2), pay("2026-07-08", 20, "matched", 3)];
    expect(detectBillIncrease(billFacts([pay("2026-10-08", 25, "matched", 9), ...prev]))).toHaveLength(0);
    expect(detectBillIncrease(billFacts([pay("2026-10-08", 25.01, "matched", 9), ...prev]))).toHaveLength(1);
  });
  it("needs three previous amounts", () => {
    const two = [pay("2026-10-08", 100, "matched", 9), pay("2026-09-08", 50, "matched", 1), pay("2026-08-08", 50, "matched", 2)];
    expect(detectBillIncrease(billFacts(two))).toHaveLength(0);
  });
  it("uses the median, so one earlier spike does not hide an increase", () => {
    const prev = [pay("2026-09-08", 50, "matched", 1), pay("2026-08-08", 400, "matched", 2), pay("2026-07-08", 50, "matched", 3)];
    expect(detectBillIncrease(billFacts([pay("2026-10-08", 90, "matched", 9), ...prev]))).toHaveLength(1);
    expect(medianCents([100, 300])).toBe(200);
  });
  it("ignores inactive and debt-linked items", () => {
    expect(detectBillIncrease(billFacts(history(pay("2026-10-08", 100)), { active: false }))).toHaveLength(0);
    expect(detectBillIncrease(billFacts(history(pay("2026-10-08", 100)), { debtLinked: true }))).toHaveLength(0);
  });
});

describe("category_acceleration", () => {
  const cat = (spentMtd: number, over: Record<string, unknown> = {}) => ({
    categoryId: "00000000-0000-4000-8000-00000000c111",
    spentMtd,
    planned: 310,
    trailingMonthlyAvg: 280,
    isBillCategory: false,
    ...over,
  });
  // Day 7 of 31: pace = spent / 7 * 31. Planned 310 -> fires above 387.5 projected, i.e. spent > 87.5.
  it("fires when the projected month is more than 1.25 x the line", () => {
    const [f] = detectCategoryAcceleration(calmFacts({ categories: [cat(100)] }));
    expect(f).toMatchObject({ kind: "category_acceleration", severity: "watch", confidence: "estimate" });
    expect(f!.dedupeKey).toBe("category_acceleration:00000000-0000-4000-8000-00000000c111:2026-10");
    expect(f!.payload).toMatchObject({ spentMtd: 100, planned: 310, projected: 442.86, daysLeft: 24 });
  });
  it("boundary: pace exactly 1.25 x the line does not fire", () => {
    // spent 87.50 -> 87.5 / 7 * 31 = 387.5 = 1.25 * 310.
    expect(detectCategoryAcceleration(calmFacts({ categories: [cat(87.5)] }))).toHaveLength(0);
    expect(detectCategoryAcceleration(calmFacts({ categories: [cat(87.51)] }))).toHaveLength(1);
  });
  it("needs 10 days left: 9 does not fire, 10 does", () => {
    const month = (dayOfMonth: number) => ({ start: "2026-10-01", end: "2026-10-31", daysInMonth: 31, dayOfMonth, daysLeft: 31 - dayOfMonth });
    expect(detectCategoryAcceleration(calmFacts({ month: month(22), categories: [cat(400)] }))).toHaveLength(0);
    expect(detectCategoryAcceleration(calmFacts({ month: month(21), categories: [cat(400)] }))).toHaveLength(1);
  });
  it("skips bill categories, lines under $20 and categories with no spend", () => {
    expect(detectCategoryAcceleration(calmFacts({ categories: [cat(900, { isBillCategory: true })] }))).toHaveLength(0);
    expect(detectCategoryAcceleration(calmFacts({ categories: [cat(100, { planned: 19.99 })] }))).toHaveLength(0);
    expect(detectCategoryAcceleration(calmFacts({ categories: [cat(0)] }))).toHaveLength(0);
  });
});

describe("shortfall_before_income", () => {
  const short = (over = {}) =>
    calmPosition({ availableUntilPayday: "0.00", lowestUntilPayday: "120.00", cashBuffer: "500.00", ...over });
  it("fires high when nothing is available and the low point is under the buffer", () => {
    const [f] = detectShortfall(calmFacts({ position: short() }));
    expect(f).toMatchObject({ kind: "shortfall_before_income", severity: "high", confidence: "confirmed" });
    expect(f!.dedupeKey).toBe("shortfall_before_income:household:2026-10-09");
    expect(f!.payload).toMatchObject({ lowestUntilPayday: 120, cashBuffer: 500, shortBy: 380 });
  });
  it("is an estimate when the position is estimated or degraded", () => {
    expect(detectShortfall(calmFacts({ position: short({ confidence: "estimated" }) }))[0]!.confidence).toBe("estimate");
    expect(detectShortfall(calmFacts({ position: short({ degraded: true }) }))[0]!.confidence).toBe("estimate");
  });
  it("boundary: lowest equal to the buffer, or $0.01 available, does not fire", () => {
    expect(detectShortfall(calmFacts({ position: short({ lowestUntilPayday: "500.00" }) }))).toHaveLength(0);
    expect(detectShortfall(calmFacts({ position: short({ availableUntilPayday: "0.01" }) }))).toHaveLength(0);
  });
  it("never fires without a bank or a curve (null is not zero)", () => {
    expect(detectShortfall(calmFacts({ position: short({ availableUntilPayday: null, lowestUntilPayday: null }) }))).toHaveLength(0);
  });
});

describe("duplicate_charge", () => {
  const T0 = Date.parse("2026-10-06T15:00:00Z");
  const row = (id: string, hoursAfter: number, amount: number, signature = "sig-a"): RecentRow => ({
    id,
    date: "2026-10-06",
    whenMs: T0 + hoursAfter * 3600_000,
    amount,
    signature,
  });
  it("fires on the same signature and amount within 72 h", () => {
    const [f] = detectDuplicateCharge(calmFacts({ recentRows: [row("t1", 0, -42), row("t2", 30, -42)] }));
    expect(f).toMatchObject({ kind: "duplicate_charge", severity: "watch", confidence: "estimate" });
    expect(f!.dedupeKey).toBe("duplicate_charge:t1.t2:pair");
    expect(f!.payload).toMatchObject({ txnIds: ["t1", "t2"], amount: 42, hoursApart: 30 });
  });
  it("amount boundary: one cent apart fires, two cents does not", () => {
    expect(detectDuplicateCharge(calmFacts({ recentRows: [row("t1", 0, -42), row("t2", 1, -42.01)] }))).toHaveLength(1);
    expect(detectDuplicateCharge(calmFacts({ recentRows: [row("t1", 0, -42), row("t2", 1, -42.02)] }))).toHaveLength(0);
  });
  it("time boundary: exactly 72 h fires, a minute more does not", () => {
    expect(detectDuplicateCharge(calmFacts({ recentRows: [row("t1", 0, -42), row("t2", 72, -42)] }))).toHaveLength(1);
    expect(detectDuplicateCharge(calmFacts({ recentRows: [row("t1", 0, -42), row("t2", 72 + 1 / 60, -42)] }))).toHaveLength(0);
  });
  it("a refund of the same signature and amount clears the pair", () => {
    const rows = [row("t1", 0, -42), row("t2", 30, -42), row("t3", 40, 42)];
    expect(detectDuplicateCharge(calmFacts({ recentRows: rows }))).toHaveLength(0);
  });
  it("different merchants, empty signatures and sub-$5 amounts do not pair", () => {
    expect(detectDuplicateCharge(calmFacts({ recentRows: [row("t1", 0, -42), row("t2", 1, -42, "sig-b")] }))).toHaveLength(0);
    expect(detectDuplicateCharge(calmFacts({ recentRows: [row("t1", 0, -42, ""), row("t2", 1, -42, "")] }))).toHaveLength(0);
    expect(detectDuplicateCharge(calmFacts({ recentRows: [row("t1", 0, -4.99), row("t2", 1, -4.99)] }))).toHaveLength(0);
  });
  it("three identical rows read as two consecutive pairs, never a triple", () => {
    const rows = [row("t1", 0, -42), row("t2", 1, -42), row("t3", 2, -42)];
    expect(detectDuplicateCharge(calmFacts({ recentRows: rows })).map((f) => f.dedupeKey)).toEqual([
      "duplicate_charge:t1.t2:pair",
      "duplicate_charge:t2.t3:pair",
    ]);
  });
});

describe("limit_near", () => {
  const cap = (remainingWeek: string | null, weekCap: string | null = "200.00") =>
    calmFacts({ position: calmPosition({ weekCap, remainingWeek }) });
  it("fires info at or under 15% of the cap", () => {
    const [f] = detectLimitNear(cap("30.00"));
    expect(f).toMatchObject({ kind: "limit_near", severity: "info", confidence: "confirmed" });
    expect(f!.dedupeKey).toBe("limit_near:household:2026-10-04");
    expect(f!.payload).toMatchObject({ weekCap: 200, remainingWeek: 30 });
  });
  it("boundary: 15% fires, one cent over does not; exactly $0 left fires, over the cap does not", () => {
    expect(detectLimitNear(cap("30.00"))).toHaveLength(1);
    expect(detectLimitNear(cap("30.01"))).toHaveLength(0);
    expect(detectLimitNear(cap("0.00"))).toHaveLength(1);
    expect(detectLimitNear(cap("-0.01"))).toHaveLength(0);
  });
  it("no cap, no finding", () => {
    expect(detectLimitNear(cap(null, null))).toHaveLength(0);
  });
});

describe("bank_stale", () => {
  const stale = (quietHours: number | null, isStale = true) =>
    calmFacts({ freshness: { stale: isStale, staleReason: "old", quietHours } });
  it("fires watch when stale and quiet more than 72 h; one key per week", () => {
    const [f] = detectBankStale(stale(80));
    expect(f).toMatchObject({ kind: "bank_stale", severity: "watch", confidence: "confirmed" });
    expect(f!.dedupeKey).toBe("bank_stale:household:2026-10-04");
  });
  it("boundary: exactly 72 h does not fire, not stale does not fire, unknown quiet time does", () => {
    expect(detectBankStale(stale(72))).toHaveLength(0);
    expect(detectBankStale(stale(72.1))).toHaveLength(1);
    expect(detectBankStale(stale(200, false))).toHaveLength(0);
    expect(detectBankStale(stale(null))).toHaveLength(1);
  });
});

describe("runDetectors", () => {
  it("a calm household has no findings", () => {
    expect(runDetectors(calmFacts())).toEqual([]);
  });
  it("emits no goal_behind when the household has no goals", () => {
    const kinds = runDetectors(
      calmFacts({
        position: calmPosition({ availableUntilPayday: "0.00", lowestUntilPayday: "0.00", remainingWeek: "1.00" }),
        freshness: { stale: true, staleReason: "old", quietHours: 100 },
      }),
    ).map((f) => f.kind);
    expect(kinds.sort()).toEqual(["bank_stale", "limit_near", "shortfall_before_income"]);
  });
});

describe("decideFinding (dedupe + cooldown)", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  it("no row inserts; an unresolved row only bumps", () => {
    expect(decideFinding(undefined, { severity: "watch" }, now)).toBe("insert");
    expect(decideFinding({ severity: "watch", resolvedAt: null }, { severity: "high" }, now)).toBe("bump");
  });
  it("a resolved row stays quiet inside 7 days and re-fires after", () => {
    const resolvedAt = (ageMs: number) => new Date(now - ageMs);
    expect(decideFinding({ severity: "watch", resolvedAt: resolvedAt(REFIRE_AFTER_MS - 1) }, { severity: "watch" }, now)).toBe("skip");
    expect(decideFinding({ severity: "watch", resolvedAt: resolvedAt(REFIRE_AFTER_MS) }, { severity: "watch" }, now)).toBe("skip");
    expect(decideFinding({ severity: "watch", resolvedAt: resolvedAt(REFIRE_AFTER_MS + 1) }, { severity: "watch" }, now)).toBe("refire");
  });
  it("a resolved row re-fires at once when the severity rises, never when it falls or holds", () => {
    const resolvedAt = new Date(now - 1000);
    expect(decideFinding({ severity: "info", resolvedAt }, { severity: "watch" }, now)).toBe("refire");
    expect(decideFinding({ severity: "watch", resolvedAt }, { severity: "high" }, now)).toBe("refire");
    expect(decideFinding({ severity: "high", resolvedAt }, { severity: "watch" }, now)).toBe("skip");
  });
});
