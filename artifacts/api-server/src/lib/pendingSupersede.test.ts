import { describe, expect, it } from "vitest";
import {
  canSupersede,
  descriptionsFuzzyEqual,
  pairPendingWithPosted,
  pairPendingWithPostedAmong,
  SUPERSEDE_MAX_DAYS,
  type SupersedeRow,
} from "@workspace/avalanche-core";

const at = (iso: string) => new Date(`${iso}T12:00:00Z`);
const pending = (id: string, occurredOn: string, amount: number, extra: Partial<SupersedeRow> = {}): SupersedeRow => ({
  id,
  plaidAccountId: "chase",
  pending: true,
  occurredOn,
  amount,
  description: "RESTAURANT 123",
  createdAt: at(occurredOn),
  ...extra,
});
const posted = (id: string, occurredOn: string, amount: number, extra: Partial<SupersedeRow> = {}): SupersedeRow => ({
  ...pending(id, occurredOn, amount, extra),
  pending: false,
  createdAt: extra.createdAt ?? at(occurredOn),
});

describe("canSupersede", () => {
  it("pairs a tip: pending −48.20 posting as −55.00 the next day", () => {
    expect(canSupersede(pending("p", "2026-05-01", -48.2), posted("q", "2026-05-02", -55))).toBe(true);
  });

  it("allows the same day (posted later) and up to seven days after", () => {
    expect(SUPERSEDE_MAX_DAYS).toBe(7);
    expect(
      canSupersede(pending("p", "2026-05-01", -20), posted("q", "2026-05-01", -20, { createdAt: new Date("2026-05-01T13:00:00Z") })),
    ).toBe(true);
    expect(canSupersede(pending("p", "2026-05-01", -20), posted("q", "2026-05-08", -20))).toBe(true);
    expect(canSupersede(pending("p", "2026-05-01", -20), posted("q", "2026-05-09", -20))).toBe(false);
  });

  it("never pairs a posted row dated before the pending row, or one that reached the ledger first", () => {
    expect(canSupersede(pending("p", "2026-05-03", -20), posted("q", "2026-05-02", -20))).toBe(false);
    expect(
      canSupersede(
        pending("p", "2026-05-01", -20, { createdAt: new Date("2026-05-02T12:00:00Z") }),
        posted("q", "2026-05-02", -20, { createdAt: new Date("2026-05-02T12:00:00Z") }),
      ),
    ).toBe(false);
  });

  it("holds the amount to |pending| ≤ |posted| ≤ 1.30 × |pending| + $1.00, same sign", () => {
    const p = pending("p", "2026-05-01", -40);
    expect(canSupersede(p, posted("q", "2026-05-02", -53))).toBe(true); // 40 × 1.30 + 1
    expect(canSupersede(p, posted("q", "2026-05-02", -53.01))).toBe(false);
    expect(canSupersede(p, posted("q", "2026-05-02", -39.99))).toBe(false);
    expect(canSupersede(p, posted("q", "2026-05-02", 40))).toBe(false);
    expect(canSupersede(pending("p", "2026-05-01", 500), posted("q", "2026-05-02", 500))).toBe(true);
  });

  it("needs the same account, a pending and a posted row, and fuzzy-equal descriptions", () => {
    const p = pending("p", "2026-05-01", -20);
    expect(canSupersede(p, posted("q", "2026-05-02", -20, { plaidAccountId: "savings" }))).toBe(false);
    expect(canSupersede({ ...p, plaidAccountId: null }, posted("q", "2026-05-02", -20, { plaidAccountId: null }))).toBe(false);
    expect(canSupersede(p, { ...posted("q", "2026-05-02", -20), pending: true })).toBe(false);
    expect(canSupersede(p, posted("q", "2026-05-02", -20, { description: "RESTAURANT" }))).toBe(true);
    expect(canSupersede(p, posted("q", "2026-05-02", -20, { description: "COFFEE SHOP" }))).toBe(false);
    expect(descriptionsFuzzyEqual("AFFIRM.COM PAYME Merchant: Affirm", "Affirm")).toBe(true);
  });

  it("(PR4c review) never pairs rows with no real description", () => {
    const p = pending("p", "2026-05-01", -20, { description: "(no description)" });
    expect(canSupersede(p, posted("q", "2026-05-02", -20, { description: "(no description)" }))).toBe(false);
    expect(canSupersede(pending("p", "2026-05-01", -20, { description: "" }), posted("q", "2026-05-02", -20, { description: "" }))).toBe(false);
  });
});

describe("pairPendingWithPosted", () => {
  it("pairs one to one: two equal pendings and one posted row pair once, with the OLDEST pending row (holds post oldest first)", () => {
    const pairs = pairPendingWithPosted([
      pending("p-old", "2026-05-01", -20),
      pending("p-new", "2026-05-03", -20),
      posted("q", "2026-05-04", -20),
    ]);
    expect([...pairs.entries()].map(([q, p]) => [q, p.id])).toEqual([["q", "p-old"]]);
  });

  it("(PR4c review) the closest amount beats the nearest date: an older −40 hold posting as −40 is not taken by a newer −30", () => {
    const pairs = pairPendingWithPosted([
      pending("p-40", "2026-05-01", -40),
      pending("p-30", "2026-05-02", -30),
      posted("q", "2026-05-03", -40),
    ]);
    expect(pairs.get("q")?.id).toBe("p-40");
  });

  it("one pending and two posted rows: the earlier posted row takes it", () => {
    const pairs = pairPendingWithPosted([
      pending("p", "2026-05-01", -20),
      posted("q2", "2026-05-03", -20),
      posted("q1", "2026-05-02", -20),
    ]);
    expect([...pairs.entries()].map(([q, p]) => [q, p.id])).toEqual([["q1", "p"]]);
  });

  it("on the same date, the closer amount wins", () => {
    const pairs = pairPendingWithPosted([
      pending("p-40", "2026-05-01", -40),
      pending("p-50", "2026-05-01", -50),
      posted("q", "2026-05-02", -52),
    ]);
    expect(pairs.get("q")?.id).toBe("p-50");
  });

  it("returns nothing when no posted row qualifies", () => {
    expect(pairPendingWithPosted([pending("p", "2026-05-01", -20), posted("q", "2026-05-02", -90)]).size).toBe(0);
  });
});

describe("pairPendingWithPostedAmong (PR7b review M1)", () => {
  // A dense in-memory ledger: look-alike merchants, repeated amounts, rows
  // that arrive out of order. Fixed seed.
  function ledger(): SupersedeRow[] {
    let seed = 4242;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const rows: SupersedeRow[] = [];
    for (let i = 0; i < 300; i += 1) {
      const d = new Date(Date.UTC(2026, 4, 1 + Math.floor(rand() * 30), 12, Math.floor(rand() * 2880)));
      const occurredOn = new Date(Date.UTC(2026, 4, 1 + Math.floor((d.getTime() - Date.UTC(2026, 4, 1)) / 86_400_000))).toISOString().slice(0, 10);
      rows.push({
        id: `r${i}`,
        plaidAccountId: pick(["chase", "amex"]),
        pending: rand() < 0.4,
        occurredOn,
        amount: -pick([5, 5.5, 6, 20, 22, 45, 47.4]),
        description: pick(["STARBUCKS", "STARBUCKS STORE 1234", "PANERA BREAD 601"]),
        createdAt: d,
      });
    }
    return rows;
  }

  it("with complete candidates (plus harmless extras, in any order) it returns exactly what pairPendingWithPosted returns", () => {
    const rows = ledger();
    const reference = pairPendingWithPosted(rows);
    expect(reference.size).toBeGreaterThan(10);
    const pendings = rows.filter((r) => r.pending);
    // Same-account pending rows, reversed: every qualifying one is present, most are extras.
    const got = pairPendingWithPostedAmong(rows, (q) =>
      pendings.filter((p) => p.plaidAccountId === q.plaidAccountId).reverse(),
    );
    expect([...got.entries()].map(([q, p]) => [q, p.id]).sort()).toEqual(
      [...reference.entries()].map(([q, p]) => [q, p.id]).sort(),
    );
  });

  it("only qualifying candidates also suffice; a missing one can change the answer (the precondition is real)", () => {
    const rows = ledger();
    const reference = pairPendingWithPosted(rows);
    const pendings = rows.filter((r) => r.pending);
    const exact = pairPendingWithPostedAmong(rows, (q) => pendings.filter((p) => canSupersede(p, q)));
    expect([...exact.values()].map((p) => p.id).sort()).toEqual([...reference.values()].map((p) => p.id).sort());

    const p0905 = pending("p0905", "2026-09-05", -45);
    const p0906 = pending("p0906", "2026-09-06", -45);
    const q0907 = posted("q0907", "2026-09-07", -47.4);
    const incomplete = pairPendingWithPostedAmong([p0905, p0906, q0907], () => [p0906]);
    expect(pairPendingWithPosted([p0905, p0906, q0907]).get("q0907")?.id).toBe("p0905");
    expect(incomplete.get("q0907")?.id).toBe("p0906");
  });
});
