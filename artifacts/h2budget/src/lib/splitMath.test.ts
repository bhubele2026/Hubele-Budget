import { describe, expect, it } from "vitest";
import { MAX_PARTS, chargeCents, formatCents, parseCents, signedAmount, splitState } from "./splitMath";

describe("split math, in whole cents", () => {
  it("parses plain amounts and refuses the rest", () => {
    expect(parseCents("12.5")).toBe(1250);
    expect(parseCents("0.07")).toBe(7);
    expect(parseCents("-18.40")).toBe(-1840);
    expect(parseCents("12")).toBe(1200);
    for (const bad of ["", "abc", "1.234", "1,000", ".5", "1.", "--1"]) expect(parseCents(bad), bad).toBeNull();
  });

  it("formats cents back to a fixed two places", () => {
    expect(formatCents(1250)).toBe("12.50");
    expect(formatCents(7)).toBe("0.07");
    expect(formatCents(-1840)).toBe("-18.40");
  });

  it("works in magnitudes and puts the charge's sign back", () => {
    expect(chargeCents("-18.40")).toBe(1840);
    expect(signedAmount("-18.40", 1000)).toBe("-10.00");
    expect(signedAmount("1200.00", 700)).toBe("7.00");
  });

  it("0.1 + 0.2 style sums do not drift: the remainder is exact", () => {
    const s = splitState(30, [
      { categoryId: "a", amount: "0.10" },
      { categoryId: "b", amount: "0.20" },
    ]);
    expect(s.remainingCents).toBe(0);
    expect(s.ready).toBe(true);
  });

  it("is ready only when balanced, 2+ parts, each positive and filed", () => {
    const parts = (a: string, b: string, cb = "b") => [
      { categoryId: "a", amount: a },
      { categoryId: cb, amount: b },
    ];
    expect(splitState(1840, parts("10.00", "8.40")).ready).toBe(true);
    expect(splitState(1840, parts("10.00", "8.00")).remainingCents).toBe(40);
    expect(splitState(1840, parts("10.00", "8.00")).ready).toBe(false);
    expect(splitState(1840, parts("10.00", "9.00")).remainingCents).toBe(-60);
    expect(splitState(1840, parts("18.40", "0")).ready).toBe(false); // second part empty
    expect(splitState(1840, parts("10.00", "8.40", "")).ready).toBe(false); // part unfiled
    expect(splitState(1840, [{ categoryId: "a", amount: "18.40" }]).ready).toBe(false); // one part
    expect(splitState(1840, parts("20.00", "-1.60")).ready).toBe(false); // a negative part
  });

  it("allows at most MAX_PARTS parts, and Σ parts = parent is the only way to be ready", () => {
    expect(MAX_PARTS).toBe(20);
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ categoryId: `c${i}`, amount: "1.00" }));
    expect(splitState(2000, many(20)).ready).toBe(true);
    expect(splitState(2100, many(21)).ready).toBe(false);
    expect(splitState(1999, many(20)).ready).toBe(false);
  });
});
