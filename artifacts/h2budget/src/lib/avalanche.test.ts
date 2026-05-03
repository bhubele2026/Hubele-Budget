import { describe, it, expect } from "vitest";
import {
  simulate,
  simulateMinimumsOnly,
  identifyUnderwater,
  type SimDebt,
} from "./avalanche";

// A few normal cards plus one "underwater" line whose interest exceeds
// its minimum payment.
const SOLVABLE: SimDebt[] = [
  { id: "amex", name: "Amex", apr: 0.2849, balance: 1000, minPayment: 50 },
  { id: "chase", name: "Chase", apr: 0.18, balance: 500, minPayment: 30 },
];

const UNDERWATER: SimDebt = {
  id: "mattress",
  name: "Mattress Firm",
  apr: 0.3499,
  balance: 5000,
  minPayment: 33,
};

describe("identifyUnderwater (always-on)", () => {
  it("returns an empty list when no debt is underwater", () => {
    expect(identifyUnderwater(SOLVABLE)).toEqual([]);
  });

  it("flags a debt whose monthly interest exceeds its minimum", () => {
    const u = identifyUnderwater([...SOLVABLE, UNDERWATER]);
    expect(u).toHaveLength(1);
    expect(u[0]!.id).toBe("mattress");
    expect(u[0]!.shortfallPerMonth).toBeGreaterThan(0);
  });

  it("ignores archived debts", () => {
    const u = identifyUnderwater([
      { ...UNDERWATER, status: "archived" },
    ]);
    expect(u).toEqual([]);
  });
});

describe("simulate — APR sanity & solvable subset", () => {
  it("treats APR as a decimal: 0.2849 ≈ 24.99%/yr, not 2,849%/yr", () => {
    // A small balance with a normal APR & sensible min should pay off in
    // well under MAX_MONTHS. If APR were misread as 2849%, ranOutOfTime
    // would be true and monthsToFreedom would be Infinity.
    const r = simulate({
      debts: [SOLVABLE[0]!],
      extraPerMonth: 0,
      strategy: "avalanche",
    });
    expect(r.ranOutOfTime).toBe(false);
    expect(Number.isFinite(r.monthsToFreedom)).toBe(true);
    expect(r.monthsToFreedom).toBeGreaterThan(0);
    expect(r.monthsToFreedom).toBeLessThan(120);
  });

  it("populates `underwater` even when the whole sim converges", () => {
    // Throw enough extra at the underwater debt that the *plan* finishes,
    // but the underwater status of the row itself is still true.
    const r = simulate({
      debts: [...SOLVABLE, UNDERWATER],
      extraPerMonth: 2000,
      strategy: "avalanche",
    });
    expect(r.ranOutOfTime).toBe(false);
    expect(r.underwater.map((u) => u.id)).toContain("mattress");
  });

  it("reports the underwater list when the full sim runs out of time", () => {
    const r = simulate({
      debts: [...SOLVABLE, UNDERWATER],
      extraPerMonth: 0,
      strategy: "avalanche",
    });
    expect(r.ranOutOfTime).toBe(true);
    expect(r.underwater).toHaveLength(1);
    expect(r.underwater[0]!.id).toBe("mattress");
  });

  it("simulating only the solvable subset returns finite numbers", () => {
    // Mirrors what the page does: when the full sim ranOutOfTime due to
    // an underwater debt, drop it and re-simulate so the rest of the
    // plan still produces a real payoff date.
    const all = [...SOLVABLE, UNDERWATER];
    const full = simulate({
      debts: all,
      extraPerMonth: 0,
      strategy: "avalanche",
    });
    expect(full.ranOutOfTime).toBe(true);
    const underwaterIds = new Set(full.underwater.map((u) => u.id));
    const solvableOnly = all.filter((d) => !underwaterIds.has(d.id));
    const fallback = simulate({
      debts: solvableOnly,
      extraPerMonth: 0,
      strategy: "avalanche",
    });
    expect(fallback.ranOutOfTime).toBe(false);
    expect(Number.isFinite(fallback.monthsToFreedom)).toBe(true);
    expect(fallback.totalInterestPaid).toBeGreaterThan(0);
    expect(Number.isFinite(fallback.totalInterestPaid)).toBe(true);
  });
});

describe("simulateMinimumsOnly", () => {
  it("finishes a solvable set with finite months and interest, and never reallocates a freed minimum", () => {
    const sim = simulateMinimumsOnly({
      debts: SOLVABLE,
      strategy: "avalanche",
    });
    expect(sim.ranOutOfTime).toBe(false);
    expect(Number.isFinite(sim.monthsToFreedom)).toBe(true);
    expect(sim.monthsToFreedom).toBeGreaterThan(0);
    expect(Number.isFinite(sim.totalInterestPaid)).toBe(true);
    expect(sim.totalInterestPaid).toBeGreaterThan(0);
    // No cascade: after Chase dies, Amex still pays only its own $50 min.
    const chaseKill = sim.killedOrder.find((k) => k.id === "chase");
    expect(chaseKill).toBeDefined();
    const monthAfterChase = sim.months[chaseKill!.monthIndex];
    if (monthAfterChase) {
      const amexThatMonth = monthAfterChase.perDebt.find((p) => p.id === "amex");
      expect(amexThatMonth?.minPaid).toBeCloseTo(50, 2);
      expect(amexThatMonth?.extraPaid).toBe(0);
    }
    expect(sim.months.every((m) => m.totalExtraPaid === 0)).toBe(true);
    expect(sim.months.every((m) => m.activeTargetId === null)).toBe(true);
  });

  it("runs out of time on an underwater debt (true minimums never finish)", () => {
    const sim = simulateMinimumsOnly({
      debts: [...SOLVABLE, UNDERWATER],
      strategy: "avalanche",
    });
    expect(sim.ranOutOfTime).toBe(true);
    expect(Number.isFinite(sim.monthsToFreedom)).toBe(false);
  });
});
