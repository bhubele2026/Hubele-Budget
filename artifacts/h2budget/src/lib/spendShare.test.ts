import { describe, it, expect } from "vitest";
import { shareOf, formatShare, spendingShares, denominatorWords, spanLabel } from "./spendShare";

const CATS = [
  { name: "Alpha", total: 400 },
  { name: "Bravo", total: 300 },
  { name: "Charlie", total: 200 },
  { name: "Delta", total: 100 },
];

describe("shareOf / formatShare", () => {
  it("is a plain percent of the declared denominator", () => {
    expect(shareOf(25, 100)).toBe(25);
    expect(formatShare(shareOf(1, 3))).toBe("33%");
  });
  it("no denominator is a dash, never NaN and never 100%", () => {
    expect(shareOf(10, 0)).toBeNull();
    expect(shareOf(0, 0)).toBeNull();
    expect(shareOf(10, -5)).toBeNull();
    expect(formatShare(shareOf(10, 0))).toBe("—");
    expect(formatShare(NaN)).toBe("—");
  });
  it("a real zero amount is 0%, not a dash", () => {
    expect(formatShare(shareOf(0, 100))).toBe("0%");
  });
});

describe("spendingShares", () => {
  it("denominator = categorized + uncategorized; shares sum to 100 (within rounding)", () => {
    const s = spendingShares(CATS, { categorized: 1000, uncategorized: 250 });
    expect(s.denominator).toBe(1250);
    const sum = s.rows.reduce((t, r) => t + (r.pct ?? 0), 0);
    expect(sum).toBeCloseTo(100, 6);
    const rounded = s.rows.reduce((t, r) => t + Math.round(r.pct ?? 0), 0);
    expect(Math.abs(rounded - 100)).toBeLessThanOrEqual(s.rows.length / 2);
  });
  it("uncategorized is its own explicit last row, never folded into a category", () => {
    const s = spendingShares(CATS, { categorized: 1000, uncategorized: 250 });
    const last = s.rows[s.rows.length - 1];
    expect(last).toMatchObject({ name: "Uncategorized", kind: "uncategorized", amount: 250 });
    expect(formatShare(last.pct)).toBe("20%");
    expect(s.rows[0]).toMatchObject({ name: "Alpha", amount: 400 });
    expect(formatShare(s.rows[0].pct)).toBe("32%");
  });
  it("no uncategorized spend: no such row, and shares are of the categorized total", () => {
    const s = spendingShares(CATS, { categorized: 1000, uncategorized: 0 });
    expect(s.rows.some((r) => r.kind === "uncategorized")).toBe(false);
    expect(formatShare(s.rows[0].pct)).toBe("40%");
  });
  it("folds a tail into Other and keeps its share", () => {
    const s = spendingShares(CATS, { categorized: 1000, uncategorized: 0, topN: 2 });
    expect(s.rows.map((r) => r.name)).toEqual(["Alpha", "Bravo", "Other"]);
    expect(s.rows[2]).toMatchObject({ kind: "other", amount: 300 });
    expect(formatShare(s.rows[2].pct)).toBe("30%");
  });
  it("zero total: every share is a dash, no NaN and no 100%", () => {
    const s = spendingShares([], { categorized: 0, uncategorized: 0 });
    expect(s.rows).toEqual([]);
    const z = spendingShares([{ name: "Alpha", total: 0 }], { categorized: 0, uncategorized: 0 });
    expect(z.rows.map((r) => formatShare(r.pct))).toEqual(["—"]);
  });
  it("refunds: the categorized total is already net of category refunds, so a refunded category's share falls with it", () => {
    // Alpha bought 400, 100 refunded: the server hands 300 and a categorized total of 900 (not 1000).
    const net = spendingShares(
      [{ name: "Alpha", total: 300 }, ...CATS.slice(1)],
      { categorized: 900, uncategorized: 0 },
    );
    expect(net.denominator).toBe(900);
    expect(formatShare(net.rows.find((r) => r.name === "Alpha")!.pct)).toBe("33%");
    const sum = net.rows.reduce((t, r) => t + (r.pct ?? 0), 0);
    expect(sum).toBeCloseTo(100, 6);
  });
  it("cents are exact (no float drift in the denominator)", () => {
    const s = spendingShares([{ name: "Alpha", total: 0.1 }], { categorized: 0.1, uncategorized: 0.2 });
    expect(s.denominator).toBe(0.3);
  });
});

describe("words", () => {
  it("states the denominator in words", () => {
    expect(denominatorWords("$1,200.00", spanLabel("2026-09-16", "2026-10-16"))).toBe(
      "of $1,200.00 spent Sep 16 – Oct 16",
    );
    expect(denominatorWords("$5.00")).toBe("of $5.00 spent");
  });
});
