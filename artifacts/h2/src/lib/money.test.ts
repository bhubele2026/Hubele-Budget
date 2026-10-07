import { describe, it, expect } from "vitest";
import { centsValue, fmtMoney, MISSING, toAmount, wholeDollars } from "./money";

describe("fmtMoney — whole dollars, half-up, never $0 for a missing amount", () => {
  it.each([
    [1234.5, "$1,235"],
    [1234.49, "$1,234"],
    [0.5, "$1"],
    [0.49, "$0"],
    [12345.67, "$12,346"],
    [-2.5, "-$3"],
    [-2.49, "-$2"],
    [1_000_000, "$1,000,000"],
  ])("%s → %s", (n, out) => {
    expect(fmtMoney(n)).toBe(out);
  });

  it("rounds through integer cents, so float noise never decides a dollar", () => {
    // 1234.50 as a float is 1234.4999999999998 or 1234.5000000000002 depending
    // on how it was reached; both are 123450 cents.
    expect(fmtMoney(0.1 + 0.2 + 1234.2)).toBe("$1,235");
    expect(wholeDollars(Number("1234.50"))).toBe(1235);
  });

  it("a missing amount is a dash, not $0", () => {
    expect(fmtMoney(null)).toBe(MISSING);
    expect(fmtMoney(undefined)).toBe(MISSING);
    expect(fmtMoney(Number.NaN)).toBe(MISSING);
    expect(fmtMoney(Number.POSITIVE_INFINITY)).toBe(MISSING);
  });

  it("a real zero is $0 — and never negative zero", () => {
    expect(fmtMoney(0)).toBe("$0");
    expect(fmtMoney(-0.2)).toBe("$0");
  });
});

describe("toAmount — API money strings to numbers", () => {
  it("parses the strings the API sends", () => {
    expect(toAmount("1234.56")).toBe(1234.56);
    expect(toAmount("-12.00")).toBe(-12);
    expect(toAmount(41.3)).toBe(41.3);
  });
  it("anything unreadable is null, never 0", () => {
    expect(toAmount(null)).toBeNull();
    expect(toAmount(undefined)).toBeNull();
    expect(toAmount("")).toBeNull();
    expect(toAmount("n/a")).toBeNull();
  });
});

describe("centsValue — the exact value a figure stands for", () => {
  it("is the amount to the cent", () => {
    expect(centsValue(12345.67)).toBe("12345.67");
    expect(centsValue(412.4)).toBe("412.40");
    expect(centsValue(-2.5)).toBe("-2.50");
  });
});
