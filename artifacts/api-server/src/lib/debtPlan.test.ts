// (PR-D) The debt plan's pure maths: strategies, the debt-free range and the
// milestones — all readings of the one engine, `simulate`.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  compareStrategies,
  debtFreeRange,
  milestonesFor,
  planAssumptions,
  simulate,
  type PlanDebt,
  type SimDebt,
  type SimResult,
} from "@workspace/avalanche-core";

// ⚠️ PINNED FROM THE PARENT COMMIT (0352c748), before PR-D touched
// `simulate`: months, interest, kill order and a sha256 of the WHOLE result
// (every month, every per-debt row) for avalanche and snowball on three fixed
// synthetic portfolios. PR-D added an optional `newChargesPerMonth`; with it
// absent the engine must produce these byte for byte.
const PINS: Record<string, { months: number | null; interest: number; kills: string; digest: string }> = {
  "p1|0|avalanche": { months: 57, interest: 5559.63, kills: "b@47,c@55,a@57", digest: "0d40dcbdb53ca25a21c2b162f43bd1f3aec62326a0a153c78f0bc1f1540feaae" },
  "p1|0|snowball": { months: 57, interest: 5583.4, kills: "b@47,c@54,a@57", digest: "12dacd292c5c9eccfad686fab7250beff6aeb57003b4ee02d859e73d62ea9b94" },
  "p1|150|avalanche": { months: 35, interest: 2618.91, kills: "a@19,b@23,c@35", digest: "4eb6e13ceae2943baa8f5864c73e0d78920ecc8dd8e6734a4fe9e1b3190c0a51" },
  "p1|150|snowball": { months: 35, interest: 2769.67, kills: "b@9,a@23,c@35", digest: "563a5904e6239d5cc3bf73bc82ba8e46f9e152e410ef021cdb74fffd6d1a3e0d" },
  "p1|300|avalanche": { months: 26, interest: 1828.4, kills: "a@12,b@15,c@26", digest: "0b1c09ab9765fd9d1084519afaad4c6a3c352bb3502367aad8533061112e47df" },
  "p1|300|snowball": { months: 26, interest: 1924.84, kills: "b@5,a@15,c@26", digest: "c9bedc54724e5960a513dc3a0604020b71a3ed1a6a0a68cf9efd962901e57bdd" },
  "p1|1000|avalanche": { months: 12, interest: 818.62, kills: "a@4,b@6,c@12", digest: "cad6258ad5f2c15669faf78438ab2abacf24f09742582a7d7b9d73106f2f3a20" },
  "p1|1000|snowball": { months: 12, interest: 853.09, kills: "b@2,a@6,c@12", digest: "4f2e32e82ef5179f30b53fcddd9d2d8c426c850cc1efe3ed909f52d1a729bd21" },
  "p2|0|avalanche": { months: 45, interest: 1478.73, kills: "d3@14,d1@24,d2@41,d4@45", digest: "67b33fd20b54535ecb0af9c62cbb17bfd04022d228fd7ebe1d43b935343b21e5" },
  "p2|0|snowball": { months: 45, interest: 1478.73, kills: "d3@14,d1@24,d2@41,d4@45", digest: "67b33fd20b54535ecb0af9c62cbb17bfd04022d228fd7ebe1d43b935343b21e5" },
  "p2|75|avalanche": { months: 32, interest: 745.08, kills: "d1@8,d3@14,d2@22,d4@32", digest: "635804f523a380b967c9dc421eb026adc8250d56c53c16047e620a065e151e57" },
  "p2|75|snowball": { months: 32, interest: 753.37, kills: "d3@4,d1@9,d2@22,d4@32", digest: "0a3c4954a03a2213c0027be2aacd0d2c619389a7376a730a315cba26f6fccfdb" },
  "p2|150|avalanche": { months: 24, interest: 497.26, kills: "d1@4,d3@14,d2@15,d4@24", digest: "41979ca207422d7df134e75d5f8e71d91e624ea652db30db378b12e3ff6f8bc3" },
  "p2|150|snowball": { months: 25, interest: 513.11, kills: "d3@2,d1@6,d2@15,d4@25", digest: "d6a72ab889a4119086d1b3973bd4533f85e8d9dc056f7fd15701e76cc7c25c0a" },
  "p3|0|avalanche": { months: null, interest: 8503322772.14, kills: "v@41", digest: "3785da286b074a73b46667e12824615ce0175f689f9ba08ffe3c6e4f79fd284c" },
  "p3|0|snowball": { months: null, interest: 8503322772.14, kills: "v@41", digest: "3785da286b074a73b46667e12824615ce0175f689f9ba08ffe3c6e4f79fd284c" },
  "p3|200|avalanche": { months: 50, interest: 8139.29, kills: "v@41,u@50", digest: "5c6dbcb497d81c24afd3f20ae8aba4b40eec38675f605607fcca0d9393edebb1" },
  "p3|200|snowball": { months: 53, interest: 9470.71, kills: "v@9,u@53", digest: "9ed2dfe49ba9956e59847fe42188a4838ffb295fbcf0c526b801d3d971e7d288" },
  "p3|500|avalanche": { months: 22, interest: 3112.41, kills: "u@20,v@22", digest: "4a946d700dfbb7f95f9c2133229be4ecac7aa9cd51a75441472acee15d6a427a" },
  "p3|500|snowball": { months: 23, interest: 3670.78, kills: "v@4,u@23", digest: "4da3a2f376814017c79a02f57b3793cd3058716a6cba06159d34150fd9aa51a5" },
};

const P: Record<string, { debts: SimDebt[]; extras: number[] }> = {
  p1: { debts: [
    { id: "a", name: "Card A", apr: 0.2499, balance: 4200, minPayment: 120 },
    { id: "b", name: "Card B", apr: 0.1799, balance: 1500, minPayment: 45 },
    { id: "c", name: "Loan C", apr: 0.0699, balance: 9800, minPayment: 210 },
  ], extras: [0, 150, 300, 1000] },
  p2: { debts: [
    { id: "d1", name: "Card D1", apr: 0.2299, balance: 650, minPayment: 25 },
    { id: "d2", name: "Card D2", apr: 0.2299, balance: 2400, minPayment: 70 },
    { id: "d3", name: "Card D3", apr: 0.1599, balance: 300, minPayment: 25 },
    { id: "d4", name: "Loan D4", apr: 0, balance: 5000, minPayment: 100 },
  ], extras: [0, 75, 150] },
  p3: { debts: [
    { id: "u", name: "Under U", apr: 0.3, balance: 10000, minPayment: 150 },
    { id: "v", name: "Card V", apr: 0.12, balance: 2000, minPayment: 60 },
  ], extras: [0, 200, 500] },
};
const START = new Date(2026, 9, 1);
const pad = (n: number) => String(n).padStart(2, "0");
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function digest(r: SimResult): string {
  return createHash("sha256")
    .update(
      JSON.stringify(r, function (k, v) {
        const raw = (this as Record<string, unknown>)[k];
        return raw instanceof Date ? day(raw) : v === Infinity ? "Infinity" : v;
      }),
    )
    .digest("hex");
}

describe("simulate — byte-identical to the parent commit", () => {
  for (const [key, pin] of Object.entries(PINS)) {
    const [name, extra, strategy] = key.split("|") as [string, string, "avalanche" | "snowball"];
    it(`${key}`, () => {
      const opts = { debts: P[name]!.debts, extraPerMonth: Number(extra), strategy, startDate: START };
      const r = simulate(opts);
      expect(r.ranOutOfTime ? null : r.monthsToFreedom).toBe(pin.months);
      expect(r.totalInterestPaid).toBe(pin.interest);
      expect(r.killedOrder.map((k) => `${k.id}@${k.monthIndex}`).join(",")).toBe(pin.kills);
      expect(digest(r)).toBe(pin.digest);
      // An explicit zero is the same as absent.
      expect(digest(simulate({ ...opts, newChargesPerMonth: 0 }))).toBe(pin.digest);
    });
  }
});

describe("compareStrategies", () => {
  it("avalanche is exactly simulate(avalanche); snowball exactly simulate(snowball)", () => {
    for (const [name, p] of Object.entries(P)) {
      for (const extra of p.extras) {
        const c = compareStrategies(p.debts, extra, "2026-10");
        for (const strategy of ["avalanche", "snowball"] as const) {
          const pin = PINS[`${name}|${extra}|${strategy}`]!;
          const s = c[strategy];
          expect(s.monthsToFreedom).toBe(pin.months);
          expect(s.totalInterest).toBe(pin.months === null ? null : pin.interest);
          const first = pin.kills.split(",")[0]!.split("@")[0]!;
          expect(s.firstKill?.debtId).toBe(first);
        }
      }
    }
  });

  it("snowball pays the smallest balance first; avalanche the highest APR", () => {
    const c = compareStrategies(P.p1!.debts, 300, "2026-10");
    expect(c.avalanche.firstKill).toEqual({ debtId: "a", month: "2027-09" });
    expect(c.snowball.firstKill).toEqual({ debtId: "b", month: "2027-02" });
    // Avalanche saves interest here; the delta says by how much, snowball − avalanche.
    expect(c.delta.months).toBe(0);
    expect(c.delta.interest).toBe(96.44);
    expect(c.avalanche.debtFreeMonth).toBe("2028-11");
    expect(c.killMonths.find((k) => k.debtId === "b")).toEqual({ debtId: "b", avalanche: "2027-12", snowball: "2027-02" });
  });

  it("snowball ≠ avalanche whenever the orders differ (a mutant that aliases them fails here)", () => {
    const c = compareStrategies(P.p3!.debts, 200, "2026-10");
    expect(c.avalanche.monthsToFreedom).toBe(50);
    expect(c.snowball.monthsToFreedom).toBe(53);
    expect(c.delta).toEqual({ months: 3, interest: 1331.42 });
  });

  it("a plan that never finishes reports null, never Infinity or a fake date", () => {
    const c = compareStrategies(P.p3!.debts, 0, "2026-10");
    expect(c.avalanche).toMatchObject({ monthsToFreedom: null, debtFreeMonth: null, totalInterest: null });
    expect(c.delta).toEqual({ months: null, interest: null });
    expect(JSON.stringify(c)).not.toContain("Infinity");
  });
});

describe("debtFreeRange", () => {
  const debts = P.p1!.debts as PlanDebt[];

  it("is a range from three runs: base, half the extra, base + measured new charges", () => {
    const r = debtFreeRange(debts, 300, 100, { startISO: "2026-10" });
    expect(r.runs.map((x) => x.key)).toEqual(["base", "half_extra", "new_charges"]);
    expect(r.runs[0]!.debtFreeMonth).toBe("2028-11");
    expect(r.earliestMonth).toBe("2028-11");
    expect(r.latestMonth! > r.earliestMonth!).toBe(true);
    expect(r.interestLow).toBe(1828.4);
    expect(r.interestHigh!).toBeGreaterThan(r.interestLow!);
    // Never one exact date: months only.
    for (const m of [r.earliestMonth, r.latestMonth]) expect(m).toMatch(/^\d{4}-\d{2}$/);
  });

  it("is monotonic in the extra: more extra never makes either end later", () => {
    let prev: { earliest: string; latest: string } | null = null;
    for (const extra of [0, 50, 100, 150, 200, 300, 500, 800, 1200]) {
      const r = debtFreeRange(debts, extra, 75, { startISO: "2026-10" });
      expect(r.earliestMonth).not.toBeNull();
      expect(r.latestMonth).not.toBeNull();
      if (prev) {
        expect(r.earliestMonth! <= prev.earliest).toBe(true);
        expect(r.latestMonth! <= prev.latest).toBe(true);
      }
      prev = { earliest: r.earliestMonth!, latest: r.latestMonth! };
    }
  });

  it("new charges push the latest month out; charges the plan cannot outpay leave it open-ended", () => {
    const none = debtFreeRange(debts, 300, 0, { startISO: "2026-10" });
    const some = debtFreeRange(debts, 300, 200, { startISO: "2026-10" });
    expect(some.runs[2]!.debtFreeMonth! > none.runs[2]!.debtFreeMonth!).toBe(true);
    const swamped = debtFreeRange(debts, 300, 2000, { startISO: "2026-10" });
    expect(swamped.latestMonth).toBeNull();
    expect(swamped.interestHigh).toBeNull();
    expect(swamped.earliestMonth).toBe("2028-11");
  });

  it("always lists the four assumptions, with each minimum's source", () => {
    const withSources: PlanDebt[] = debts.map((d, i) => ({ ...d, minPaymentSource: i === 0 ? "plaid" : "manual" }));
    const r = debtFreeRange(withSources, 300, 42.5, { startISO: "2026-10" });
    expect(r.assumptions.map((a) => a.key)).toEqual([
      "interest_monthly",
      "payment_month_start",
      "minimums_as_stored",
      "new_charges_measured",
      "range_runs",
    ]);
    expect(r.assumptions[2]!.text).toContain("Card A $120.00 (plaid)");
    expect(r.assumptions[2]!.text).toContain("Loan C $210.00 (manual)");
    expect(r.assumptions[3]!.text).toContain("$42.50 a month");
    expect(planAssumptions(withSources, 0)[3]!.text).toBe("No new card charges were measured.");
  });
});

describe("milestonesFor", () => {
  const debts: PlanDebt[] = [
    { id: "a", name: "Card A", apr: 0.2499, balance: 4200, minPayment: 120, type: "credit_card", originalBalance: 5000 },
    { id: "b", name: "Card B", apr: 0.1799, balance: 1500, minPayment: 45, type: "credit_card", originalBalance: 1500 },
    { id: "c", name: "Loan C", apr: 0.0699, balance: 9800, minPayment: 210, type: "loan", originalBalance: 12000 },
  ];
  const sim = simulate({ debts, extraPerMonth: 300, strategy: "avalanche", startDate: START });

  it("lists each payoff, the first card at $0, and every 25% step not yet reached, in month order", () => {
    const m = milestonesFor(sim, debts);
    expect(m.map((x) => `${x.key}@${x.estimatedMonth}`)).toEqual([
      // 18,500 anchored, 15,500 owed at the start (16.2% paid): 25% is the
      // first step ahead. Same month → payoff, then first card, then the step.
      "pct_25@2027-01",
      "debt_zero:a@2027-09",
      "first_card_zero@2027-09",
      "pct_50@2027-09",
      "debt_zero:b@2027-12",
      "pct_75@2028-04",
      "debt_zero:c@2028-11",
      "pct_100@2028-11",
    ]);
  });

  it("measures % on payoffPct's basis (anchors), so steps already reached are not projected", () => {
    // Anchored: 18,500 original, 15,500 owed → 16.2% paid at the start, so
    // 25% is still ahead; with the start at 30% it is not.
    const m = milestonesFor(sim, debts);
    expect(m.some((x) => x.key === "pct_25")).toBe(true);
    // 28,500 original, 15,500 owed → 45.6% paid at the start: 25% is behind.
    const higher = debts.map((d) => (d.id === "c" ? { ...d, originalBalance: 22000 } : d));
    const m2 = milestonesFor(simulate({ debts: higher, extraPerMonth: 300, strategy: "avalanche", startDate: START }), higher);
    expect(m2.some((x) => x.key === "pct_25")).toBe(false);
  });

  it("first card is by type; a loan paid off first is not a card", () => {
    const loanFirst: PlanDebt[] = [
      { id: "l", name: "Small loan", apr: 0.3, balance: 200, minPayment: 50, type: "loan" },
      { id: "k", name: "Card K", apr: 0.2, balance: 3000, minPayment: 90, type: "credit_card" },
    ];
    const s = simulate({ debts: loanFirst, extraPerMonth: 100, strategy: "avalanche", startDate: START });
    const m = milestonesFor(s, loanFirst);
    expect(s.killedOrder[0]!.id).toBe("l");
    expect(m.find((x) => x.key === "first_card_zero")!.debtId).toBe("k");
  });

  it("(WP4) an ARCHIVED debt is out of the % basis, as in payoffPct: the steps are the plan's own", () => {
    // Paid off and archived: before WP4 its 4,000 anchor and $0 balance moved
    // the start from 16.2% to 31.1% paid, so "25% paid" vanished from the list.
    const archived: PlanDebt = { id: "z", name: "Old loan", apr: 0.09, balance: 0, minPayment: 0, status: "archived", originalBalance: 4000 };
    const withArchived = milestonesFor(sim, [...debts, archived]);
    expect(withArchived).toEqual(milestonesFor(sim, debts));
    expect(withArchived.some((x) => x.key === "pct_25")).toBe(true);
  });

  it("(WP4b) an active debt anchored at $0.00 is in the basis at what it owes, exactly as payoffPct reads it", () => {
    // Large enough that leaving it out would move the % steps.
    const zero: PlanDebt = { id: "z", name: "Card Z", apr: 0.2, balance: 6000, minPayment: 150, type: "credit_card", status: "active", originalBalance: 0 };
    const all = [...debts, zero];
    const s2 = simulate({ debts: all, extraPerMonth: 300, strategy: "avalanche", startDate: START });
    // max(anchor, owed) = 6,000: the same as anchoring it at its balance — never dropped.
    expect(milestonesFor(s2, all)).toEqual(milestonesFor(s2, all.map((d) => (d.id === "z" ? { ...d, originalBalance: 6000 } : d))));
    // And it is in the basis: leaving it out (WP4 dropped a $0.00 anchor) gives other steps.
    expect(milestonesFor(s2, all)).not.toEqual(milestonesFor(s2, all.map((d) => (d.id === "z" ? { ...d, status: "archived" } : d))));
  });

  it("without anchors the basis is the run's starting total", () => {
    const bare: PlanDebt[] = debts.map(({ originalBalance: _o, ...d }) => d);
    const m = milestonesFor(sim, bare);
    expect(m.find((x) => x.key === "pct_25")).toBeDefined();
  });
});
