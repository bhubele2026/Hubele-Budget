import { describe, expect, it } from "vitest";
import {
  canSupersede,
  descriptionsFuzzyEqual,
  pairPendingWithPosted,
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
});

describe("pairPendingWithPosted", () => {
  it("pairs one to one: two pendings and one posted row pair once, with the nearest date", () => {
    const pairs = pairPendingWithPosted([
      pending("p-far", "2026-05-01", -20),
      pending("p-near", "2026-05-03", -20),
      posted("q", "2026-05-04", -20),
    ]);
    expect([...pairs.entries()].map(([q, p]) => [q, p.id])).toEqual([["q", "p-near"]]);
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
