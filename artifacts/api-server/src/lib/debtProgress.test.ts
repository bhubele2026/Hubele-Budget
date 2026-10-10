// (PR-D) Genuine progress, pure: the decomposition identity, transfer pairs,
// and the one card-sign rule.
import { describe, it, expect } from "vitest";
import {
  decomposeDelta,
  inPayoffPopulation,
  isTransferPair,
  normalizeCardAmount,
  pairTransfers,
  payoffBasisOf,
  payoffPct,
  type DebtEvent,
} from "@workspace/avalanche-core";

const sum = (x: ReturnType<typeof decomposeDelta>) =>
  Math.round(
    (x.paymentsConfirmed + x.interest + x.fees + x.newCharges + x.credits + x.unexplained) * 100,
  ) / 100;

describe("decomposeDelta", () => {
  it("splits a month on a card to the cent: paid 500, interest 61.22, a fee, new charges, a refund", () => {
    const x = decomposeDelta({
      balanceBefore: 4210.55,
      balanceAfter: 4011.0,
      events: [
        { kind: "payment", amount: 500 },
        { kind: "interest", amount: 61.22 },
        { kind: "fee", amount: 29 },
        { kind: "charge", amount: 245.18 },
        { kind: "credit", amount: 34.95 },
      ],
    });
    expect(x).toMatchObject({
      delta: -199.55,
      paymentsConfirmed: -500,
      interest: 61.22,
      fees: 29,
      newCharges: 245.18,
      credits: -34.95,
      unexplained: 0,
      genuinePayments: 500,
    });
  });

  it("always sums to the delta — whatever the events, the remainder is `unexplained`", () => {
    // Deterministic pseudo-random sweep (no Math.random: reproducible).
    let seed = 7;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    const kinds: DebtEvent["kind"][] = ["payment", "interest", "fee", "charge", "credit"];
    for (let i = 0; i < 300; i++) {
      const events: DebtEvent[] = Array.from({ length: Math.floor(rnd() * 6) }, () => ({
        kind: kinds[Math.floor(rnd() * 5)]!,
        amount: Math.round(rnd() * 100000) / 100,
        transferPair: rnd() < 0.2,
      }));
      const before = Math.round(rnd() * 1e6) / 100;
      const after = Math.round(rnd() * 1e6) / 100;
      const x = decomposeDelta({ balanceBefore: before, balanceAfter: after, events });
      expect(sum(x)).toBe(x.delta);
      expect(x.delta).toBe(Math.round((after - before) * 100) / 100);
      expect(x.paymentsConfirmed).toBeLessThanOrEqual(0);
      expect(x.credits).toBeLessThanOrEqual(0);
      expect(x.genuinePayments).toBeGreaterThanOrEqual(0);
    }
  });

  it("interest is never a payment: a month of interest alone is a rise, not progress", () => {
    const x = decomposeDelta({ balanceBefore: 1000, balanceAfter: 1018.74, events: [{ kind: "interest", amount: 18.74 }] });
    expect(x.paymentsConfirmed).toBe(0);
    expect(x.genuinePayments).toBe(0);
    expect(x.interest).toBe(18.74);
  });

  it("a payment with no event behind it (an unconfirmed claim) is `unexplained`, not confirmed", () => {
    const x = decomposeDelta({ balanceBefore: 900, balanceAfter: 700, events: [] });
    expect(x).toMatchObject({ delta: -200, paymentsConfirmed: 0, unexplained: -200 });
  });
});

describe("transfer pairs", () => {
  const pay = { id: "p", debtId: "visa", amount: 1500, occurredOn: "2026-09-10" };

  it("a payment to one debt within 5 days of the same draw on another is a pair", () => {
    expect(isTransferPair(pay, { id: "c", debtId: "heloc", amount: 1500, occurredOn: "2026-09-08" })).toBe(true);
    expect(isTransferPair(pay, { id: "c", debtId: "heloc", amount: 1514.99, occurredOn: "2026-09-15" })).toBe(true);
  });

  it("not a pair: same debt, 6 days apart, or more than 1% apart", () => {
    expect(isTransferPair(pay, { id: "c", debtId: "visa", amount: 1500, occurredOn: "2026-09-10" })).toBe(false);
    expect(isTransferPair(pay, { id: "c", debtId: "heloc", amount: 1500, occurredOn: "2026-09-16" })).toBe(false);
    expect(isTransferPair(pay, { id: "c", debtId: "heloc", amount: 1515.2, occurredOn: "2026-09-10" })).toBe(false);
  });

  it("nets to zero across the household: genuine progress from a pure transfer is 0", () => {
    const pairs = pairTransfers([pay], [{ id: "c", debtId: "heloc", amount: 1500, occurredOn: "2026-09-09" }]);
    expect(pairs.get("p")).toBe("c");
    const visa = decomposeDelta({
      balanceBefore: 5000,
      balanceAfter: 3500,
      events: [{ kind: "payment", amount: 1500, transferPair: true }],
    });
    const heloc = decomposeDelta({
      balanceBefore: 20000,
      balanceAfter: 21500,
      events: [{ kind: "charge", amount: 1500, transferPair: true }],
    });
    expect(visa.delta + heloc.delta).toBe(0);
    expect(visa.genuinePayments + heloc.genuinePayments).toBe(0);
    expect(visa.unexplained).toBe(0);
    expect(heloc.unexplained).toBe(0);
  });

  it("pairs one to one, closest first", () => {
    const pairs = pairTransfers(
      [pay],
      [
        { id: "far", debtId: "heloc", amount: 1500, occurredOn: "2026-09-14" },
        { id: "near", debtId: "heloc", amount: 1500, occurredOn: "2026-09-11" },
      ],
    );
    expect([...pairs]).toEqual([["p", "near"]]);
  });
});

describe("normalizeCardAmount — charge semantics, both conventions", () => {
  it("workbook `amex`: positive is already a charge", () => {
    expect(normalizeCardAmount("amex", 42.18)).toBe(42.18);
    expect(normalizeCardAmount("amex", "-100.00")).toBe(-100);
  });
  it("`plaid:*` (and the ledger's own convention): negative is a charge, flipped", () => {
    expect(normalizeCardAmount("plaid:amex", -42.18)).toBe(42.18);
    expect(normalizeCardAmount("plaid:chase", "250.00")).toBe(-250);
    expect(normalizeCardAmount("manual", -10)).toBe(10);
    expect(normalizeCardAmount(null, -10)).toBe(10);
  });
  it("a charge on each side sums to two charges, not zero", () => {
    expect(normalizeCardAmount("amex", 100) + normalizeCardAmount("plaid:amex", -100)).toBe(200);
  });
});

// ⭐ (WP4b) "% PAID" MEASURES EVERY ACTIVE DEBT — the debts "$X left" sums —
// each against the larger of its anchor and what it owes now (netted). History
// in the columns: `preWp4` (`status !== "paid_off"`, anchored: every archived
// debt counted, since nothing writes `paid_off`), `wp4` (active AND anchored: a
// card anchored at $0.00 was dropped), `after` (WP4b).
describe("payoffPct — the population and the basis (WP4b)", () => {
  type Row = { status?: string; balance: string; originalBalance?: string | null; pendingPaymentTotal?: string | null };
  const active = (balance: string, originalBalance: string | null, pendingPaymentTotal: string | null = null): Row => ({
    status: "active", balance, originalBalance, pendingPaymentTotal,
  });
  const owed = (r: Row) => Math.max(0, Number(r.balance) - Number(r.pendingPaymentTotal ?? 0));
  /** The earlier rules, kept here only to state what changed. */
  const anchoredPct = (rows: Row[], keep: (r: Row) => boolean): number | null => {
    let o = 0;
    let b = 0;
    for (const r of rows) {
      const orig = Number(r.originalBalance ?? 0) || 0;
      if (!keep(r) || orig <= 0) continue;
      o += orig;
      b += Math.min(owed(r), orig);
    }
    return o > 0 ? Math.max(0, Math.min(1, (o - b) / o)) * 100 : null;
  };
  const preWp4 = (rows: Row[]) => anchoredPct(rows, (r) => r.status !== "paid_off");
  const wp4 = (rows: Row[]) => anchoredPct(rows, (r) => (r.status ?? "active") === "active");

  const table: Array<{ name: string; rows: Row[]; preWp4: number | null; wp4: number | null; after: number | null }> = [
    { name: "one active debt, half paid", rows: [active("500.00", "1000.00")], preWp4: 50, wp4: 50, after: 50 },
    {
      name: "+ an ARCHIVED debt paid to $0 — out of both sides",
      rows: [active("500.00", "1000.00"), { status: "archived", balance: "0.00", originalBalance: "1000.00" }],
      preWp4: 75, wp4: 50, after: 50,
    },
    {
      name: "+ an archived debt with a balance left (taken off the plan) — out",
      rows: [active("500.00", "1000.00"), { status: "archived", balance: "400.00", originalBalance: "1000.00" }],
      preWp4: 55, wp4: 50, after: 50,
    },
    {
      name: "+ a paid_off debt — out",
      rows: [active("500.00", "1000.00"), { status: "paid_off", balance: "0.00", originalBalance: "900.00" }],
      preWp4: 50, wp4: 50, after: 50,
    },
    {
      name: "⭐ + an ACTIVE card anchored at $0.00 owing $684.12 — in, 0% paid of what it owes",
      rows: [active("500.00", "1000.00"), active("684.12", "0.00")],
      preWp4: 50, wp4: 50, after: 29.689095788898655,
    },
    {
      name: "+ an active debt with no anchor at all — in, 0% paid of what it owes",
      rows: [active("500.00", "1000.00"), active("300.00", null)],
      preWp4: 50, wp4: 50, after: 38.46153846153847,
    },
    {
      name: "+ an active debt owing nothing with no anchor — adds nothing",
      rows: [active("500.00", "1000.00"), active("0.00", null)],
      preWp4: 50, wp4: 50, after: 50,
    },
    { name: "a pending payment nets what is owed", rows: [active("600.00", "1000.00", "100.00")], preWp4: 50, wp4: 50, after: 50 },
    {
      name: "a debt above its anchor weighs what it owes now (0% paid of $1,200, not of $1,000)",
      rows: [active("500.00", "1000.00"), active("1200.00", "1000.00")],
      preWp4: 25, wp4: 25, after: 22.727272727272727,
    },
    {
      name: "only archived debts: nothing to show (null), never 0% or 100%",
      rows: [{ status: "archived", balance: "0.00", originalBalance: "1000.00" }],
      preWp4: 100, wp4: null, after: null,
    },
  ];
  const close = (got: number | null, want: number | null) =>
    want === null ? expect(got).toBeNull() : expect(got).toBeCloseTo(want, 6);

  it.each(table)("$name", ({ rows, preWp4: p0, wp4: p1, after }) => {
    close(payoffPct(rows), after);
    close(preWp4(rows), p0);
    close(wp4(rows), p1);
  });

  it("inPayoffPopulation: every active debt (a missing status reads as active), anchored or not", () => {
    expect(inPayoffPopulation({ status: "active" })).toBe(true);
    expect(inPayoffPopulation({})).toBe(true);
    expect(inPayoffPopulation({ status: "archived" })).toBe(false);
    expect(inPayoffPopulation({ status: "paid_off" })).toBe(false);
  });

  it("payoffBasisOf: the larger of the anchor and what is owed now (netted), never negative", () => {
    expect(payoffBasisOf({ balance: "500.00", originalBalance: "1000.00" })).toBe(1000);
    expect(payoffBasisOf({ balance: "684.12", originalBalance: "0.00" })).toBe(684.12);
    expect(payoffBasisOf({ balance: "1200.00", originalBalance: "1000.00", pendingPaymentTotal: "300.00" })).toBe(1000);
    expect(payoffBasisOf({ balance: "0.00", originalBalance: null })).toBe(0);
    expect(payoffBasisOf({ balance: "-20.00", originalBalance: "-5.00" })).toBe(0);
  });
});
