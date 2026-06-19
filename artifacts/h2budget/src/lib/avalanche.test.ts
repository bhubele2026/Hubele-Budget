import { describe, it, expect } from "vitest";
import {
  simulate,
  simulateMinimumsOnly,
  identifyUnderwater,
  round2,
  targetIndex,
  CENTS,
  MAX_MONTHS,
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

describe("simulate — per-month targets list", () => {
  it("with $0 extra, month 1's targets list is empty (and activeTargetId is null)", () => {
    // After the first debt dies, its freed minimum cascades into the next
    // debt as "extra" — so later months legitimately do have a target.
    // We only assert the no-cascade case here for the no-extra baseline.
    const r = simulate({
      debts: SOLVABLE,
      extraPerMonth: 0,
      strategy: "avalanche",
    });
    expect(r.months.length).toBeGreaterThan(0);
    expect(r.months[0]!.targets).toEqual([]);
    expect(r.months[0]!.activeTargetId).toBeNull();
  });

  it("records a single target when extra only covers one debt", () => {
    // $50/mo extra is enough to focus on Amex but nowhere near killing it
    // in month 1.
    const r = simulate({
      debts: SOLVABLE,
      extraPerMonth: 50,
      strategy: "avalanche",
    });
    const m0 = r.months[0]!;
    expect(m0.targets).toHaveLength(1);
    expect(m0.targets[0]!.id).toBe("amex");
    expect(m0.targets[0]!.extraPaid).toBeCloseTo(50, 2);
    expect(m0.targets[0]!.killedThisMonth).toBe(false);
    // Back-compat fields still match the first target.
    expect(m0.activeTargetId).toBe("amex");
    expect(m0.activeTargetName).toBe("Amex");
  });

  it("records every debt that received extra (in kill order) when one month wipes out 2+ debts", () => {
    // $2000 extra should kill BOTH Amex (~$1k) and Chase (~$500) in
    // month 1 with plenty of pool to spare. Avalanche order ⇒ Amex
    // (highest APR) gets extra first, then the spillover finishes Chase.
    const r = simulate({
      debts: SOLVABLE,
      extraPerMonth: 2000,
      strategy: "avalanche",
    });
    const m0 = r.months[0]!;
    expect(m0.targets).toHaveLength(2);
    expect(m0.targets.map((t) => t.id)).toEqual(["amex", "chase"]);
    expect(m0.targets.every((t) => t.killedThisMonth)).toBe(true);
    // Amex: bal 1000 + 23.74 interest − 50 min = 973.74; gets first.
    // Spillover into Chase: bal 500 + 7.50 interest − 30 min = 477.50.
    expect(m0.targets[0]!.extraPaid).toBeCloseTo(973.74, 2);
    expect(m0.targets[1]!.extraPaid).toBeCloseTo(477.5, 2);
    // Sum of per-target extras should match the month's totalExtraPaid.
    const sumExtras = m0.targets.reduce((s, t) => s + t.extraPaid, 0);
    expect(sumExtras).toBeCloseTo(m0.totalExtraPaid, 2);
    // Both deaths are also in killedThisMonth.
    expect(m0.killedThisMonth.map((k) => k.id).sort()).toEqual(
      ["amex", "chase"].sort(),
    );
    // Back-compat: activeTargetId is still the FIRST target.
    expect(m0.activeTargetId).toBe("amex");
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

// ---------------------------------------------------------------------------
// Golden-master assertions for the engine now living in
// @workspace/avalanche-core (exercised here through the @/lib/avalanche shim).
// Expected values are HAND-DERIVED, not guessed — they lock the shared math
// so the client shim and the server reuse can never silently drift.
// ---------------------------------------------------------------------------

describe("avalanche-core shared primitives (via shim)", () => {
  it("re-exports the shared constants", () => {
    expect(CENTS).toBe(0.005);
    expect(MAX_MONTHS).toBe(600);
  });

  it("round2 rounds to two decimals like the sim does", () => {
    expect(round2(23.745)).toBe(23.75);
    expect(round2(7.499)).toBe(7.5);
    expect(round2(100)).toBe(100);
  });

  it("targetIndex applies the shared avalanche/snowball tie-break", () => {
    const rows = [
      { apr: 0.1, balance: 500 },
      { apr: 0.3, balance: 2000 },
    ];
    expect(targetIndex(rows, "avalanche")).toBe(1); // highest APR
    expect(targetIndex(rows, "snowball")).toBe(0); // smallest balance
    expect(targetIndex([{ apr: 0.2, balance: 0 }], "avalanche")).toBe(-1); // dead
  });
});

describe("simulate — hand-derived golden cases (via shim)", () => {
  it("single 0% debt whose min equals its balance pays off in exactly month 1", () => {
    // apr 0 => no interest; min(100, 100) = 100 paid => balance 0 in month 1.
    const debt: SimDebt = { id: "a", name: "A", apr: 0, balance: 100, minPayment: 100 };
    const r = simulate({ debts: [debt], extraPerMonth: 0, strategy: "avalanche" });
    expect(r.ranOutOfTime).toBe(false);
    expect(r.monthsToFreedom).toBe(1);
    expect(r.months).toHaveLength(1);
    expect(r.months[0]!.totalInterest).toBe(0);
    expect(r.months[0]!.totalMinsPaid).toBe(100);
    expect(r.months[0]!.totalBalanceEnd).toBe(0);
    expect(r.totalInterestPaid).toBe(0);
    expect(r.killedOrder.map((k) => k.id)).toEqual(["a"]);
  });

  it("a single underwater debt with no extra runs out of time (Infinity)", () => {
    // 5000 * 0.3499/12 ≈ 145.79 monthly interest >> $33 min => grows forever.
    const debt: SimDebt = {
      id: "uw", name: "Underwater", apr: 0.3499, balance: 5000, minPayment: 33,
    };
    const r = simulate({ debts: [debt], extraPerMonth: 0, strategy: "avalanche" });
    expect(r.ranOutOfTime).toBe(true);
    expect(r.monthsToFreedom).toBe(Infinity);
    expect(r.debtFreeDate).toBeNull();
  });

  it("a minPayment=0, 0% debt with no extra never converges (balance stuck)", () => {
    const debt: SimDebt = { id: "z", name: "Zero", apr: 0, balance: 1000, minPayment: 0 };
    const r = simulate({ debts: [debt], extraPerMonth: 0, strategy: "avalanche" });
    expect(r.ranOutOfTime).toBe(true);
    expect(r.monthsToFreedom).toBe(Infinity);
  });

  it("avalanche vs snowball pick different month-1 targets", () => {
    // A = high APR/high balance, B = low APR/low balance, mins = 0. $50 extra
    // dents but never kills either, so the first target is unambiguous.
    const A: SimDebt = { id: "A", name: "A", apr: 0.3, balance: 2000, minPayment: 0 };
    const B: SimDebt = { id: "B", name: "B", apr: 0.1, balance: 500, minPayment: 0 };
    const av = simulate({ debts: [A, B], extraPerMonth: 50, strategy: "avalanche" });
    const sb = simulate({ debts: [A, B], extraPerMonth: 50, strategy: "snowball" });
    expect(av.months[0]!.activeTargetId).toBe("A");
    expect(sb.months[0]!.activeTargetId).toBe("B");
  });
});
